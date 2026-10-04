use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};

struct RpcProcess(Mutex<Option<(Child, ChildStdin)>>);

fn pi_agent_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".pi")
        .join("agent")
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

#[tauri::command]
fn pi_rpc_start(
    app: AppHandle,
    state: State<'_, RpcProcess>,
    executable: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "RPC 状态锁定失败")?;
    if guard.is_some() {
        return Ok(());
    }
    let program = locate_pi(if executable.trim().is_empty() {
        "pi"
    } else {
        executable.trim()
    });
    let managed_launcher = cfg!(windows)
        && program.to_ascii_lowercase().ends_with("pi.cmd")
        && Path::new(&program)
            .with_file_name("pi-launcher.js")
            .is_file();
    let mut command = if managed_launcher {
        let node = locate_node().ok_or("找不到 Node.js，无法运行 Pi managed 安装")?;
        let launcher = Path::new(&program).with_file_name("pi-launcher.js");
        let mut command = Command::new(node);
        command.args([
            launcher.as_os_str(),
            std::ffi::OsStr::new("--mode"),
            std::ffi::OsStr::new("rpc"),
        ]);
        command
    } else if cfg!(windows) && !program.to_ascii_lowercase().ends_with(".exe") {
        let mut command = Command::new("cmd.exe");
        let command_line = if program.contains('\\') || program.contains(' ') {
            format!("\"{program}\" --mode rpc")
        } else {
            format!("{program} --mode rpc")
        };
        command.args(["/D", "/S", "/C", &command_line]);
        command
    } else {
        let mut command = Command::new(program);
        command.args(["--mode", "rpc"]);
        command
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd.filter(|s| Path::new(s).is_dir()) {
        command.current_dir(dir);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 Pi RPC：{e}"))?;
    let stdin = child.stdin.take().ok_or("无法打开 Pi RPC stdin")?;
    let stdout = child.stdout.take().ok_or("无法打开 Pi RPC stdout")?;
    let stderr = child.stderr.take();
    let events = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) if !line.trim().is_empty() => {
                    if let Ok(value) = serde_json::from_str::<Value>(&line) {
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
        let _ = events.emit("pi-rpc-exit", ());
        if let Some(state) = events.try_state::<RpcProcess>() {
            if let Ok(mut guard) = state.0.lock() {
                guard.take();
            }
        }
    });
    if let Some(stderr) = stderr {
        let diagnostics = app.clone();
        std::thread::spawn(move || {
            let mut diagnostics_text = Vec::new();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    diagnostics_text.push(line.clone());
                    let _ = diagnostics.emit("pi-rpc-log", line);
                }
            }
            if !diagnostics_text.is_empty() {
                let _ = diagnostics.emit("pi-rpc-error", diagnostics_text.join("\n"));
            }
        });
    }
    *guard = Some((child, stdin));
    Ok(())
}

#[tauri::command]
fn pi_rpc_send(state: State<'_, RpcProcess>, record: Value) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "RPC 状态锁定失败")?;
    let (_, stdin) = guard.as_mut().ok_or("Pi RPC 尚未启动")?;
    let line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("发送 RPC 命令失败：{e}"))
}

#[tauri::command]
fn pi_rpc_stop(state: State<'_, RpcProcess>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "RPC 状态锁定失败")?;
    if let Some((mut child, mut stdin)) = guard.take() {
        let _ = stdin.flush();
        let _ = child.kill();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RpcProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            pi_rpc_start,
            pi_rpc_send,
            pi_rpc_stop,
            pi_config_read,
            pi_config_write
        ])
        .run(tauri::generate_context!())
        .expect("error while running WEPI");
}
