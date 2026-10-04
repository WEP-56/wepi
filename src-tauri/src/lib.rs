use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// One running `pi --mode rpc` process, keyed by WEPI session key.
struct RpcSlot {
    child: Child,
    stdin: ChildStdin,
}

struct RpcProcess {
    slots: Mutex<HashMap<String, RpcSlot>>,
    /// Set to true (with condvar) once the process emitted its first valid JSON
    /// line on stdout, proving the RPC endpoint is ready to accept commands.
    ready: Arc<(Mutex<bool>, Condvar)>,
}

impl RpcProcess {
    fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
            ready: Arc::new((Mutex::new(false), Condvar::new())),
        }
    }

    fn take(&self, key: &str) -> Option<RpcSlot> {
        self.slots.lock().ok()?.remove(key)
    }

    fn contains(&self, key: &str) -> bool {
        self.slots.lock().map(|m| m.contains_key(key)).unwrap_or(false)
    }

    fn with_stdin<R>(&self, key: &str, f: impl FnOnce(&mut ChildStdin) -> R) -> Result<R, String> {
        let mut guard = self.slots.lock().map_err(|_| "RPC 状态锁定失败".to_owned())?;
        let slot = guard.get_mut(key).ok_or("该会话的 Pi RPC 尚未启动")?;
        Ok(f(&mut slot.stdin))
    }

    fn wait_ready(&self, timeout: Duration) -> Result<(), String> {
        let (lock, cvar) = &*self.ready;
        let mut ready = lock.lock().map_err(|_| "RPC 状态锁定失败".to_owned())?;
        let deadline = Instant::now() + timeout;
        while !*ready {
            let now = Instant::now();
            if now >= deadline {
                return Err("等待 Pi RPC 就绪超时（进程未输出有效 JSON）".to_owned());
            }
            let (guard, _timeout) = cvar.wait_timeout(ready, deadline - now).map_err(|e| e.to_string())?;
            ready = guard;
        }
        Ok(())
    }
}

fn pi_agent_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".pi")
        .join("agent")
}

fn pi_sessions_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_SESSION_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    pi_agent_dir().join("sessions")
}

fn read_json_file(path: &Path) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

#[tauri::command]
fn pi_config_read() -> Result<Value, String> {
    let dir = pi_agent_dir();
    let count_entries = |child: &str| -> usize {
        fs::read_dir(dir.join(child))
            .map(|entries| entries.filter_map(Result::ok).count())
            .unwrap_or(0)
    };
    let list_entries = |child: &str| -> Vec<String> {
        fs::read_dir(dir.join(child))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default()
    };
    Ok(serde_json::json!({
        "agentDir": dir,
        "piPath": locate_pi("pi"),
        "cwd": std::env::current_dir().ok(),
        "models": read_json_file(&dir.join("models.json")),
        "auth": read_json_file(&dir.join("auth.json")),
        "settings": read_json_file(&dir.join("settings.json")),
        "mcp": read_json_file(&dir.join("mcp.json")),
        "skillsCount": count_entries("skills"),
        "extensionsCount": count_entries("extensions"),
        "skills": list_entries("skills"),
        "extensions": list_entries("extensions"),
    }))
}

#[tauri::command]
fn pi_config_write(file: String, content: Value) -> Result<(), String> {
    if !matches!(
        file.as_str(),
        "models.json" | "auth.json" | "settings.json" | "mcp.json"
    ) {
        return Err("不允许写入该 Pi 配置文件".to_owned());
    }
    let dir = pi_agent_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建 Pi 配置目录：{e}"))?;
    let path = dir.join(file);
    let raw = serde_json::to_string_pretty(&content).map_err(|e| e.to_string())?;
    fs::write(path, format!("{raw}\n")).map_err(|e| format!("无法写入 Pi 配置：{e}"))
}

/// Scan the Pi session store (~/.pi/agent/sessions) and return lightweight
/// metadata for every session file: path, cwd, timestamps, size, preview.
/// The frontend merges this with its own threads so WEPI and the Pi CLI share
/// one session list (Pi JSONL stays the source of truth).
#[tauri::command]
fn pi_sessions_scan() -> Result<Value, String> {
    let root = pi_sessions_dir();
    let mut sessions = Vec::new();
    let dirs = fs::read_dir(&root).map_err(|e| format!("无法读取 Pi sessions 目录：{e}"))?;
    for dir in dirs.filter_map(Result::ok) {
        let dir_path = dir.path();
        if !dir_path.is_dir() {
            continue;
        }
        let files = match fs::read_dir(&dir_path) {
            Ok(files) => files,
            Err(_) => continue,
        };
        for file in files.filter_map(Result::ok) {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let meta = match file.metadata() {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            // Read only the first line (session header) + scan for name/preview.
            let (header, name, preview, message_count) = match read_session_summary(&path) {
                Some(v) => v,
                None => continue,
            };
            if header.get("type").and_then(Value::as_str) != Some("session") {
                continue;
            }
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            sessions.push(serde_json::json!({
                "sessionPath": path.to_string_lossy(),
                "sessionId": header.get("id").cloned().unwrap_or(Value::Null),
                "cwd": header.get("cwd").cloned().unwrap_or(Value::Null),
                "createdAt": header.get("timestamp").cloned().unwrap_or(Value::Null),
                "modifiedAt": modified,
                "fileSize": meta.len(),
                "name": name,
                "preview": preview,
                "messageCount": message_count,
            }));
        }
    }
    sessions.sort_by(|a, b| {
        b.get("modifiedAt").and_then(Value::as_u64).cmp(&a.get("modifiedAt").and_then(Value::as_u64))
    });
    Ok(serde_json::json!({ "sessions": sessions }))
}

/// Read a session JSONL file and return (header, name, preview, message_count).
/// Only the first line is required; the rest is scanned cheaply line by line.
fn read_session_summary(path: &Path) -> Option<(Value, Option<String>, Option<String>, u64)> {
    use std::io::BufRead;
    let file = fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut header: Option<Value> = None;
    let mut name: Option<String> = None;
    let mut preview: Option<String> = None;
    let mut message_count: u64 = 0;
    for (index, line) in reader.lines().enumerate() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if index == 0 {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                header = Some(value);
            }
            continue;
        }
        // Cheap substring checks before full JSON parse.
        if line.contains("\"session_info\"") {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if value.get("type").and_then(Value::as_str) == Some("session_info") {
                    name = value.get("name").and_then(Value::as_str).map(str::to_owned);
                }
            }
            continue;
        }
        if line.contains("\"message\"") && line.contains("\"role\":\"user\"") {
            message_count += 1;
            if preview.is_none() {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    let message = value.get("message").cloned().unwrap_or(Value::Null);
                    preview = message_text_from(&message);
                }
            }
        }
    }
    Some((header?, name, preview, message_count))
}

fn message_text_from(message: &Value) -> Option<String> {
    match message.get("content")? {
        Value::String(text) => Some(text.clone()),
        Value::Array(content) => {
            let mut text = String::new();
            for block in content {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(value) = block.get("text").and_then(Value::as_str) {
                        text.push_str(value);
                    }
                }
            }
            Some(text)
        }
        _ => None,
    }
}

fn normalize_rpc_record(record: Value) -> Vec<Value> {
    let Some(kind) = record.get("type").and_then(Value::as_str) else {
        return vec![record];
    };
    if kind == "message_start" {
        let role = record
            .get("message")
            .and_then(|m| m.get("role"))
            .and_then(Value::as_str);
        return match role {
            Some("assistant") => vec![
                serde_json::json!({"type":"assistant_message_start", "message": record.get("message")}),
            ],
            Some("user") => vec![
                serde_json::json!({"type":"user_message_start", "message": record.get("message")}),
            ],
            _ => vec![record],
        };
    }
    if kind == "message_update" {
        let Some(event) = record.get("assistantMessageEvent") else {
            return vec![record];
        };
        let Some(event_type) = event.get("type").and_then(Value::as_str) else {
            return vec![record];
        };
        let mapped = match event_type {
            "text_delta" => event
                .get("delta")
                .and_then(Value::as_str)
                .map(|delta| serde_json::json!({"type":"assistant_text_delta","delta":delta})),
            "thinking_start" => Some(serde_json::json!({"type":"assistant_thinking_start"})),
            "thinking_delta" => event
                .get("delta")
                .and_then(Value::as_str)
                .map(|delta| serde_json::json!({"type":"assistant_thinking_delta","delta":delta})),
            "thinking_end" => Some(serde_json::json!({"type":"assistant_thinking_end"})),
            "toolcall_start" => Some(
                serde_json::json!({"type":"tool_execution_start", "toolCallId": event.get("toolCallId").or_else(|| event.get("id")), "toolName": event.get("toolName").or_else(|| event.get("name")), "args": event.get("arguments").or_else(|| event.get("args"))}),
            ),
            "toolcall_end" => Some(
                serde_json::json!({"type":"tool_execution_end", "toolCallId": event.get("toolCallId").or_else(|| event.get("id")), "toolName": event.get("toolName").or_else(|| event.get("name")), "result": event.get("result"), "isError": event.get("isError")}),
            ),
            _ => None,
        };
        return mapped.map_or_else(|| vec![record], |event| vec![event]);
    }
    if kind == "message_end"
        && record
            .get("message")
            .and_then(|m| m.get("role"))
            .and_then(Value::as_str)
            == Some("assistant")
    {
        let message = record.get("message").cloned().unwrap_or(Value::Null);
        return vec![serde_json::json!({
            "type": "assistant_message_end",
            "message": message,
            "stopReason": record.get("message").and_then(|m| m.get("stopReason")),
            "errorMessage": record.get("message").and_then(|m| m.get("errorMessage")),
        })];
    }
    if matches!(
        kind,
        "tool_execution_start" | "tool_execution_update" | "tool_execution_end"
    ) {
        return vec![record];
    }
    if kind == "response" {
        return vec![serde_json::json!({"type":"rpc_message","message":record})];
    }
    vec![record]
}

fn locate_pi(executable: &str) -> String {
    if executable.trim() != "pi" {
        return executable.trim().to_owned();
    }
    let mut candidates = Vec::<PathBuf>::new();
    if let Ok(path) = std::env::var("WEPI_PI_EXECUTABLE") {
        candidates.push(PathBuf::from(path));
    }
    if cfg!(windows) {
        if let Ok(home) = std::env::var("USERPROFILE") {
            let home = PathBuf::from(home);
            candidates.push(home.join(".pi/agent/bin/pi.cmd"));
            candidates.push(home.join(".pi/agent/bin/pi.exe"));
            candidates.push(home.join(".pi/agent/bin/pi"));
            candidates.push(home.join(".local/bin/pi.cmd"));
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(PathBuf::from(appdata).join("npm/pi.cmd"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            candidates.push(local.join("pnpm/pi.cmd"));
            candidates.push(local.join("Yarn/bin/pi.cmd"));
        }
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map_or_else(
            || executable.to_owned(),
            |path| path.to_string_lossy().into_owned(),
        )
}

fn locate_node() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("WEPI_NODE_EXECUTABLE") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(path) = std::env::var("ProgramFiles") {
        candidates.push(PathBuf::from(path).join("nodejs/node.exe"));
    }
    if let Ok(path) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(path).join("Programs/nodejs/node.exe"));
    }
    if let Ok(path) = std::env::var("APPDATA") {
        candidates.push(PathBuf::from(path).join("npm/node.exe"));
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// Build the `pi --mode rpc` command, handling Windows .cmd shims and the
/// managed pi-launcher.js installation.
fn build_pi_command(executable: &str, session_path: Option<&str>) -> Result<Command, String> {
    let program = locate_pi(executable);
    let managed_launcher = cfg!(windows)
        && program.to_ascii_lowercase().ends_with("pi.cmd")
        && Path::new(&program)
            .with_file_name("pi-launcher.js")
            .is_file();
    let mut args: Vec<String> = vec!["--mode".into(), "rpc".into()];
    if let Some(path) = session_path {
        args.push("--session".into());
        args.push(path.to_owned());
    }
    let command = if managed_launcher {
        let node = locate_node().ok_or("找不到 Node.js，无法运行 Pi managed 安装")?;
        let launcher = Path::new(&program).with_file_name("pi-launcher.js");
        let mut launcher_command = Command::new(node);
        launcher_command.arg(launcher.as_os_str()).args(&args);
        launcher_command
    } else if cfg!(windows) && !program.to_ascii_lowercase().ends_with(".exe") {
        let mut command = Command::new("cmd.exe");
        let program_arg = if program.contains('\\') || program.contains(' ') {
            format!("\"{program}\"")
        } else {
            program.clone()
        };
        let mut line = format!("/D /S /C {program_arg}");
        for arg in &args {
            line.push(' ');
            if arg.contains(' ') || arg.contains('\\') {
                line.push_str(&format!("\"{arg}\""));
            } else {
                line.push_str(arg);
            }
        }
        command.raw_arg(line);
        command
    } else {
        let mut command = Command::new(program);
        command.args(&args);
        command
    };
    Ok(command)
}

#[tauri::command]
fn pi_rpc_start(
    app: AppHandle,
    state: State<'_, RpcProcess>,
    session_key: String,
    executable: String,
    cwd: Option<String>,
    session_path: Option<String>,
) -> Result<(), String> {
    if state.contains(&session_key) {
        return Ok(());
    }
    let mut command = build_pi_command(
        if executable.trim().is_empty() { "pi" } else { executable.trim() },
        session_path.as_deref(),
    )?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd.as_deref().filter(|s| Path::new(s).is_dir()) {
        command.current_dir(dir);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 Pi RPC：{e}"))?;
    let stdin = child.stdin.take().ok_or("无法打开 Pi RPC stdin")?;
    let stdout = child.stdout.take().ok_or("无法打开 Pi RPC stdout")?;
    let stderr = child.stderr.take();

    let ready_flag = state.ready.clone();
    {
        let (lock, _) = &*ready_flag;
        if let Ok(mut ready) = lock.lock() {
            *ready = false;
        }
    }
    let key_for_exit = session_key.clone();
    let events = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) if !line.trim().is_empty() => {
                    if let Ok(mut ready) = ready_flag.0.lock() {
                        *ready = true;
                    }
                    ready_flag.1.notify_all();
                    if let Ok(mut value) = serde_json::from_str::<Value>(&line) {
                        // 给每条事件附加来源会话键，前端据此路由到正确的会话线程。
                        if let Some(obj) = value.as_object_mut() {
                            obj.insert("__sessionKey".into(), Value::String(key_for_exit.clone()));
                        }
                        for event in normalize_rpc_record(value) {
                            let _ = events.emit("pi-rpc-event", event);
                        }
                    } else {
                        let _ = events.emit("pi-rpc-error", format!("Pi 返回了无效 JSON：{line}"));
                    }
                }
                _ => break,
            }
        }
        let _ = events.emit("pi-rpc-exit", &key_for_exit);
        if let Some(state) = events.try_state::<RpcProcess>() {
            state.take(&key_for_exit);
        }
    });
    if let Some(stderr) = stderr {
        let diagnostics = app;
        std::thread::spawn(move || {
            let mut diagnostics_text = Vec::new();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    diagnostics_text.push(line.clone());
                    let _ = diagnostics.emit("pi-rpc-log", line);
                }
            }
            if !diagnostics_text.is_empty() {
                let _ = diagnostics
                    .emit("pi-rpc-error", diagnostics_text.join("\n"));
            }
        });
    }
    state.slots.lock().map_err(|_| "RPC 状态锁定失败".to_owned())?.insert(session_key, RpcSlot { child, stdin });
    Ok(())
}

/// Wait until the freshly started RPC process emitted its first JSON line.
/// Called by the frontend right after pi_rpc_start so configuration RPCs never
/// race the Node.js bootstrap of the pi CLI.
#[tauri::command]
fn pi_rpc_wait_ready(state: State<'_, RpcProcess>, timeout_ms: Option<u64>) -> Result<(), String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(20_000));
    state.wait_ready(timeout)
}

#[tauri::command]
fn pi_rpc_send(state: State<'_, RpcProcess>, session_key: String, record: Value) -> Result<(), String> {
    state.with_stdin(&session_key, |stdin| {
        let line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("发送 RPC 命令失败：{e}"))
    })?
}

#[tauri::command]
fn pi_rpc_stop(state: State<'_, RpcProcess>, session_key: String) -> Result<(), String> {
    if let Some(mut slot) = state.take(&session_key) {
        let _ = slot.stdin.flush();
        let _ = slot.child.kill();
    }
    Ok(())
}

#[tauri::command]
fn pi_rpc_stop_all(state: State<'_, RpcProcess>) -> Result<(), String> {
    if let Ok(mut slots) = state.slots.lock() {
        for (_, mut slot) in slots.drain() {
            let _ = slot.stdin.flush();
            let _ = slot.child.kill();
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RpcProcess::new())
        .invoke_handler(tauri::generate_handler![
            pi_rpc_start,
            pi_rpc_send,
            pi_rpc_stop,
            pi_rpc_stop_all,
            pi_rpc_wait_ready,
            pi_config_read,
            pi_config_write,
            pi_sessions_scan
        ])
        .run(tauri::generate_context!())
        .expect("error while running WEPI");
}
