use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Condvar, Mutex, OnceLock},
    time::Duration,
};
mod workspace;
mod pi_mcp;
mod pi_skills;
mod pi_ext;
mod pi_runtime;
mod app_update;
mod toml_lite;
mod wepi_settings;
mod wepi_security;
mod shell_open;
mod tray;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows：子进程不创建控制台窗口。
///
/// release 构建（windows subsystem，无控制台）下 spawn 任何控制台程序
/// （cmd.exe / node / .cmd 垫片）都会新开一个终端窗口——表现为桌面应用
/// 运行时弹出标题为 "pi" 的黑窗。`CREATE_NO_WINDOW` 让子进程保持无窗，
/// stdio 管道不受影响。
#[cfg(windows)]
pub fn no_window(command: &mut std::process::Command) {
    // CREATE_NO_WINDOW = 0x0800_0000
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

/// 单个会话的 RPC 进程。`ready` 是该进程独有的就绪标志——
/// 多个会话并行运行时，A 的输出不能把 B 标记为就绪。
struct RpcSlot {
    child: Child,
    stdin: ChildStdin,
    ready: Arc<(Mutex<bool>, Condvar)>,
    /// 握手通道：prepare 发出 get_state 后由读取线程回填响应。
    /// 取代「看到任意一行 JSON 就算就绪」的旧判定——那行可能只是
    /// Pi 的初始化通知，RPC 循环尚未开始消费 stdin。
    handshake: Arc<(Mutex<Option<HandshakeState>>, Condvar)>,
    /// 初始化期间捕获的 stderr（截断到 16KB），失败时并入错误信息。
    stderr_tail: Arc<Mutex<String>>,
}

#[derive(Clone)]
enum HandshakeState {
    Pending,
    /// get_state 响应（success 时 data 内含 sessionFile 等）。
    Done(Value),
    /// 进程退出 / 响应失败 / 解析失败。
    Failed(String),
}

struct RpcProcess {
    slots: Arc<Mutex<HashMap<String, RpcSlot>>>,
}

impl RpcProcess {
    fn new() -> Self {
        Self {
            slots: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

type Slots = Arc<Mutex<HashMap<String, RpcSlot>>>;
type ReadyFlag = Arc<(Mutex<bool>, Condvar)>;

fn take_slot(slots: &Slots, key: &str) -> Option<RpcSlot> {
    slots.lock().ok()?.remove(key)
}

fn slot_exists(slots: &Slots, key: &str) -> bool {
    slots.lock().map(|m| m.contains_key(key)).unwrap_or(false)
}

fn write_record(slots: &Slots, key: &str, record: &Value) -> Result<(), String> {
    let mut guard = slots.lock().map_err(|_| "RPC 状态锁定失败".to_owned())?;
    let slot = guard.get_mut(key).ok_or("该会话的 Pi RPC 尚未启动")?;
    let line = serde_json::to_string(record).map_err(|e| e.to_string())?;
    slot.stdin
        .write_all(line.as_bytes())
        .and_then(|_| slot.stdin.write_all(b"\n"))
        .and_then(|_| slot.stdin.flush())
        .map_err(|e| format!("发送 RPC 命令失败：{e}"))
}

/// 等待某个会话的 RPC 进程输出第一行 JSON。阻塞式等待，必须放在
/// spawn_blocking 里执行，否则会占住 Tauri 主线程造成界面卡死。
fn wait_ready_blocking(ready: &ReadyFlag, timeout: Duration) -> Result<(), String> {
    let (lock, cvar) = &**ready;
    let mut flag = lock.lock().map_err(|_| "RPC 状态锁定失败".to_owned())?;
    let deadline = std::time::Instant::now() + timeout;
    while !*flag {
        let now = std::time::Instant::now();
        if now >= deadline {
            return Err("等待 Pi RPC 就绪超时（进程未输出有效 JSON）".to_owned());
        }
        let (guard, _) = cvar
            .wait_timeout(flag, deadline - now)
            .map_err(|e| e.to_string())?;
        flag = guard;
    }
    Ok(())
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
async fn pi_config_write(file: String, content: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_provider_models_fetch(url: String, headers: HashMap<String, String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = url.trim();
        if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
            return Err("模型接口 URL 必须是 http(s)".to_owned());
        }
        let mut request = ureq::get(trimmed);
        for (key, value) in headers {
            request = request.set(&key, &value);
        }
        let response = request.call().map_err(|error| format!("模型接口请求失败：{error}"))?;
        response
            .into_json::<Value>()
            .map_err(|error| format!("模型接口返回的不是有效 JSON：{error}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ------------------------------------------------------------------ */
/*  附件：图片读取与临时落盘                                            */
/* ------------------------------------------------------------------ */

/// 按扩展名推断图片 MIME；未知类型回落到 octet-stream。
fn image_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        _ => "application/octet-stream",
    }
}

/// 读取本地图片并编码成 data URL：拖入 / 选择的图片用它渲染缩略图与原图，
/// 避免为了预览再引入资源协议与作用域配置。
#[tauri::command]
async fn read_image_data_url(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = PathBuf::from(path.trim());
        let meta = fs::metadata(&file).map_err(|error| format!("无法读取图片：{error}"))?;
        if !meta.is_file() {
            return Err("目标不是一个文件".to_owned());
        }
        const MAX_IMAGE_BYTES: u64 = 24 * 1024 * 1024;
        if meta.len() > MAX_IMAGE_BYTES {
            return Err("图片超过 24 MB，未生成预览".to_owned());
        }
        let bytes = fs::read(&file).map_err(|error| format!("无法读取图片：{error}"))?;
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(format!("data:{};base64,{encoded}", image_mime(&file)))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 把剪贴板粘贴的图片（data URL）落到临时目录并返回绝对路径。
/// 粘贴的图片没有磁盘来源，落盘后 Pi 才能按路径真正读到它。
#[tauri::command]
async fn save_temp_image(data_url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (header, payload) = data_url
            .split_once(',')
            .ok_or_else(|| "图片数据格式不正确".to_owned())?;
        if !header.starts_with("data:") {
            return Err("图片数据格式不正确".to_owned());
        }
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .map_err(|error| format!("图片数据解码失败：{error}"))?;
        let ext = if header.contains("jpeg") || header.contains("jpg") {
            "jpg"
        } else if header.contains("gif") {
            "gif"
        } else if header.contains("webp") {
            "webp"
        } else if header.contains("bmp") {
            "bmp"
        } else {
            "png"
        };
        let dir = std::env::temp_dir().join("wepi-attachments");
        fs::create_dir_all(&dir).map_err(|error| format!("无法创建临时目录：{error}"))?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let seq = TEMP_IMAGE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let target = dir.join(format!("paste-{stamp}-{seq}.{ext}"));
        fs::write(&target, bytes).map_err(|error| format!("无法写入临时图片：{error}"))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

static TEMP_IMAGE_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/* ------------------------------------------------------------------ */
/*  会话索引：扫描 ~/.pi/agent/sessions                                 */
/* ------------------------------------------------------------------ */

/// 会话摘要缓存：path -> (size, mtime_ms, summary)。每 15 秒轮询时
/// 未变化的文件直接复用，避免反复读取全部 JSONL。
fn scan_cache() -> &'static Mutex<HashMap<String, (u64, u64, Value)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u64, u64, Value)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn scan_sessions_blocking() -> Result<Value, String> {
    let root = pi_sessions_dir();
    let mut sessions = Vec::new();
    let mut cache = scan_cache().lock().map_err(|_| "扫描缓存锁定失败".to_owned())?;
    let mut seen: Vec<String> = Vec::new();
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
            let key = path.to_string_lossy().into_owned();
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            seen.push(key.clone());
            let summary = match cache.get(&key) {
                Some((size, cached_mtime, value)) if *size == meta.len() && *cached_mtime == mtime_ms => {
                    value.clone()
                }
                _ => {
                    let Some(value) = read_session_summary(&path, meta.len(), mtime_ms) else {
                        continue;
                    };
                    cache.insert(key.clone(), (meta.len(), mtime_ms, value.clone()));
                    value
                }
            };
            sessions.push(summary);
        }
    }
    cache.retain(|path, _| seen.contains(path));
    sessions.sort_by(|a, b| {
        b.get("modifiedAt")
            .and_then(Value::as_u64)
            .cmp(&a.get("modifiedAt").and_then(Value::as_u64))
    });
    Ok(serde_json::json!({ "sessions": sessions }))
}

#[tauri::command]
async fn pi_sessions_scan() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(scan_sessions_blocking)
        .await
        .map_err(|e| e.to_string())?
}

/// 读取会话文件的头部与会话级元数据。
/// 只解析首行 header，以及 `session_info`（会话名）与首条 user 消息（预览），
/// 其余行仅做廉价计数，避免大文件全量反序列化。
fn read_session_summary(path: &Path, size: u64, mtime_ms: u64) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut header: Option<Value> = None;
    let mut name: Option<String> = None;
    let mut preview: Option<String> = None;
    let mut user_messages: u64 = 0;
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
        if line.contains("\"session_info\"") {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if value.get("type").and_then(Value::as_str) == Some("session_info") {
                    name = value.get("name").and_then(Value::as_str).map(str::to_owned);
                }
            }
            continue;
        }
        if line.contains("\"role\":\"user\"") {
            user_messages += 1;
            if preview.is_none() {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    let message = value.get("message").cloned().unwrap_or(Value::Null);
                    preview = message_text_from(&message);
                }
            }
        }
    }
    let header = header?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    Some(serde_json::json!({
        "sessionPath": path.to_string_lossy(),
        "sessionId": header.get("id").cloned().unwrap_or(Value::Null),
        "cwd": header.get("cwd").cloned().unwrap_or(Value::Null),
        "createdAt": header.get("timestamp").cloned().unwrap_or(Value::Null),
        "modifiedAt": mtime_ms,
        "fileSize": size,
        "name": name,
        "preview": preview,
        "messageCount": user_messages,
    }))
}

/// 直接读取会话 JSONL 全文并返回原始条目，用于打开历史会话时渲染。
/// 相比启动 `pi --mode rpc --session` 再 `get_entries`，读文件几乎零成本，
/// 也不会为了「看一眼」而拉起一个 Node 进程。
#[tauri::command]
async fn pi_session_read(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        const MAX_ENTRIES: usize = 50_000;
        let file = fs::File::open(&path).map_err(|e| format!("无法打开会话文件：{e}"))?;
        let reader = BufReader::new(file);
        let mut entries = Vec::new();
        for line in reader.lines() {
            let line = line.map_err(|e| e.to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                entries.push(value);
            }
            if entries.len() >= MAX_ENTRIES {
                break;
            }
        }
        Ok(serde_json::json!({ "entries": entries }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 校验并解析待删除的会话文件路径。
/// 只接受 sessions 目录下的 .jsonl 文件，避免误删任意路径。
fn resolve_deletable_session(path: &str, root: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("无法定位 Pi sessions 目录：{e}"))?;
    let target = PathBuf::from(path);
    if target.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("只允许删除 .jsonl 会话文件".to_owned());
    }
    let canonical = fs::canonicalize(&target).map_err(|e| format!("无法定位会话文件：{e}"))?;
    if !canonical.starts_with(&root) {
        return Err("拒绝删除 Pi sessions 目录之外的文件".to_owned());
    }
    Ok(canonical)
}

/// 真正删除一个 Pi 会话文件。
///
/// 侧边栏的「永久删除」必须落到磁盘上，否则会话索引下一轮扫描会把它重新
/// 导入，用户看到的就是「删了又回来了」。
#[tauri::command]
async fn pi_session_delete(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = pi_sessions_dir();
        let canonical = resolve_deletable_session(&path, &root)?;
        fs::remove_file(&canonical).map_err(|e| format!("删除会话文件失败：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
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

/* ------------------------------------------------------------------ */
/*  RPC 事件归一化                                                      */
/* ------------------------------------------------------------------ */

/// 把归一化后的事件打上来源会话键。
///
/// 必须在 `normalize_rpc_record` **之后**调用：归一化会为文本/思考/工具事件
/// 新建 JSON 对象（如 `assistant_text_delta`），提前打标会在新建时丢掉键，
/// 前端按会话路由时就只能收到原样透传的事件（工具步骤），文本全部被丢弃。
fn stamp_session_key(event: &mut Value, session_key: &str) {
    if let Some(obj) = event.as_object_mut() {
        obj.insert("__sessionKey".into(), Value::String(session_key.to_owned()));
    }
}

fn normalized_events_with_key(record: Value, session_key: &str) -> Vec<Value> {
    normalize_rpc_record(record)
        .into_iter()
        .map(|mut event| {
            stamp_session_key(&mut event, session_key);
            event
        })
        .collect()
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
            "text_start" => Some(serde_json::json!({"type":"assistant_text_start"})),
            "text_end" => Some(serde_json::json!({"type":"assistant_text_end"})),
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
            | "turn_start" | "turn_end" | "agent_start" | "agent_end"
    ) {
        return vec![record];
    }
    if kind == "response" {
        return vec![serde_json::json!({"type":"rpc_message","message":record})];
    }
    vec![record]
}

/* ------------------------------------------------------------------ */
/*  Pi 可执行文件定位与进程启动                                          */
/* ------------------------------------------------------------------ */

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
        candidates.push(PathBuf::from(path).join("nodejs").join("node.exe"));
    }
    if let Ok(path) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(path).join("Programs").join("nodejs").join("node.exe"));
    }
    if let Ok(path) = std::env::var("APPDATA") {
        candidates.push(PathBuf::from(path).join("npm").join("node.exe"));
    }
    // PATH 兜底：测试进程与自定义安装环境下候选目录可能都不命中。
    if let Some(found) = which_on_path("node") {
        candidates.push(found);
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// 在 PATH 上查找可执行文件（含 Windows PATHEXT 扩展）。
fn which_on_path(executable: &str) -> Option<PathBuf> {
    let path_env = std::env::var("PATH").ok()?;
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned())
            .split(';')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in path_env.split(';').filter(|s| !s.is_empty()) {
        let direct = Path::new(dir).join(executable);
        if direct.is_file() {
            return Some(direct);
        }
        for ext in &extensions {
            let with_ext = Path::new(dir).join(format!("{executable}{ext}"));
            if with_ext.is_file() {
                return Some(with_ext);
            }
        }
    }
    None
}

/// WEPI 随包分发的内置 pi 扩展（spawn 时以 -e 注入，不污染 ~/.pi）。
/// 文件位于应用资源目录的 extensions/ 下（与源码树 src-tauri/extensions 同构）。
fn builtin_extension_paths() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    // 开发态：manifest 目录的 src-tauri/extensions。
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        roots.push(PathBuf::from(manifest_dir).join("extensions"));
    }
    // 运行态：可执行文件旁的 extensions/（打包时由 tauri.conf.json resources 复制）。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.join("extensions"));
        }
    }
    let mut paths = Vec::new();
    for name in ["wepi-security-gate.ts", "wepi-todo.ts"] {
        for root in &roots {
            let path = root.join(name);
            if path.is_file() {
                paths.push(path);
                break;
            }
        }
    }
    paths
}

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
    // 强制预装扩展：安全门 + todo。可重复 --extension <path> 注入，
    // 与用户自装扩展天然共存（pi 的发现顺序：项目 → 全局 → -e 显式）。
    for ext in builtin_extension_paths() {
        args.push("--extension".into());
        args.push(ext.to_string_lossy().into_owned());
    }
    let command = if managed_launcher {
        let node = locate_node().ok_or("找不到 Node.js，无法运行 Pi managed 安装")?;
        let launcher = Path::new(&program).with_file_name("pi-launcher.js");
        let mut launcher_command = Command::new(node);
        launcher_command.arg(launcher.as_os_str()).args(&args);
        #[cfg(windows)]
        no_window(&mut launcher_command);
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
        #[cfg(windows)]
        no_window(&mut command);
        command
    } else {
        let mut command = Command::new(program);
        command.args(&args);
        #[cfg(windows)]
        no_window(&mut command);
        command
    };
    Ok(command)
}

/// 相邻事件合并：流式文本/思考块逐 token 到达，逐个发给 WebView 会让
/// React 每 token 全量重渲染一次。合并后每 ~16ms 只发一条，行为与 pilo 一致。
const RUNTIME_EVENT_BATCH_MS: u64 = 16;
const MAX_BUFFERED_EVENTS: usize = 128;

fn push_coalesced(buffer: &mut Vec<Value>, event: Value) {
    let kind = event.get("type").and_then(Value::as_str).unwrap_or_default();
    match kind {
        "assistant_text_delta" | "assistant_thinking_delta" => {
            let same_kind = buffer
                .last()
                .and_then(|last| last.get("type").and_then(Value::as_str))
                .is_some_and(|last_kind| last_kind == kind);
            if same_kind {
                let delta = event.get("delta").and_then(Value::as_str).unwrap_or_default();
                if let Some(last) = buffer.last_mut() {
                    let merged = {
                        let existing = last.get("delta").and_then(Value::as_str).unwrap_or_default();
                        format!("{existing}{delta}")
                    };
                    if let Some(obj) = last.as_object_mut() {
                        obj.insert("delta".into(), Value::String(merged));
                    }
                    return;
                }
            }
            buffer.push(event);
        }
        "tool_execution_update" => {
            let same_tool = buffer.last().is_some_and(|last| {
                last.get("type").and_then(Value::as_str) == Some("tool_execution_update")
                    && last.get("toolCallId") == event.get("toolCallId")
            });
            if same_tool {
                // 工具进度只需要最新快照，丢弃中间态。
                if let Some(last) = buffer.last_mut() {
                    *last = event;
                }
                return;
            }
            buffer.push(event);
        }
        _ => buffer.push(event),
    }
}

/// 可合并的事件先入缓冲；其余事件必须先 flush，保证顺序不被重排。
fn is_bufferable(event: &Value) -> bool {
    matches!(
        event.get("type").and_then(Value::as_str),
        Some("assistant_text_delta" | "assistant_thinking_delta" | "tool_execution_update")
    )
}

fn start_process_blocking(
    app: AppHandle,
    slots: Slots,
    session_key: String,
    executable: String,
    cwd: Option<String>,
    session_path: Option<String>,
) -> Result<(), String> {
    if slot_exists(&slots, &session_key) {
        return Ok(());
    }
    let mut command = build_pi_command(
        if executable.trim().is_empty() {
            "pi"
        } else {
            executable.trim()
        },
        session_path.as_deref(),
    )?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd.as_deref().filter(|s| Path::new(s).is_dir()) {
        command.current_dir(dir);
    }
    // 安全门环境注入：必须在 spawn 前设置。
    // - WEPI_SECURITY_CONFIG：策略快照路径（扩展每次 tool_call 前 stat 热更新）。
    // - WEPI_SESSION_ID：会话身份 key（sessionLevels 字典查表，不透明值）。
    // 快照不存在时先确保落盘一份（默认等级 off = 零干预），扩展读取失败
    // 也会 fail-safe 放行，双保险。
    {
        let snapshot = wepi_security::read_snapshot();
        if let Err(error) = wepi_security::write_snapshot(&snapshot) {
            eprintln!("[wepi] 安全策略快照写入失败：{error}");
        }
        command.env("WEPI_SECURITY_CONFIG", wepi_security::snapshot_path());
        command.env("WEPI_SESSION_ID", &session_key);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 Pi RPC：{e}"))?;
    let stdin = child.stdin.take().ok_or("无法打开 Pi RPC stdin")?;
    let stdout = child.stdout.take().ok_or("无法打开 Pi RPC stdout")?;
    let stderr = child.stderr.take();

    let ready: ReadyFlag = Arc::new((Mutex::new(false), Condvar::new()));
    let ready_out = ready.clone();
    let handshake: Arc<(Mutex<Option<HandshakeState>>, Condvar)> =
        Arc::new((Mutex::new(Some(HandshakeState::Pending)), Condvar::new()));
    let handshake_out = handshake.clone();
    let stderr_tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let stderr_tail_out = stderr_tail.clone();
    let key_for_reader = session_key.clone();
    let (sender, receiver) = std::sync::mpsc::channel::<Result<Value, String>>();

    // 读取线程：解析 JSONL 并归一化，只负责投递。
    std::thread::spawn(move || {
        let handshake_id = "wepi-prepare";
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) if !line.trim().is_empty() => {
                    if let Ok(mut flag) = ready_out.0.lock() {
                        *flag = true;
                    }
                    ready_out.1.notify_all();
                    match serde_json::from_str::<Value>(&line) {
                        Ok(value) => {
                            // 握手响应：匹配 id 且是 response 时回填握手通道，
                            // 不再向前端转发（前端没有对应的等待者）。
                            if value.get("type").and_then(Value::as_str) == Some("response")
                                && value.get("id").and_then(Value::as_str) == Some(handshake_id)
                            {
                                let state = if value.get("success").and_then(Value::as_bool) == Some(true) {
                                    HandshakeState::Done(value.get("data").cloned().unwrap_or(Value::Null))
                                } else {
                                    HandshakeState::Failed(
                                        value
                                            .get("error")
                                            .and_then(Value::as_str)
                                            .unwrap_or("Pi 会话初始化被拒绝")
                                            .to_owned(),
                                    )
                                };
                                if let Ok(mut slot) = handshake_out.0.lock() {
                                    *slot = Some(state);
                                }
                                handshake_out.1.notify_all();
                                continue;
                            }
                            for event in normalized_events_with_key(value, &key_for_reader) {
                                if sender.send(Ok(event)).is_err() {
                                    return;
                                }
                            }
                        }
                        Err(_) => {
                            if sender
                                .send(Err(format!("Pi 返回了无效 JSON：{line}")))
                                .is_err()
                            {
                                return;
                            }
                        }
                    }
                }
                _ => break,
            }
        }
        // stdout 关闭 = 进程退出：未完成的握手立即判失败，避免等待方干等超时。
        if let Ok(mut slot) = handshake_out.0.lock() {
            if matches!(slot.as_ref(), Some(HandshakeState::Pending) | None) {
                *slot = Some(HandshakeState::Failed(
                    "Pi RPC 进程在初始化完成前退出了".to_owned(),
                ));
            }
        }
        handshake_out.1.notify_all();
        // sender 随之 drop，刷新线程据此收尾。
    });

    // 刷新线程：16ms 窗口内合并流式增量后批量发给 WebView，并在收尾时清理槽位。
    let events = app.clone();
    let key_for_exit = session_key.clone();
    std::thread::spawn(move || {
        let mut buffer: Vec<Value> = Vec::new();
        let flush = |buffer: &mut Vec<Value>| {
            for event in buffer.drain(..) {
                let _ = events.emit("pi-rpc-event", event);
            }
        };
        loop {
            match receiver.recv_timeout(Duration::from_millis(RUNTIME_EVENT_BATCH_MS)) {
                Ok(Ok(event)) => {
                    if is_bufferable(&event) {
                        push_coalesced(&mut buffer, event);
                        if buffer.len() >= MAX_BUFFERED_EVENTS {
                            flush(&mut buffer);
                        }
                    } else {
                        // 非增量事件（开始/结束/工具边界）先冲刷，保持时序。
                        flush(&mut buffer);
                        let _ = events.emit("pi-rpc-event", event);
                    }
                }
                Ok(Err(message)) => {
                    flush(&mut buffer);
                    let _ = events.emit("pi-rpc-error", message);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => flush(&mut buffer),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    flush(&mut buffer);
                    break;
                }
            }
        }
        let _ = events.emit("pi-rpc-exit", &key_for_exit);
        if let Some(state) = events.try_state::<RpcProcess>() {
            take_slot(&state.slots, &key_for_exit);
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
                let joined = diagnostics_text.join("\n");
                // 尾部截断到 16KB：只在初始化失败时作为上下文展示。
                let tail: String = if joined.len() > 16 * 1024 {
                    joined[joined.len() - 16 * 1024..].to_owned()
                } else {
                    joined
                };
                if let Ok(mut buffer) = stderr_tail_out.lock() {
                    *buffer = tail;
                }
                let _ = diagnostics.emit("pi-rpc-error", diagnostics_text.join("\n"));
            }
        });
    }
    slots
        .lock()
        .map_err(|_| "RPC 状态锁定失败".to_owned())?
        .insert(
            session_key,
            RpcSlot {
                child,
                stdin,
                ready,
                handshake,
                stderr_tail,
            },
        );
    Ok(())
}

#[tauri::command]
async fn pi_rpc_start(
    app: AppHandle,
    state: State<'_, RpcProcess>,
    session_key: String,
    executable: String,
    cwd: Option<String>,
    session_path: Option<String>,
) -> Result<(), String> {
    let slots = state.slots.clone();
    tauri::async_runtime::spawn_blocking(move || {
        start_process_blocking(app, slots, session_key, executable, cwd, session_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 握手式就绪：向 Pi 发送 `get_state` 并等待它的 response。
/// 返回的 data 里带有 sessionFile / model 等，前端据此回填会话状态。
/// 这是「首次对话必失败」的修复：就绪判定从「吐出任意一行」收紧为
/// 「RPC 循环真正响应了一条命令」。
///
/// 顺序说明：先写命令再等响应（而不是先等第一行输出）。真实 Pi 启动时
/// 会输出初始化通知，但协议上不能依赖它——读取线程对 wepi-prepare 的
/// 响应拦截在缓冲之外，命令先到也不会丢失。
fn prepare_blocking(
    slots: &Slots,
    session_key: &str,
    timeout: Duration,
) -> Result<Value, String> {
    let (handshake, stderr_tail) = {
        let guard = slots
            .lock()
            .map_err(|_| "RPC 状态锁定失败".to_owned())?;
        let slot = guard
            .get(session_key)
            .ok_or("该会话的 Pi RPC 尚未启动")?;
        (slot.handshake.clone(), slot.stderr_tail.clone())
    };
    let deadline = std::time::Instant::now() + timeout;
    // 仅当握手仍是 Pending 时发送 get_state；已完成的握手直接复用结果。
    {
        let (lock, cvar) = &*handshake;
        let mut state = lock.lock().map_err(|_| "RPC 状态锁定失败".to_owned())?;
        if matches!(state.as_ref(), Some(HandshakeState::Pending)) {
            write_record(
                slots,
                session_key,
                &serde_json::json!({ "id": "wepi-prepare", "type": "get_state" }),
            )?;
            while matches!(state.as_ref(), Some(HandshakeState::Pending)) {
                let now = std::time::Instant::now();
                if now >= deadline {
                    *state = None;
                    let stderr = stderr_tail
                        .lock()
                        .map(|buffer| buffer.trim().to_owned())
                        .unwrap_or_default();
                    return Err(if stderr.is_empty() {
                        "Pi RPC 初始化超时（get_state 未响应）".to_owned()
                    } else {
                        format!("Pi RPC 初始化超时：{stderr}")
                    });
                }
                let (guard, _) = cvar
                    .wait_timeout(state, deadline - now)
                    .map_err(|e| e.to_string())?;
                state = guard;
            }
        }
        match state.as_ref() {
            Some(HandshakeState::Done(data)) => Ok(data.clone()),
            Some(HandshakeState::Failed(message)) => {
                let message = message.clone();
                drop(state);
                let stderr = stderr_tail
                    .lock()
                    .map(|buffer| buffer.trim().to_owned())
                    .unwrap_or_default();
                Err(if stderr.is_empty() {
                    message
                } else {
                    format!("{message}\n{stderr}")
                })
            }
            // 超时路径已把状态清空为 None；直接判定失败。
            _ => Err("Pi RPC 初始化未完成".to_owned()),
        }
    }
}

#[tauri::command]
async fn pi_rpc_prepare(
    state: State<'_, RpcProcess>,
    session_key: String,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let slots = state.slots.clone();
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));
    tauri::async_runtime::spawn_blocking(move || prepare_blocking(&slots, &session_key, timeout))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_rpc_wait_ready(
    state: State<'_, RpcProcess>,
    session_key: String,
    timeout_ms: Option<u64>,
) -> Result<(), String> {
    let ready = {
        let guard = state.slots.lock().map_err(|_| "RPC 状态锁定失败".to_owned())?;
        guard
            .get(&session_key)
            .ok_or("该会话的 Pi RPC 尚未启动")?
            .ready
            .clone()
    };
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(20_000));
    tauri::async_runtime::spawn_blocking(move || wait_ready_blocking(&ready, timeout))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_rpc_send(
    state: State<'_, RpcProcess>,
    session_key: String,
    record: Value,
) -> Result<(), String> {
    let slots = state.slots.clone();
    tauri::async_runtime::spawn_blocking(move || write_record(&slots, &session_key, &record))
        .await
        .map_err(|e| e.to_string())?
}

/// 回复 pi 的 extension_ui_request（RPC Extension UI 协议的 client→pi 半边）。
///
/// pi 侧扩展调用 ctx.ui.confirm/select 等对话方法时进程会阻塞等待；前端审批卡
/// / ask 卡收集用户选择后经此命令把 extension_ui_response 直写 pi stdin。
/// payload 形如 { "id": <请求id>, "confirmed": true } 或 { "id": ..., "value": "..." }
/// 或 { "id": ..., "cancelled": true }——按 id 关联，不依赖顺序。
#[tauri::command]
async fn pi_rpc_respond_ui(
    state: State<'_, RpcProcess>,
    session_key: String,
    payload: Value,
) -> Result<(), String> {
    let mut record = payload;
    if let Some(obj) = record.as_object_mut() {
        obj.insert("type".into(), Value::String("extension_ui_response".into()));
    } else {
        return Err("extension_ui_response 负载必须是对象".to_owned());
    }
    let slots = state.slots.clone();
    tauri::async_runtime::spawn_blocking(move || write_record(&slots, &session_key, &record))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_rpc_stop(state: State<'_, RpcProcess>, session_key: String) -> Result<(), String> {
    let slots = state.slots.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(mut slot) = take_slot(&slots, &session_key) {
            let _ = slot.stdin.flush();
            let _ = slot.child.kill();
            let _ = slot.child.wait();
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn pi_rpc_stop_all(state: State<'_, RpcProcess>) -> Result<(), String> {
    let slots = state.slots.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let drained: Vec<(String, RpcSlot)> = match slots.lock() {
            Ok(mut guard) => guard.drain().collect(),
            Err(_) => return,
        };
        for (_, mut slot) in drained {
            let _ = slot.stdin.flush();
            let _ = slot.child.kill();
            let _ = slot.child.wait();
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 用伪 Pi 脚本（Node）验证握手协议：先吐一行无关通知，再响应 get_state。
    /// 旧实现只看「第一行 JSON」会在通知阶段就误判就绪；新实现必须等到
    /// `{"id":"wepi-prepare","type":"response","success":true}` 才放行。
    #[test]
    fn prepare_waits_for_get_state_response_not_first_line() {
        let script = r#"
const lines = [];
let fed = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  fed = true;
  // 忽略内容；收到任意命令后回握手响应。
  const response = {id: 'wepi-prepare', type: 'response', command: 'get_state', success: true, data: {sessionFile: '/tmp/demo.jsonl', model: {id: 'm1', provider: 'p1'}}};
  process.stdout.write(JSON.stringify(response) + '\n');
});
// 启动即输出一行「初始化通知」——旧逻辑会把它当成就绪信号。
process.stdout.write(JSON.stringify({type: 'system', notice: 'booting'}) + '\n');
setTimeout(() => { if (!fed) { process.stderr.write('no command received\n'); process.exit(1); } }, 5000);
"#;
        let dir = std::env::temp_dir().join(format!("wepi-prepare-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let script_path = dir.join("fake-pi.cjs");
        fs::write(&script_path, script).unwrap();
        let node = locate_node().expect("test requires node on PATH or standard install");

        let slots: Slots = Arc::new(Mutex::new(HashMap::new()));
        let key = "prepare-test".to_owned();
        let executable = node.to_string_lossy().into_owned();
        let argument = script_path.to_string_lossy().into_owned();
        // build_pi_command 只支持 pi 形态；这里直接手动构造 node 命令。
        let mut command = Command::new(&executable);
        command.arg(&argument).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().expect("spawn fake pi");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let ready: ReadyFlag = Arc::new((Mutex::new(false), Condvar::new()));
        let handshake: Arc<(Mutex<Option<HandshakeState>>, Condvar)> =
            Arc::new((Mutex::new(Some(HandshakeState::Pending)), Condvar::new()));
        let stderr_tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let ready_out = ready.clone();
        let handshake_out = handshake.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim().is_empty() { continue; }
                *ready_out.0.lock().unwrap() = true;
                ready_out.1.notify_all();
                let value: Value = serde_json::from_str(&line).expect("fake pi emits valid json");
                if value.get("id").and_then(Value::as_str) == Some("wepi-prepare") {
                    *handshake_out.0.lock().unwrap() = Some(HandshakeState::Done(
                        value.get("data").cloned().unwrap_or(Value::Null),
                    ));
                    handshake_out.1.notify_all();
                }
            }
            let mut slot = handshake_out.0.lock().unwrap();
            if matches!(slot.as_ref(), Some(HandshakeState::Pending) | None) {
                *slot = Some(HandshakeState::Failed("exited early".into()));
            }
            handshake_out.1.notify_all();
        });
        slots.lock().unwrap().insert(
            key.clone(),
            RpcSlot { child, stdin, ready, handshake, stderr_tail },
        );
        let data = prepare_blocking(&slots, &key, Duration::from_secs(10)).expect("handshake completes");
        assert_eq!(data["sessionFile"], json!("/tmp/demo.jsonl"));
        // 二次 prepare：握手已完成，直接复用结果不再发命令。
        let again = prepare_blocking(&slots, &key, Duration::from_secs(10)).expect("cached handshake");
        assert_eq!(again["sessionFile"], json!("/tmp/demo.jsonl"));
        let _ = take_slot(&slots, &key);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 握手失败路径：伪 Pi 对 get_state 回 success:false，prepare 必须报错而不是超时。
    #[test]
    fn prepare_surfaces_rejected_handshake() {
        let script = r#"
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {
  process.stdout.write(JSON.stringify({id: 'wepi-prepare', type: 'response', success: false, error: 'no provider configured'}) + '\n');
  setTimeout(() => process.exit(0), 100);
});
"#;
        let dir = std::env::temp_dir().join(format!("wepi-prepare-fail-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let script_path = dir.join("fake-pi-fail.cjs");
        fs::write(&script_path, script).unwrap();
        let node = locate_node().expect("test requires node");

        let slots: Slots = Arc::new(Mutex::new(HashMap::new()));
        let key = "prepare-fail".to_owned();
        let mut command = Command::new(node);
        command.arg(&script_path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().expect("spawn");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let ready: ReadyFlag = Arc::new((Mutex::new(false), Condvar::new()));
        let handshake: Arc<(Mutex<Option<HandshakeState>>, Condvar)> =
            Arc::new((Mutex::new(Some(HandshakeState::Pending)), Condvar::new()));
        let ready_out = ready.clone();
        let handshake_out = handshake.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim().is_empty() { continue; }
                *ready_out.0.lock().unwrap() = true;
                ready_out.1.notify_all();
                let value: Value = serde_json::from_str(&line).expect("valid json");
                if value.get("id").and_then(Value::as_str) == Some("wepi-prepare") {
                    *handshake_out.0.lock().unwrap() = Some(HandshakeState::Failed(
                        value.get("error").and_then(Value::as_str).unwrap_or("unknown").to_owned(),
                    ));
                    handshake_out.1.notify_all();
                }
            }
        });
        slots.lock().unwrap().insert(
            key.clone(),
            RpcSlot { child, stdin, ready, handshake, stderr_tail: Arc::new(Mutex::new(String::new())) },
        );
        let error = prepare_blocking(&slots, &key, Duration::from_secs(10)).expect_err("must fail");
        assert!(error.contains("no provider configured"), "error was: {error}");
        let _ = take_slot(&slots, &key);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 归一化层：text_start/text_end 与 turn 边界必须透传给前端
    /// （reducer 依赖它们做叙述降级与流式去重）。
    #[test]
    fn normalizer_passes_turn_and_text_boundaries() {
        let cases = vec![
            (
                json!({"type":"message_update","assistantMessageEvent":{"type":"text_start"}}),
                json!({"type":"assistant_text_start"}),
            ),
            (
                json!({"type":"message_update","assistantMessageEvent":{"type":"text_end"}}),
                json!({"type":"assistant_text_end"}),
            ),
            (
                json!({"type":"turn_start"}),
                json!({"type":"turn_start"}),
            ),
            (
                json!({"type":"turn_end"}),
                json!({"type":"turn_end"}),
            ),
        ];
        for (input, expected) in cases {
            let out = normalize_rpc_record(input);
            assert_eq!(out.len(), 1, "expected single event for {expected}");
            assert_eq!(out[0], expected);
        }
    }

    #[test]
    fn coalesces_adjacent_text_and_thinking_deltas() {
        let mut buffer = Vec::new();
        for (kind, delta) in [
            ("assistant_text_delta", "你"),
            ("assistant_text_delta", "好"),
            ("assistant_thinking_delta", "想"),
            ("assistant_thinking_delta", "一下"),
        ] {
            push_coalesced(&mut buffer, json!({"type": kind, "delta": delta}));
        }
        assert_eq!(buffer.len(), 2);
        assert_eq!(buffer[0]["delta"], json!("你好"));
        assert_eq!(buffer[1]["delta"], json!("想一下"));
    }

    #[test]
    fn keeps_only_latest_tool_execution_update() {
        let mut buffer = Vec::new();
        push_coalesced(
            &mut buffer,
            json!({"type": "tool_execution_update", "toolCallId": "c1", "partialResult": "first"}),
        );
        push_coalesced(
            &mut buffer,
            json!({"type": "tool_execution_update", "toolCallId": "c1", "partialResult": "latest"}),
        );
        assert_eq!(buffer.len(), 1);
        assert_eq!(buffer[0]["partialResult"], json!("latest"));
    }

    #[test]
    fn separates_deltas_from_different_tools_and_event_boundaries() {
        let mut buffer = Vec::new();
        push_coalesced(&mut buffer, json!({"type": "assistant_text_delta", "delta": "a"}));
        push_coalesced(&mut buffer, json!({"type": "tool_execution_update", "toolCallId": "c1"}));
        push_coalesced(&mut buffer, json!({"type": "tool_execution_update", "toolCallId": "c2"}));
        push_coalesced(&mut buffer, json!({"type": "assistant_text_delta", "delta": "b"}));
        assert_eq!(buffer.len(), 4, "不同类型的增量不能被错误合并");
    }

    #[test]
    fn bufferable_classification_matches_pilo_contract() {
        assert!(is_bufferable(&json!({"type": "assistant_text_delta"})));
        assert!(is_bufferable(&json!({"type": "assistant_thinking_delta"})));
        assert!(is_bufferable(&json!({"type": "tool_execution_update"})));
        // 边界事件必须立即下发，否则会打乱时序。
        assert!(!is_bufferable(&json!({"type": "assistant_message_end"})));
        assert!(!is_bufferable(&json!({"type": "agent_settled"})));
        assert!(!is_bufferable(&json!({"type": "tool_execution_start"})));
    }

    #[test]
    fn normalizes_message_lifecycle_into_frontend_events() {
        // assistant message_end -> assistant_message_end（收尾快照）
        let events = normalize_rpc_record(json!({
            "type": "message_end",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}
        }));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], json!("assistant_message_end"));

        // system message_end 不能污染助手消息
        let events = normalize_rpc_record(json!({
            "type": "message_end",
            "message": {"role": "system", "content": []}
        }));
        assert_eq!(events[0]["type"], json!("message_end"));

        // text_delta -> assistant_text_delta
        let events = normalize_rpc_record(json!({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_delta", "delta": "x"}
        }));
        assert_eq!(events[0]["type"], json!("assistant_text_delta"));

        // text_start/end -> 边界事件（reducer 依赖做叙述降级与流式去重）
        let events = normalize_rpc_record(json!({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_start"}
        }));
        assert_eq!(events[0]["type"], json!("assistant_text_start"));
        let events = normalize_rpc_record(json!({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_end"}
        }));
        assert_eq!(events[0]["type"], json!("assistant_text_end"));
    }

    #[test]
    fn every_normalized_event_carries_its_session_key() {
        // 回归：键必须在归一化之后打上。归一化会新建文本/思考事件对象，
        // 若提前打标，这些事件会丢掉会话键，前端按会话路由时会把整段
        // 正文丢弃（只有原样透传的工具事件能到达）。
        let cases = vec![
            json!({"type":"message_start","message":{"role":"assistant"}}),
            json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hi"}}),
            json!({"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"hmm"}}),
            json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}),
            json!({"type":"tool_execution_start","toolCallId":"c1","toolName":"read"}),
            json!({"type":"agent_settled"}),
            json!({"type":"response","id":"x","success":true}),
        ];
        for case in cases {
            let events = normalized_events_with_key(case.clone(), "rpc-abc");
            assert!(!events.is_empty(), "case produced no events: {case}");
            for event in &events {
                assert_eq!(
                    event.get("__sessionKey").and_then(Value::as_str),
                    Some("rpc-abc"),
                    "event lost its session key: {event}"
                );
            }
        }
    }

    #[test]
    fn text_delta_survives_normalization_with_its_payload() {
        let events = normalized_events_with_key(
            json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"你好"}}),
            "k",
        );
        assert_eq!(events[0]["type"], json!("assistant_text_delta"));
        assert_eq!(events[0]["delta"], json!("你好"));
        assert_eq!(events[0]["__sessionKey"], json!("k"));
    }

    #[test]
    fn session_delete_is_confined_to_the_sessions_directory() {
        let root = std::env::temp_dir().join(format!("wepi-del-test-{}", std::process::id()));
        let nested = root.join("--E--proj--");
        fs::create_dir_all(&nested).unwrap();
        let inside = nested.join("s.jsonl");
        fs::write(&inside, "{}").unwrap();
        let outside = root.parent().unwrap().join(format!(
            "wepi-outside-{}.jsonl",
            std::process::id()
        ));
        fs::write(&outside, "{}").unwrap();

        // 目录内 .jsonl：允许
        assert!(resolve_deletable_session(&inside.to_string_lossy(), &root).is_ok());
        // 目录外：拒绝
        assert!(resolve_deletable_session(&outside.to_string_lossy(), &root).is_err());
        // 非 .jsonl：拒绝
        let txt = nested.join("s.txt");
        fs::write(&txt, "x").unwrap();
        assert!(resolve_deletable_session(&txt.to_string_lossy(), &root).is_err());

        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&root);
    }
}

/* ------------------------------------------------------------------ */
/*  Pi 管理：MCP / 技能 / 扩展 / 运行时                                  */
/* ------------------------------------------------------------------ */

#[tauri::command]
async fn pi_mcp_snapshot() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(pi_mcp::load_snapshot)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_mcp_save(content: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pi_mcp::save_writable(content))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_mcp_import_scan() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(pi_mcp::scan_import)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_mcp_import_apply(entries: Vec<(String, Value)>, overwrite: bool) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || pi_mcp::apply_import(entries, overwrite))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_mcp_probe(definition: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(pi_mcp::probe_server(&definition)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_skills_list() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(pi_skills::list)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_skills_read(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || pi_skills::read_content(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_skills_create(location_id: String, name: String, description: String, content: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pi_skills::create(&location_id, &name, &description, content.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_skills_write(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pi_skills::write_content(&path, &content))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_skills_set_user_only(path: String, user_only: bool) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || pi_skills::set_user_only(&path, user_only))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_skills_rename(path: String, new_name: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || pi_skills::rename(&path, &new_name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_skills_delete(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pi_skills::delete(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_skills_store_search(query: String, limit: Option<u32>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || pi_skills::store_search(&query, limit.unwrap_or(50)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_skills_store_install(slug: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || pi_skills::store_install(&slug))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_extensions_list(force_refresh: Option<bool>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || pi_ext::list(force_refresh.unwrap_or(false)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_extensions_install(source: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || pi_ext::install(&source))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_extensions_uninstall(source: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pi_ext::uninstall(&source))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_extensions_set_enabled(source: String, enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pi_ext::set_enabled(&source, enabled))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_extensions_update_one(source: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || pi_ext::update_one(&source))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_extensions_update_all() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(pi_ext::update_all)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_extensions_catalog(
    page: Option<u32>,
    query: Option<String>,
    kind: Option<String>,
    sort: Option<String>,
    refresh: Option<bool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pi_ext::catalog(
            page.unwrap_or(1),
            query.as_deref().unwrap_or(""),
            kind.as_deref().unwrap_or(""),
            sort.as_deref().unwrap_or("downloads"),
            refresh.unwrap_or(false),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_runtime_installations() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(pi_runtime::scan_installations)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_runtime_add_path(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || pi_runtime::add_custom_path(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_runtime_remove_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pi_runtime::remove_custom_path(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_runtime_check_update() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(pi_runtime::check_update)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_runtime_update_pi() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(pi_runtime::update_pi)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pi_runtime_diagnostics() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(pi_runtime::run_diagnostics)
        .await
        .map_err(|e| e.to_string())?
}

/* ------------------------------------------------------------------ */
/*  安全管理（等级配置 + 快照 + 会话覆盖）                              */
/* ------------------------------------------------------------------ */

#[tauri::command]
async fn wepi_security_snapshot() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(wepi_security::read_snapshot)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn wepi_security_save(config: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || wepi_security::save_config(config))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn wepi_security_set_session_level(
    session_id: String,
    level_id: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        wepi_security::set_session_level(&session_id, level_id.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ------------------------------------------------------------------ */
/*  系统打开能力                                                        */
/* ------------------------------------------------------------------ */

#[tauri::command]
async fn shell_show_in_explorer(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || shell_open::show_in_explorer(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn shell_open_with_system(target: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || shell_open::open_with_system(&target))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn shell_open_in_vscode(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || shell_open::open_in_vscode(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn shell_open_capabilities() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(shell_open::open_capabilities()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RpcProcess::new()).manage(workspace::WorkspaceState::default())
        .setup(|app| {
            // 托盘图标 + 菜单（打开 / 退出）。失败不阻塞启动——托盘是
            // 增强能力，环境不支持时窗口应用仍应正常起来。
            if let Err(error) = tray::setup(app.handle()) {
                eprintln!("[wepi] 托盘初始化失败：{error}");
            }
            // 关闭行为拦截：tray 模式下点窗口关闭只隐藏，不退出。
            let main = app.get_window("main");
            if let Some(window) = main {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if tray::handle_close_requested(&handle) {
                            api.prevent_close();
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pi_rpc_start,
            pi_rpc_send,
            pi_rpc_respond_ui,
            pi_rpc_stop,
            pi_rpc_stop_all,
            pi_rpc_wait_ready,
            pi_rpc_prepare,
            pi_config_read,
            pi_config_write,
            pi_provider_models_fetch,
            read_image_data_url,
            save_temp_image,
            pi_sessions_scan,
            pi_session_read,
            pi_session_delete,
            pi_mcp_snapshot,
            pi_mcp_save,
            pi_mcp_import_scan,
            pi_mcp_import_apply,
            pi_mcp_probe,
            pi_skills_list,
            pi_skills_read,
            pi_skills_create,
            pi_skills_write,
            pi_skills_set_user_only,
            pi_skills_rename,
            pi_skills_delete,
            pi_skills_store_search,
            pi_skills_store_install,
            pi_extensions_list,
            pi_extensions_install,
            pi_extensions_uninstall,
            pi_extensions_set_enabled,
            pi_extensions_update_one,
            pi_extensions_update_all,
            pi_extensions_catalog,
            pi_runtime_installations,
            pi_runtime_add_path,
            pi_runtime_remove_path,
            pi_runtime_check_update,
            pi_runtime_update_pi,
            pi_runtime_diagnostics,
            shell_show_in_explorer,
            shell_open_with_system,
            shell_open_in_vscode,
            shell_open_capabilities,
            wepi_security_snapshot,
            wepi_security_save,
            wepi_security_set_session_level,
            app_update::app_update_check,
            tray::close_behavior_get,
            tray::close_behavior_set
            ,workspace::workspace_request, workspace::terminal_start, workspace::terminal_write, workspace::terminal_resize, workspace::terminal_close, workspace::browser_control
        ])
        .run(tauri::generate_context!())
        .expect("error while running WEPI");
}
