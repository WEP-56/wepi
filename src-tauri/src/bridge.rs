//! 给 Pi 扩展用的回环工具桥。
//!
//! 每个 Pi 进程通过 `WEPI_BRIDGE={url,token}` 拿到地址；内置扩展 `wepi-tools.ts`
//! 用它拉取工具目录并逐次调用。只绑 127.0.0.1，只接受带 Bearer 的 POST，
//! 只认 `tools/list` 与 `tools/call`——不是通用 IPC，也没有别的入口。
//!
//! 为什么不是 MCP：Pi 的扩展 API 已经能直接注册工具，走一层 MCP 只多一个
//! 协议要维护；工具实现留在 Rust（和面板共用同一份代码）才是关键。

use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

use crate::show;
use crate::simulator::{tools as simulator_tools, Simulators};

const HEADER_LIMIT: usize = 8 * 1024;
const BODY_LIMIT: usize = 64 * 1024;
const SERVER_NAME: &str = "wepi";

struct Endpoint {
    url: String,
    token: String,
}

static ENDPOINT: OnceLock<Option<Endpoint>> = OnceLock::new();
static CONNECTIONS: AtomicU64 = AtomicU64::new(0);

/// 启动（或复用）工具桥，返回 `(url, token)`。
pub fn endpoint(app: &AppHandle) -> Option<(String, String)> {
    ENDPOINT
        .get_or_init(|| start(app).ok())
        .as_ref()
        .map(|endpoint| (endpoint.url.clone(), endpoint.token.clone()))
}

fn token() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{nanos:x}{:x}{seq:x}", std::process::id())
}

fn start(app: &AppHandle) -> Result<Endpoint, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("工具桥端口绑定失败：{error}"))?;
    let authority = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .to_string();
    let token = token();
    let worker_token = token.clone();
    let app = app.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            if CONNECTIONS.fetch_add(1, Ordering::Relaxed) > 4096 {
                continue;
            }
            let (app, token) = (app.clone(), worker_token.clone());
            thread::spawn(move || handle(stream, &app, &token));
        }
    });
    Ok(Endpoint {
        url: format!("http://{authority}/tools"),
        token,
    })
}

fn handle(mut stream: TcpStream, app: &AppHandle, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(20)));
    let body = match read_request(&mut stream, token) {
        Ok(body) => body,
        Err(status) => {
            let _ = write_status(&mut stream, status);
            return;
        }
    };
    let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let response = respond(app, &request);
    let bytes = serde_json::to_vec(&response).unwrap_or_default();
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(&bytes);
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

/// 只接受 `POST /tools`、带正确 Bearer、且没有 Origin 头的请求。
fn read_request(stream: &mut TcpStream, token: &str) -> Result<Vec<u8>, u16> {
    let mut bytes = Vec::with_capacity(4096);
    let header_end;
    loop {
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = index + 4;
            if header_end > HEADER_LIMIT {
                return Err(413);
            }
            break;
        }
        if bytes.len() >= HEADER_LIMIT {
            return Err(413);
        }
        let mut chunk = [0u8; 2048];
        let count = stream.read(&mut chunk).map_err(|_| 400u16)?;
        if count == 0 {
            return Err(400);
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let header = std::str::from_utf8(&bytes[..header_end]).map_err(|_| 400u16)?;
    let mut lines = header.split("\r\n");
    let request = lines.next().ok_or(400u16)?;
    let mut parts = request.split(' ');
    if parts.next() != Some("POST")
        || parts.next() != Some("/tools")
        || parts.next() != Some("HTTP/1.1")
        || parts.next().is_some()
    {
        return Err(400);
    }
    let mut headers = std::collections::HashMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(400u16)?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(400);
        }
        if headers
            .insert(name.to_ascii_lowercase(), value.trim().to_owned())
            .is_some()
        {
            return Err(400);
        }
    }
    // 浏览器发不出带 Authorization 的跨源 POST（会先预检），带 Origin 的一律拒绝。
    if headers.contains_key("origin") {
        return Err(403);
    }
    if headers.get("authorization").map(String::as_str) != Some(&format!("Bearer {token}")) {
        return Err(401);
    }
    if headers.get("content-type").is_none_or(|value| {
        value.split(';').next().unwrap_or_default().trim() != "application/json"
    }) {
        return Err(400);
    }
    if headers.contains_key("transfer-encoding") || headers.contains_key("expect") {
        return Err(400);
    }
    let length: usize = headers
        .get("content-length")
        .ok_or(400u16)?
        .parse()
        .map_err(|_| 400u16)?;
    if length > BODY_LIMIT {
        return Err(413);
    }
    let expected = header_end + length;
    if bytes.len() > expected {
        return Err(400);
    }
    let received = bytes.len();
    bytes.resize(expected, 0);
    stream
        .read_exact(&mut bytes[received..])
        .map_err(|_| 400u16)?;
    Ok(bytes[header_end..].to_vec())
}

fn write_status(stream: &mut TcpStream, status: u16) -> std::io::Result<()> {
    let reason = match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let header =
        format!("HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    stream.write_all(header.as_bytes())
}

fn catalog() -> Vec<Value> {
    let mut tools = simulator_tools::catalog();
    tools.extend(show::catalog());
    tools
}

fn respond(app: &AppHandle, request: &Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32600, "message": "Invalid request" } });
    };
    match method {
        "tools/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "server": SERVER_NAME, "tools": catalog() }
        }),
        "tools/call" => {
            let name = request["params"]["name"].as_str().unwrap_or_default();
            let args = request["params"]
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            // Pi 扩展运行在会话进程里，`cwd` 是解析相对产物路径的唯一可靠来源。
            let cwd = request["params"].get("cwd").and_then(Value::as_str);
            let known = catalog().iter().any(|tool| tool["name"] == name);
            if !known {
                return json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": "Unknown tool" } });
            }
            // 工具自身的失败是「结果」而不是协议错误：模型要看到错误文本才能自己纠正。
            let result = match call(app, name, &args, cwd) {
                Ok(result) => result,
                Err(message) => {
                    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
                }
            };
            json!({ "jsonrpc": "2.0", "id": id, "result": result })
        }
        _ => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } })
        }
    }
}

fn call(app: &AppHandle, name: &str, args: &Value, cwd: Option<&str>) -> Result<Value, String> {
    if name.starts_with("wepi_simulator_") {
        let sims = app.state::<Simulators>();
        return simulator_tools::dispatch(&sims, name, args);
    }
    if name == "show" {
        return show::dispatch(name, args, cwd);
    }
    Err(format!("Unknown tool: {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        (listener.accept().unwrap().0, client)
    }

    fn ask(request: &'static [u8]) -> Result<Vec<u8>, u16> {
        let (mut server, mut client) = pair();
        let worker = thread::spawn(move || read_request(&mut server, "secret"));
        client.write_all(request).unwrap();
        worker.join().unwrap()
    }

    #[test]
    fn authorized_posts_reach_the_body() {
        let body = ask(b"POST /tools HTTP/1.1\r\nAuthorization: Bearer secret\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
        assert_eq!(body.unwrap(), b"{}");
    }

    #[test]
    fn wrong_token_origin_method_and_type_are_refused() {
        assert_eq!(ask(b"POST /tools HTTP/1.1\r\nAuthorization: Bearer other\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}").unwrap_err(), 401);
        assert_eq!(ask(b"POST /tools HTTP/1.1\r\nOrigin: https://evil.test\r\nAuthorization: Bearer secret\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}").unwrap_err(), 403);
        assert_eq!(
            ask(
                b"GET /tools HTTP/1.1\r\nAuthorization: Bearer secret\r\nContent-Length: 0\r\n\r\n"
            )
            .unwrap_err(),
            400
        );
        assert_eq!(ask(b"POST /other HTTP/1.1\r\nAuthorization: Bearer secret\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}").unwrap_err(), 400);
        assert_eq!(ask(b"POST /tools HTTP/1.1\r\nAuthorization: Bearer secret\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\n{}").unwrap_err(), 400);
        assert_eq!(ask(b"POST /tools HTTP/1.1\r\nAuthorization: Bearer secret\r\nContent-Type: application/json\r\nContent-Length: 999999\r\n\r\n").unwrap_err(), 413);
    }

    #[test]
    fn the_catalog_covers_simulator_and_show_tools() {
        let catalog = catalog();
        let names: Vec<&str> = catalog
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert_eq!(names.len(), 6, "{names:?}");
        assert_eq!(
            names
                .iter()
                .filter(|name| name.starts_with("wepi_simulator_"))
                .count(),
            5
        );
        assert!(
            names.contains(&"wepi_simulator_control") && names.contains(&"wepi_simulator_manage")
        );
        assert!(names.contains(&"show"));
        // 每个工具的 schema 都要有根类型，否则 Pi 侧无法校验参数。
        assert!(catalog
            .iter()
            .all(|tool| tool["inputSchema"]["type"] == "object"));
    }
}
