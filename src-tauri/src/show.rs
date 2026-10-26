//! `show` 工具与右侧预览。
//!
//! 工具本身只做「解析 + 校验 + 分类」：模型调用后，前端从工具块参数重建
//! 卡片，用户点击时才调用 `show_preview` 真正读取/渲染。这样模型不会被
//! 渲染耗时拖慢，用户不看的产物也不会产生渲染成本。
//!
//! 为什么路径解析放 Rust：相对路径要按 Pi 会话的工作目录解析（扩展在
//! `tools/call` 里带上 `cwd`），存在性、文件类型与大小校验也在这一层做完，
//! 前端只拿结果。Office 文档由 `office.rs` 调 OfficeCLI 渲染成 HTML；
//! OfficeCLI 不可用或格式不支持时仍回退到「用系统应用打开」。

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

/// 文本预览上限：与 workspace.rs 的文本预览保持一致，避免两处行为分叉。
const TEXT_LIMIT: u64 = 2 * 1024 * 1024;
/// 图片 / PDF 预览上限：base64 后体积会膨胀约 1/3，超过这个量级不如用系统应用。
const MEDIA_LIMIT: u64 = 24 * 1024 * 1024;
const MAX_TARGETS: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Web,
    Text,
    Image,
    Pdf,
    Office,
    File,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Web => "web",
            Kind::Text => "text",
            Kind::Image => "image",
            Kind::Pdf => "pdf",
            Kind::Office => "office",
            Kind::File => "file",
        }
    }
}

/// 扩展名 → 预览类型。前端 `lib/show.ts::kindOfPath` 保持同一份清单；
/// 前端只用它选图标，真正的读取/渲染类型以这里为准。
fn kind_of_path(path: &Path) -> Kind {
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "docx" | "docm" | "doc" | "pptx" | "pptm" | "ppt" | "xlsx" | "xlsm" | "xls" | "odt"
        | "odp" | "ods" => Kind::Office,
        "pdf" => Kind::Pdf,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif" | "svg" => Kind::Image,
        "txt" | "md" | "markdown" | "json" | "jsonc" | "json5" | "js" | "mjs" | "cjs" | "jsx"
        | "ts" | "tsx" | "css" | "scss" | "sass" | "less" | "html" | "htm" | "xml" | "yaml"
        | "yml" | "toml" | "ini" | "env" | "rs" | "py" | "go" | "java" | "kt" | "kts" | "c"
        | "h" | "cc" | "cpp" | "cxx" | "hpp" | "cs" | "rb" | "php" | "swift" | "dart" | "lua"
        | "sh" | "bash" | "zsh" | "ps1" | "bat" | "cmd" | "sql" | "graphql" | "gql" | "proto"
        | "vue" | "svelte" | "astro" | "log" | "csv" | "tsv" | "tex" | "rst" | "diff" | "patch" => {
            Kind::Text
        }
        _ => Kind::File,
    }
}

#[derive(Debug)]
struct Target {
    kind: Kind,
    path: Option<PathBuf>,
    url: Option<String>,
    name: String,
}

impl Target {
    fn extension(&self) -> String {
        self.path
            .as_ref()
            .and_then(|path| path.extension())
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default()
    }

    fn label(&self) -> &'static str {
        match self.kind {
            Kind::Web => "网页",
            Kind::Text => "代码/文本",
            Kind::Image => "图片",
            Kind::Pdf => "PDF",
            Kind::Office => match self.extension().as_str() {
                "docx" | "docm" | "doc" | "odt" => "Word 文档",
                "pptx" | "pptm" | "ppt" | "odp" => "演示文稿",
                "xlsx" | "xlsm" | "xls" | "ods" => "表格",
                _ => "办公文档",
            },
            Kind::File => "文件",
        }
    }

    fn display(&self) -> String {
        self.path
            .as_ref()
            .map(|path| display_path(path))
            .or_else(|| self.url.clone())
            .unwrap_or_default()
    }

    fn to_json(&self) -> Value {
        let mut value = json!({ "kind": self.kind.as_str(), "name": &self.name });
        if let Some(path) = &self.path {
            value["path"] = json!(display_path(path));
        }
        if let Some(url) = &self.url {
            value["url"] = json!(url);
        }
        value
    }
}

pub fn catalog() -> Vec<Value> {
    vec![json!({
        "name": "show",
        "description": "把需要用户审阅的产物交给 WEPI 右侧预览栏。传入一个或多个本地文件路径（代码/文本、图片、PDF、Word/PPT/Excel）或 http(s) URL；相对路径按当前会话工作目录解析。工具成功后，本轮最终回复下方会出现预览卡片，用户点击即可在右侧打开。Office 文档会尝试用 OfficeCLI 渲染；渲染失败或格式不支持时仍给「用系统应用打开」。只在产物确实存在且值得用户查看时调用；不要在调用后再把同样的路径写成 Markdown 链接，也不要用它展示普通文件列表。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "targets": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_TARGETS,
                    "items": { "type": "string", "maxLength": 4096 },
                    "description": "要展示的本地路径或 URL。本地路径可以是绝对路径，或相对当前会话工作目录的路径。"
                },
                "title": {
                    "type": "string",
                    "maxLength": 200,
                    "description": "卡片标题；省略时用「可预览产物」。"
                }
            },
            "required": ["targets"],
            "additionalProperties": false
        }
    })]
}

/// 工具调用入口：校验全部目标后返回一段给模型看的摘要。
/// 任何一个目标无效都整单失败，避免卡片里混进用户点不开的路径。
pub fn dispatch(name: &str, args: &Value, cwd: Option<&str>) -> Result<Value, String> {
    if name != "show" {
        return Err(format!("未知工具：{name}"));
    }
    let raw = targets_from_args(args);
    if raw.is_empty() {
        return Err("缺少 targets：至少提供一个文件路径或 URL".to_owned());
    }
    if raw.len() > MAX_TARGETS {
        return Err(format!("一次最多展示 {MAX_TARGETS} 个目标"));
    }
    let mut targets = Vec::new();
    let mut errors = Vec::new();
    for value in &raw {
        match resolve_target(value, cwd) {
            Ok(target) => targets.push(target),
            Err(error) => errors.push(format!("{value}：{error}")),
        }
    }
    if !errors.is_empty() {
        return Err(format!("以下目标无法展示：\n- {}", errors.join("\n- ")));
    }
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let lines = targets
        .iter()
        .enumerate()
        .map(|(index, target)| format!("{}. {}：{}", index + 1, target.label(), target.display()))
        .collect::<Vec<_>>()
        .join("\n");
    let mut details = json!({ "targets": targets.iter().map(Target::to_json).collect::<Vec<_>>() });
    if let Some(title) = title {
        details["title"] = json!(title);
    }
    Ok(json!({
        "content": [{
            "type": "text",
            "text": format!("已准备 {} 项预览，用户点击本轮回复下方的卡片即可在右侧查看：\n{lines}", targets.len())
        }],
        "details": details
    }))
}

/// 前端右栏的预览入口。`raw` 来自 show 卡片里的绝对路径；
/// 历史消息可能给相对路径，这时按 WEPI 进程 cwd 兜底（通常不会命中）。
pub fn preview(raw: &str) -> Result<Value, String> {
    let target = resolve_target(raw, None)?;
    let Some(path) = target.path.as_ref() else {
        return Err("网页请在网页标签中打开".to_owned());
    };
    let size = fs::metadata(path)
        .map_err(|error| format!("无法读取文件信息：{error}"))?
        .len();
    let display = display_path(path);
    match target.kind {
        Kind::Text => text_preview(path, &display, size),
        Kind::Image => image_preview(path, &display, size),
        Kind::Pdf => pdf_preview(path, &display, size),
        Kind::Office => Ok(crate::office::preview(path, &display, size)),
        Kind::File => sniff_preview(path, &display, size),
        Kind::Web => Err("网页请在网页标签中打开".to_owned()),
    }
}

fn text_preview(path: &Path, display: &str, size: u64) -> Result<Value, String> {
    if size > TEXT_LIMIT {
        return Ok(unsupported(
            display,
            size,
            "文本文件超过 2 MB，请用系统应用打开",
        ));
    }
    let bytes = fs::read(path).map_err(|error| format!("无法读取文件：{error}"))?;
    if bytes.contains(&0) {
        return Ok(unsupported(
            display,
            size,
            "该文件不是文本文件，请用系统应用打开",
        ));
    }
    let content =
        String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 文本，无法预览".to_owned())?;
    Ok(json!({ "kind": "text", "path": display, "content": content, "size": size }))
}

fn image_preview(path: &Path, display: &str, size: u64) -> Result<Value, String> {
    if size > MEDIA_LIMIT {
        return Ok(unsupported(
            display,
            size,
            "图片超过 24 MB，请用系统应用打开",
        ));
    }
    let bytes = fs::read(path).map_err(|error| format!("无法读取图片：{error}"))?;
    let mime = image_mime(path);
    Ok(json!({
        "kind": "image",
        "path": display,
        "size": size,
        "dataUrl": format!("data:{mime};base64,{}", STANDARD.encode(&bytes))
    }))
}

fn pdf_preview(path: &Path, display: &str, size: u64) -> Result<Value, String> {
    if size > MEDIA_LIMIT {
        return Ok(unsupported(
            display,
            size,
            "PDF 超过 24 MB，请用系统应用打开",
        ));
    }
    let bytes = fs::read(path).map_err(|error| format!("无法读取 PDF：{error}"))?;
    if !bytes.starts_with(b"%PDF") {
        return Ok(unsupported(display, size, "文件不是有效的 PDF"));
    }
    Ok(json!({
        "kind": "pdf",
        "path": display,
        "size": size,
        "data": STANDARD.encode(&bytes)
    }))
}

fn sniff_preview(path: &Path, display: &str, size: u64) -> Result<Value, String> {
    if size > TEXT_LIMIT {
        return Ok(unsupported(
            display,
            size,
            "该文件类型暂不支持应用内预览，请用系统应用打开",
        ));
    }
    let bytes = fs::read(path).map_err(|error| format!("无法读取文件：{error}"))?;
    if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
        return Ok(unsupported(
            display,
            size,
            "该文件类型暂不支持应用内预览，请用系统应用打开",
        ));
    }
    Ok(json!({
        "kind": "text",
        "path": display,
        "content": String::from_utf8_lossy(&bytes),
        "size": size
    }))
}

fn unsupported(path: &str, size: u64, message: impl Into<String>) -> Value {
    json!({ "kind": "unsupported", "path": path, "size": size, "message": message.into() })
}

fn image_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn targets_from_args(args: &Value) -> Vec<String> {
    let mut out = Vec::new();
    match args.get("targets") {
        Some(Value::Array(items)) => items.iter().for_each(|item| push_target(&mut out, item)),
        Some(value) => push_target(&mut out, value),
        None => {}
    }
    if out.is_empty() {
        if let Some(items) = args.get("items").and_then(Value::as_array) {
            items.iter().for_each(|item| push_target(&mut out, item));
        }
    }
    if out.is_empty() {
        for key in ["path", "url", "file", "href"] {
            if let Some(text) = args
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                out.push(text.to_owned());
                break;
            }
        }
    }
    let mut seen = HashSet::new();
    out.retain(|value| seen.insert(value.clone()));
    out
}

fn push_target(out: &mut Vec<String>, value: &Value) {
    match value {
        Value::String(text) => {
            let text = text.trim();
            if !text.is_empty() {
                out.push(text.to_owned());
            }
        }
        Value::Object(map) => {
            for key in ["path", "url", "file", "href", "target"] {
                if let Some(text) = map
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                {
                    out.push(text.to_owned());
                    break;
                }
            }
        }
        _ => {}
    }
}

fn resolve_target(raw: &str, cwd: Option<&str>) -> Result<Target, String> {
    let mut value = raw
        .trim()
        .trim_matches(|character| matches!(character, '"' | '\'' | '`'))
        .trim_matches(|character| matches!(character, '<' | '>'))
        .trim()
        .to_owned();
    if value.is_empty() {
        return Err("目标为空".to_owned());
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        let rest = value.splitn(2, "://").nth(1).unwrap_or("");
        if rest.is_empty() || rest.starts_with('/') || rest.chars().any(char::is_whitespace) {
            return Err("URL 无效".to_owned());
        }
        let name = url_display_name(&value);
        return Ok(Target {
            kind: Kind::Web,
            path: None,
            url: Some(value),
            name,
        });
    }
    if value
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
    {
        let rest = &value[7..];
        // file:///C:/x → C:/x；file://server/share → \\server\share（UNC）。
        value = match rest.strip_prefix('/') {
            Some(path) => percent_decode(path),
            None => format!(r"\\{}", percent_decode(rest).replace('/', r"\")),
        };
    } else if value
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"))
    {
        value = percent_decode(&value[5..]);
    }
    if has_unsupported_scheme(&value) {
        return Err("只支持 http(s) URL 或本地文件路径".to_owned());
    }
    let path = PathBuf::from(&value);
    let absolute = if path.is_absolute() {
        path
    } else {
        let base = cwd
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        base.join(path)
    };
    let canonical = fs::canonicalize(&absolute).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => format!("文件不存在：{}", absolute.display()),
        _ => format!("无法读取路径：{error}"),
    })?;
    if !canonical.is_file() {
        return Err("目标不是文件（目录请用文件管理器打开）".to_owned());
    }
    let kind = kind_of_path(&canonical);
    let name = canonical
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| display_path(&canonical));
    Ok(Target {
        kind,
        path: Some(canonical),
        url: None,
        name,
    })
}

/// 带协议头的字符串里，除了 http(s) 都拒绝；Windows 盘符（`C:\`）不算协议。
fn has_unsupported_scheme(value: &str) -> bool {
    let Some(index) = value.find(':') else {
        return false;
    };
    let scheme = &value[..index];
    if scheme.len() < 2 || scheme.len() > 32 {
        return false;
    }
    let mut characters = scheme.chars();
    if !characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic())
    {
        return false;
    }
    if !characters
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.'))
    {
        return false;
    }
    !matches!(value.as_bytes().get(index + 1), Some(b'\\' | b'/'))
}

fn url_display_name(url: &str) -> String {
    let rest = url.splitn(2, "://").nth(1).unwrap_or(url);
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let host = rest.split('/').next().unwrap_or(rest);
    let path = rest.strip_prefix(host).unwrap_or("").trim_matches('/');
    if path.is_empty() {
        host.to_owned()
    } else {
        format!("{host}/{path}")
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Windows canonicalize 会带 `\\?\` 前缀；展示和传给外部程序时去掉。
fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("wepi-show-test-{}-{name}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn catalog_exposes_show_with_a_strict_schema() {
        let catalog = catalog();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0]["name"], "show");
        assert_eq!(catalog[0]["inputSchema"]["type"], "object");
        assert_eq!(catalog[0]["inputSchema"]["required"][0], "targets");
    }

    #[test]
    fn targets_accept_strings_objects_and_single_paths() {
        let args = json!({ "targets": ["a.txt", { "path": "b.docx" }, { "url": "http://localhost:5173" }] });
        assert_eq!(
            targets_from_args(&args),
            vec!["a.txt", "b.docx", "http://localhost:5173"]
        );
        assert_eq!(targets_from_args(&json!({ "path": "c.md" })), vec!["c.md"]);
        assert_eq!(
            targets_from_args(&json!({ "items": [{ "url": "https://example.com" }] })),
            vec!["https://example.com"]
        );
    }

    #[test]
    fn relative_paths_resolve_against_the_session_cwd() {
        let directory = scratch("relative");
        let file = directory.join("report.docx");
        fs::write(&file, b"x").unwrap();
        let target = resolve_target("report.docx", directory.to_str()).unwrap();
        assert_eq!(target.kind, Kind::Office);
        assert_eq!(target.label(), "Word 文档");
        assert!(target.path.unwrap().is_file());
        let _ = fs::remove_file(file);
    }

    #[test]
    fn missing_paths_fail_with_a_readable_error() {
        let directory = scratch("missing");
        let error = resolve_target("nope.pptx", directory.to_str()).unwrap_err();
        assert!(error.contains("文件不存在"), "{error}");
    }

    #[test]
    fn urls_are_web_targets_and_other_schemes_are_refused() {
        let target = resolve_target("http://127.0.0.1:5173/app", None).unwrap();
        assert_eq!(target.kind, Kind::Web);
        assert_eq!(target.name, "127.0.0.1:5173/app");
        assert!(resolve_target("javascript:alert(1)", None).is_err());
        assert!(resolve_target("mailto:someone@example.com", None).is_err());
    }

    #[test]
    fn office_pdf_image_and_code_extensions_are_classified() {
        assert_eq!(kind_of_path(Path::new("a.docx")), Kind::Office);
        assert_eq!(kind_of_path(Path::new("a.pptx")), Kind::Office);
        assert_eq!(kind_of_path(Path::new("a.xlsx")), Kind::Office);
        assert_eq!(kind_of_path(Path::new("a.pdf")), Kind::Pdf);
        assert_eq!(kind_of_path(Path::new("a.PNG")), Kind::Image);
        assert_eq!(kind_of_path(Path::new("a.rs")), Kind::Text);
        assert_eq!(kind_of_path(Path::new("a.bin")), Kind::File);
    }

    #[test]
    fn dispatch_reports_a_summary_and_details() {
        let directory = scratch("dispatch");
        let file = directory.join("report.docx");
        fs::write(&file, b"x").unwrap();
        let result = dispatch(
            "show",
            &json!({ "targets": ["report.docx"], "title": "审阅" }),
            directory.to_str(),
        )
        .unwrap();
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("已准备 1 项预览"), "{text}");
        assert!(text.contains("Word 文档"), "{text}");
        assert_eq!(result["details"]["title"], "审阅");
        assert_eq!(result["details"]["targets"][0]["kind"], "office");
        let _ = fs::remove_file(file);
    }

    #[test]
    fn dispatch_refuses_when_any_target_is_invalid() {
        let directory = scratch("invalid");
        let file = directory.join("ok.txt");
        fs::write(&file, b"ok").unwrap();
        let error = dispatch(
            "show",
            &json!({ "targets": ["ok.txt", "missing.txt"] }),
            directory.to_str(),
        )
        .unwrap_err();
        assert!(error.contains("missing.txt"), "{error}");
        let _ = fs::remove_file(file);
    }
}
