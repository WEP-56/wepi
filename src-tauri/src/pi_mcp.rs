//! Pi 的 MCP 配置管理：多来源分层合并 + 可写层保存 + 跨客户端导入。
//!
//! 设计完全参考 PiDeck 的 `src/main/config/mcpConfig.ts`：
//! - 按 pi-mcp-adapter 的层级从低到高合并：`~/.config/mcp/mcp.json` →
//!   `~/.agents/mcp.json` → `~/.agents/mcp/mcp.json` → `~/.pi/agent/mcp.json`（可写）
//! - 同名 server 浅合并（后层字段覆盖前层），`{disabled:true}` 不会冲掉下层传输定义
//! - 只有传输定义（command/url/socket）写在可写层时，删除才会真正移除条目
//! - 不启动 MCP 运行时；探测只检查 stdio 命令是否存在于 PATH / HTTP URL 是否可达

use crate::toml_lite::parse_toml;
use serde_json::{json, Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const HTTP_PROBE_TIMEOUT_SECS: u64 = 8;
const SERVER_NAME_MAX: usize = 64;

pub fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn pi_agent_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    home_dir().join(".pi").join("agent")
}

/// 四层全局 MCP 来源（不含项目级——WEPI 的 MCP 页固定全局作用域）。
fn layer_paths() -> Vec<(&'static str, PathBuf, bool)> {
    let home = home_dir();
    vec![
        ("user-config", home.join(".config").join("mcp").join("mcp.json"), false),
        ("agents", home.join(".agents").join("mcp.json"), false),
        ("agents-dir", home.join(".agents").join("mcp").join("mcp.json"), false),
        ("pi-agent", pi_agent_dir().join("mcp.json"), true),
    ]
}

pub fn is_valid_server_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed.len() <= SERVER_NAME_MAX
        && !trimmed.contains(['\\', '/'])
        && trimmed
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 由定义推断传输方式：command/url/socket 恰好出现一个才算有效。
pub fn infer_transport(def: &Value) -> Option<&'static str> {
    let has_command = def.get("command").and_then(Value::as_str).is_some_and(|v| !v.trim().is_empty());
    let has_url = def.get("url").and_then(Value::as_str).is_some_and(|v| !v.trim().is_empty());
    let has_socket = def.get("socket").and_then(Value::as_str).is_some_and(|v| !v.trim().is_empty());
    match (has_command as u8 + has_url as u8 + has_socket as u8) == 1 {
        true if has_command => Some("stdio"),
        true if has_url => Some("http"),
        true if has_socket => Some("socket"),
        _ => None,
    }
}

fn parse_mcp_file(raw: &str) -> Result<(Map<String, Value>, Vec<String>), String> {
    let parsed: Value = serde_json::from_str(raw).map_err(|e| format!("JSON 解析失败：{e}"))?;
    let Some(object) = parsed.as_object() else {
        return Err("mcp.json 顶层必须是对象".to_owned());
    };
    let mut servers = Map::new();
    let mut extras = Vec::new();
    for (key, value) in object {
        if key == "mcpServers" {
            let Some(map) = value.as_object() else {
                return Err("mcpServers 必须是对象".to_owned());
            };
            for (name, definition) in map {
                if !definition.is_object() {
                    return Err(format!("服务器「{name}」的配置必须是对象"));
                }
                servers.insert(name.clone(), definition.clone());
            }
        } else {
            extras.push(key.clone());
        }
    }
    Ok((servers, extras))
}

/// 合并后的服务器条目。
struct MergedServer {
    definition: Value,
    origin_path: String,
    override_path: String,
    owned_by_writable: bool,
}

/// 按层级从低到高浅合并同名 server（PiDeck mergeMcpServers 的 Rust 移植）。
fn merge_servers(layers: &[(String, Map<String, Value>)], writable_path: &str) -> Vec<(String, MergedServer)> {
    let mut merged: Vec<(String, MergedServer)> = Vec::new();
    for (path, servers) in layers {
        for (name, raw_def) in servers {
            let existing = merged.iter_mut().find(|(key, _)| key == name);
            match existing {
                None => merged.push((
                    name.clone(),
                    MergedServer {
                        definition: raw_def.clone(),
                        origin_path: path.clone(),
                        override_path: path.clone(),
                        owned_by_writable: path == writable_path,
                    },
                )),
                Some((_, entry)) => {
                    // 浅合并：后层字段覆盖前层，前层其余字段保留。
                    let mut next = entry.definition.as_object().cloned().unwrap_or_default();
                    if let Some(incoming) = raw_def.as_object() {
                        for (key, value) in incoming {
                            next.insert(key.clone(), value.clone());
                        }
                    }
                    let touches_transport = infer_transport(raw_def).is_some() || has_any_transport(raw_def);
                    if touches_transport {
                        entry.origin_path = path.clone();
                    }
                    entry.override_path = path.clone();
                    entry.definition = Value::Object(next);
                    entry.owned_by_writable = entry.origin_path == writable_path;
                }
            }
        }
    }
    merged.sort_by(|a, b| a.0.cmp(&b.0));
    merged
}

fn has_any_transport(def: &Value) -> bool {
    ["command", "url", "socket"].iter().any(|key| def.get(*key).and_then(Value::as_str).is_some_and(|v| !v.trim().is_empty()))
}

fn load_layer(path: &Path) -> Option<Result<(String, Map<String, Value>, Vec<String>), String>> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return None,
    };
    Some(match parse_mcp_file(&raw) {
        Ok((servers, extras)) => Ok((raw, servers, extras)),
        Err(error) => Err(error),
    })
}

/// 读取完整快照：层级状态 + 合并结果 + 可写层原文。
pub fn load_snapshot() -> Result<Value, String> {
    let home = home_dir();
    let mut layers_json = Vec::<Value>::new();
    let mut loaded: Vec<(String, Map<String, Value>)> = Vec::new();
    let mut writable_raw: Option<String> = None;
    let mut writable_error: Option<String> = None;
    let mut writable_path = String::new();
    let mut writable_servers = Map::new();
    let mut writable_extras = Vec::new();

    for (kind, path, writable) in layer_paths() {
        let display = path.to_string_lossy().into_owned();
        let result = load_layer(&path);
        let exists = result.is_some();
        layers_json.push(json!({
            "kind": kind,
            "path": display,
            "exists": exists,
            "writable": writable,
        }));
        match result {
            Some(Ok((raw, servers, extras))) => {
                if writable {
                    writable_raw = Some(raw);
                    writable_servers = servers.clone();
                    writable_extras = extras;
                    writable_path = display.clone();
                }
                loaded.push((display, servers));
            }
            Some(Err(error)) => {
                if writable {
                    // JSON 损坏：可写层必须保持空对象兜底，绝不能让可视化保存覆盖原文件。
                    writable_error = Some(error);
                    writable_servers = Map::new();
                    writable_path = display;
                    writable_raw = None;
                }
            }
            None => {
                if writable {
                    writable_path = display;
                }
            }
        }
    }
    let _ = &home;

    let servers = merge_servers(&loaded, &writable_path)
        .into_iter()
        .map(|(name, entry)| {
            json!({
                "name": name,
                "definition": entry.definition,
                "originPath": entry.origin_path,
                "overridePath": entry.override_path,
                "ownedByWritable": entry.owned_by_writable,
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "layers": layers_json,
        "writablePath": writable_path,
        "writableRaw": writable_raw.unwrap_or_else(|| "{\n  \"mcpServers\": {}\n}\n".to_owned()),
        "writableError": writable_error,
        "writableFile": {
            "mcpServers": Value::Object(writable_servers),
            // extras 保留在内存里，save 时原样写回，避免可视化编辑丢字段。
            "_extras": writable_extras,
        },
        "servers": servers,
    }))
}

/// 保存可写层：只允许合法 server 条目；extras 原样保留。
pub fn save_writable(content: Value) -> Result<(), String> {
    let mut output = Map::new();
    let mut servers = Map::new();
    let Some(root) = content.as_object() else {
        return Err("配置必须是对象".to_owned());
    };
    for (key, value) in root {
        if key == "mcpServers" {
            let Some(map) = value.as_object() else {
                return Err("mcpServers 必须是对象".to_owned());
            };
            for (name, definition) in map {
                if !is_valid_server_name(name) {
                    return Err(format!("服务器名称非法：「{name}」"));
                }
                if !definition.is_object() {
                    return Err(format!("服务器「{name}」的配置必须是对象"));
                }
                if infer_transport(definition).is_none() {
                    return Err(format!("服务器「{name}」需要恰好一个 command / url / socket"));
                }
                servers.insert(name.clone(), definition.clone());
            }
        } else if key != "_extras" {
            output.insert(key.clone(), value.clone());
        }
    }
    output.insert("mcpServers".to_owned(), Value::Object(servers));
    let path = pi_agent_dir().join("mcp.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建 Pi 配置目录：{e}"))?;
    }
    let pretty = serde_json::to_string_pretty(&Value::Object(output)).map_err(|e| e.to_string())?;
    fs::write(&path, format!("{pretty}\n")).map_err(|e| format!("无法写入 mcp.json：{e}"))
}

/* ------------------------------------------------------------------ */
/*  跨客户端导入：Claude / Codex                                        */
/* ------------------------------------------------------------------ */

fn home_file(name: &str) -> PathBuf {
    home_dir().join(name)
}

struct ImportSource {
    label: &'static str,
    path: PathBuf,
    format: &'static str,
}

fn import_sources() -> Vec<ImportSource> {
    vec![
        ImportSource { label: "Claude Desktop / CLI", path: home_file(".claude.json"), format: "json" },
        ImportSource { label: "Claude MCP 合集", path: home_dir().join(".claude").join("mcp-configs").join("mcp-servers.json"), format: "json" },
        ImportSource { label: "Codex", path: home_dir().join(".codex").join("config.toml"), format: "toml" },
    ]
}

fn extract_vendor_servers(parsed: &Value, codex: bool) -> Vec<(String, Value)> {
    let key: &str = if codex { "mcp_servers" } else { "mcpServers" };
    if let Some(map) = parsed.get(key).and_then(Value::as_object) {
        return map.iter().map(|(name, value)| (name.clone(), value.clone())).collect();
    }
    if !codex {
        // 少数 Claude 导出是裸 map（顶层直接就是 server 名 → 定义）。
        const TRANSPORT_KEYS: [&str; 7] = ["command", "url", "socket", "type", "args", "env", "headers"];
        if let Some(map) = parsed.as_object() {
            let looks_bare = !map.is_empty()
                && map.values().all(|value| {
                    value.as_object().is_some_and(|object| {
                        TRANSPORT_KEYS.iter().any(|transport_key| object.contains_key(*transport_key))
                    })
                });
            if looks_bare {
                return map.iter().map(|(name, value)| (name.clone(), value.clone())).collect();
            }
        }
    }
    Vec::new()
}

/// 把 vendor 定义转换成 Pi 的 mcp.json 定义（PiDeck convertMcpDefinition 的简化移植）。
fn convert_vendor_definition(raw: &Value, codex: bool, warnings: &mut Vec<String>) -> Option<Value> {
    let object = raw.as_object()?;
    let command = object.get("command").and_then(Value::as_str).filter(|v| !v.trim().is_empty());
    let url = object.get("url").and_then(Value::as_str).filter(|v| !v.trim().is_empty());
    let socket = object.get("socket").and_then(Value::as_str).filter(|v| !v.trim().is_empty());
    let transport_count = command.is_some() as u8 + url.is_some() as u8 + socket.is_some() as u8;
    if transport_count != 1 {
        warnings.push("需要恰好一个 command / url / socket".to_owned());
        return None;
    }
    let mut definition = Map::new();
    if let Some(command) = command {
        definition.insert("command".into(), Value::String(command.to_owned()));
        if let Some(args) = object.get("args").and_then(Value::as_array) {
            let cleaned: Vec<Value> = args.iter().filter(|item| item.is_string()).cloned().collect();
            if cleaned.len() != args.len() {
                warnings.push("部分参数不是字符串，已忽略".to_owned());
            }
            definition.insert("args".into(), Value::Array(cleaned));
        }
        if let Some(env) = object.get("env").and_then(Value::as_object) {
            let cleaned: Map<String, Value> = env.iter().filter(|(_, v)| v.is_string()).map(|(k, v)| (k.clone(), v.clone())).collect();
            definition.insert("env".into(), Value::Object(cleaned));
        }
    }
    if let Some(url) = url {
        definition.insert("url".into(), Value::String(url.to_owned()));
        if let Some(headers) = object.get("headers").and_then(Value::as_object) {
            let cleaned: Map<String, Value> = headers.iter().filter(|(_, v)| v.is_string()).map(|(k, v)| (k.clone(), v.clone())).collect();
            definition.insert("headers".into(), Value::Object(cleaned));
        }
    }
    if let Some(socket) = socket {
        definition.insert("socket".into(), Value::String(socket.to_owned()));
    }
    if codex {
        if object.get("enabled") == Some(&Value::Bool(false)) {
            definition.insert("disabled".into(), Value::Bool(true));
        }
    } else if let Some(disabled) = object.get("disabled").and_then(Value::as_bool) {
        definition.insert("disabled".into(), Value::Bool(disabled));
    }
    Some(Value::Object(definition))
}

/// 扫描可导入的 MCP 候选（Claude JSON / Codex TOML）。
pub fn scan_import() -> Result<Value, String> {
    let mut sources = Vec::<Value>::new();
    let mut candidates = Vec::<Value>::new();
    for source in import_sources() {
        let display = source.path.to_string_lossy().into_owned();
        let raw = match fs::read_to_string(&source.path) {
            Ok(raw) => raw,
            Err(_) => {
                sources.push(json!({ "label": source.label, "path": display, "exists": false }));
                continue;
            }
        };
        let parsed: Value = match source.format {
            "toml" => match parse_toml(&raw) {
                Ok(value) => value,
                Err(_) => {
                    sources.push(json!({ "label": source.label, "path": display, "exists": true, "error": "无法解析" }));
                    continue;
                }
            },
            _ => match serde_json::from_str(&raw) {
                Ok(value) => value,
                Err(_) => {
                    sources.push(json!({ "label": source.label, "path": display, "exists": true, "error": "无法解析" }));
                    continue;
                }
            },
        };
        let codex = source.format == "toml";
        let servers = extract_vendor_servers(&parsed, codex);
        sources.push(json!({ "label": source.label, "path": display, "exists": true, "count": servers.len() }));
        for (name, raw_def) in servers {
            let mut warnings = Vec::new();
            let definition = convert_vendor_definition(&raw_def, codex, &mut warnings);
            let blocker = if is_valid_server_name(&name) { None } else { Some("名称不符合 Pi 规范".to_owned()) };
            candidates.push(json!({
                "name": name,
                "sourceLabel": source.label,
                "definition": definition,
                "transport": infer_transport(definition.as_ref().unwrap_or(&Value::Null)),
                "warnings": warnings,
                "blocker": blocker,
                "importable": definition.is_some() && blocker.is_none(),
            }));
        }
    }
    Ok(json!({ "sources": sources, "candidates": candidates }))
}

/// 导入选中的候选：写入可写层（同名时跳过或覆盖由 overwrite 决定）。
pub fn apply_import(entries: Vec<(String, Value)>, overwrite: bool) -> Result<Value, String> {
    let path = pi_agent_dir().join("mcp.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建 Pi 配置目录：{e}"))?;
    }
    let mut file = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({ "mcpServers": {} }));
    if !file.is_object() {
        file = json!({ "mcpServers": {} });
    }
    let servers = file
        .as_object_mut()
        .expect("已保证对象")
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    let map = servers.as_object_mut().ok_or("mcpServers 必须是对象")?;
    let mut imported = 0usize;
    let mut skipped = Vec::new();
    for (name, definition) in entries {
        if !is_valid_server_name(&name) {
            skipped.push(format!("{name}（名称非法）"));
            continue;
        }
        if !overwrite && map.contains_key(&name) {
            skipped.push(format!("{name}（已存在）"));
            continue;
        }
        map.insert(name, definition);
        imported += 1;
    }
    let pretty = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(&path, format!("{pretty}\n")).map_err(|e| format!("无法写入 mcp.json：{e}"))?;
    Ok(json!({ "imported": imported, "skipped": skipped }))
}

/* ------------------------------------------------------------------ */
/*  探测                                                               */
/* ------------------------------------------------------------------ */

fn find_on_path(command: &str) -> Option<PathBuf> {
    let trimmed = command.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }
    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        return candidate.is_file().then_some(candidate);
    }
    let path_env = std::env::var("PATH").unwrap_or_default();
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
        let direct = Path::new(dir).join(trimmed);
        if direct.is_file() {
            return Some(direct);
        }
        for ext in &extensions {
            let with_ext = Path::new(dir).join(format!("{trimmed}{ext}"));
            if with_ext.is_file() {
                return Some(with_ext);
            }
        }
    }
    None
}

/// 轻量探测：stdio 查 PATH；HTTP 用 TCP 连接 + 裸 HTTP 请求判断可达性。
/// 不启动 MCP 握手——可达即视为配置有效（与 PiDeck 口径一致）。
pub fn probe_server(definition: &Value) -> Value {
    let Some(transport) = infer_transport(definition) else {
        return json!({ "ok": false, "error": "需要恰好一个 command / url / socket" });
    };
    match transport {
        "stdio" => {
            let command = definition.get("command").and_then(Value::as_str).unwrap_or_default();
            match find_on_path(command) {
                Some(resolved) => json!({ "ok": true, "transport": "stdio", "detail": resolved.to_string_lossy() }),
                None => json!({ "ok": false, "transport": "stdio", "error": format!("命令未找到：{command}") }),
            }
        }
        "http" => {
            let url = definition.get("url").and_then(Value::as_str).unwrap_or_default();
            match probe_http(url) {
                Ok(detail) => json!({ "ok": true, "transport": "http", "detail": detail }),
                Err(error) => json!({ "ok": false, "transport": "http", "error": error }),
            }
        }
        _ => {
            let socket = definition.get("socket").and_then(Value::as_str).unwrap_or_default();
            if socket.trim().is_empty() {
                json!({ "ok": false, "transport": "socket", "error": "socket 路径为空" })
            } else if Path::new(socket).exists() {
                json!({ "ok": true, "transport": "socket", "detail": socket })
            } else {
                json!({ "ok": false, "transport": "socket", "error": format!("socket 不存在：{socket}") })
            }
        }
    }
}

/// HTTP 探测：MCP 端点对裸 GET 常回 404/405，能建立连接且状态 <500 即可达。
/// 先自行解析 scheme（不引完整 URL 类型），再用 curl 发请求：Windows 上
/// rustls 证书链问题会误报不可达，curl 使用系统 schannel 更可靠。
fn probe_http(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    let valid_scheme = trimmed.starts_with("http://") || trimmed.starts_with("https://");
    if !valid_scheme {
        return Err("URL 必须是 http(s)".to_owned());
    }
    let mut probe = Command::new("curl");
    probe
        .args([
            "-s",
            "-o",
            "/dev/null", // Windows 的 curl 同样接受 /dev/null（自动映射 NUL）
            "-w",
            "%{http_code}",
            "--max-time",
            &HTTP_PROBE_TIMEOUT_SECS.to_string(),
            "--location",
            trimmed,
        ])
        .stdin(Stdio::null());
    #[cfg(windows)]
    crate::no_window(&mut probe);
    let output = probe
        .output()
        .map_err(|e| format!("curl 启动失败：{e}（请确认已安装 curl）"))?;
    let status = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if status.is_empty() || !status.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("无法获取 HTTP 状态（curl 退出码 {}）", output.status.code().unwrap_or(-1)));
    }
    let code: u16 = status.parse().map_err(|_| "HTTP 状态异常".to_owned())?;
    if (200..500).contains(&code) {
        Ok(format!("HTTP {code}"))
    } else {
        Err(format!("HTTP {code}"))
    }
}
