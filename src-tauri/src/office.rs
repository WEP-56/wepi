//! OfficeCLI 的 HTML 预览与选区截图。
//!
//! WEPI 不把 Office 转 PDF：OfficeCLI 直接把 docx/pptx/xlsx 渲染成
//! 单文件 HTML，DOM 里带 data-page/data-slide/data-path，前端据此做
//! 段落/单元格吸附。
//!
//! 这条路径不依赖本机 Word/Office：OfficeCLI 自己解析 OOXML，WPS 用户
//! 也能预览。复杂版式仍可能不完整，所以预览页保留「用系统应用打开」。

use serde_json::{json, Value};
use std::{
    collections::hash_map::DefaultHasher,
    env, fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::UNIX_EPOCH,
};

/// HTML 是整篇文档的字符串，给一个比文本预览更宽的上限；超过就退回系统打开。
const HTML_LIMIT: u64 = 16 * 1024 * 1024;
/// OfficeCLI 目前只认 OOXML；.doc/.xls/.ppt 等旧格式交给系统应用。
const OFFICE_EXTENSIONS: &[&str] = &["docx", "docm", "pptx", "pptm", "xlsx", "xlsm"];

pub fn is_supported(path: &Path) -> bool {
    path.extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|extension| OFFICE_EXTENSIONS.contains(&extension.as_str()))
}

/// `show_preview` 的 Office 分支：成功返回 `kind: "html"`，失败返回
/// `kind: "unsupported"`，让前端始终有「系统打开」的兜底。
pub fn preview(path: &Path, display: &str, size: u64) -> Value {
    if !is_supported(path) {
        return unsupported(
            display,
            size,
            "该 Office 格式暂不支持内嵌预览，请用「用系统应用打开」。",
        );
    }
    match render_html(path) {
        Ok(html) => json!({
            "kind": "html",
            "path": display,
            "html": html,
            "size": size,
            "renderer": "officecli"
        }),
        Err(error) => unsupported(display, size, format!("OfficeCLI 预览失败：{error}")),
    }
}

fn render_html(path: &Path) -> Result<String, String> {
    let key = cache_key(path, "");
    let cache = cache_dir().join(format!("{key}.html"));
    if cache.is_file() {
        if let Ok(html) = fs::read_to_string(&cache) {
            if html.len() as u64 <= HTML_LIMIT {
                return Ok(html);
            }
        }
    }

    let exe = officecli()?;
    let out = temp_dir("wepi-office-html").join(format!("{key}.html"));
    let _ = fs::remove_file(&out);
    let mut command = command(&exe);
    command
        .arg("view")
        .arg(path)
        .arg("html")
        .arg("-o")
        .arg(&out)
        .arg("--json");
    let output = command
        .output()
        .map_err(|error| format!("无法启动 OfficeCLI：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "OfficeCLI 退出码 {}：{}",
            output.status,
            stderr(&output.stderr)
        ));
    }
    let payload = parse_json(&output.stdout)?;
    if payload.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(payload
            .get("error")
            .and_then(|error| error.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("OfficeCLI 未返回 HTML")
            .to_owned());
    }

    let html =
        fs::read_to_string(&out).map_err(|error| format!("无法读取 OfficeCLI 输出：{error}"))?;
    let _ = fs::remove_file(&out);
    if html.len() as u64 > HTML_LIMIT {
        return Err("OfficeCLI 输出的 HTML 超过 16 MB".to_owned());
    }
    if let Some(parent) = cache.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&cache, &html);
    Ok(html)
}

fn parse_json(bytes: &[u8]) -> Result<Value, String> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    if text.is_empty() {
        return Err("OfficeCLI 没有返回 JSON".to_owned());
    }
    serde_json::from_str(text).map_err(|error| format!("OfficeCLI 返回的 JSON 无法解析：{error}"))
}

fn stderr(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    if text.is_empty() {
        "无错误输出".to_owned()
    } else {
        text.chars().take(800).collect()
    }
}

fn unsupported(path: &str, size: u64, message: impl Into<String>) -> Value {
    json!({
        "kind": "unsupported",
        "path": path,
        "size": size,
        "message": message.into()
    })
}

fn command(exe: &Path) -> Command {
    let mut command = Command::new(exe);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    crate::no_window(&mut command);
    command
}

fn officecli() -> Result<PathBuf, String> {
    if let Ok(value) = env::var("WEPI_OFFICECLI") {
        let path = PathBuf::from(value.trim().trim_matches('"'));
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(local) = env::var("LOCALAPPDATA") {
        for relative in [
            "OfficeCLI\\officecli.exe",
            "Programs\\OfficeCLI\\officecli.exe",
        ] {
            let path = PathBuf::from(&local).join(relative);
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(base) = env::var(variable) {
            let path = PathBuf::from(base).join("OfficeCLI").join("officecli.exe");
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    if let Some(path) = crate::pi_runtime::find_on_path("officecli") {
        return Ok(path);
    }
    Err("未找到 OfficeCLI。请安装 OfficeCLI，或设置 WEPI_OFFICECLI 指向 officecli.exe".to_owned())
}

fn cache_key(path: &Path, extra: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    extra.hash(&mut hasher);
    if let Ok(metadata) = fs::metadata(path) {
        metadata.len().hash(&mut hasher);
        if let Ok(modified) = metadata.modified() {
            if let Ok(elapsed) = modified.duration_since(UNIX_EPOCH) {
                elapsed.as_millis().hash(&mut hasher);
            }
        }
    }
    format!("{:016x}", hasher.finish())
}

fn cache_dir() -> PathBuf {
    env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
        .join("wepi")
        .join("cache")
        .join("office-html")
}

fn temp_dir(name: &str) -> PathBuf {
    let path = env::temp_dir().join(name);
    let _ = fs::create_dir_all(&path);
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ooxml_is_rendered_by_officecli() {
        assert!(is_supported(Path::new("a.docx")));
        assert!(is_supported(Path::new("a.PPTX")));
        assert!(is_supported(Path::new("a.xlsx")));
        assert!(!is_supported(Path::new("a.pdf")));
        assert!(!is_supported(Path::new("a.doc")));
    }

    #[test]
    fn cache_key_changes_with_selection_range() {
        let path = Path::new("a.docx");
        assert_ne!(cache_key(path, "/body/p[1]"), cache_key(path, "/body/p[2]"));
    }

    /// 手动烟测：`WEPI_OFFICE_SAMPLE=...docx cargo test office::tests::smoke -- --ignored`
    #[test]
    #[ignore = "需要本机安装 OfficeCLI，并提供一份 DOCX"]
    fn smoke_officecli_html() {
        let path = std::env::var("WEPI_OFFICE_SAMPLE").expect("缺少 WEPI_OFFICE_SAMPLE");
        let path = Path::new(&path);
        let preview = preview(path, &path.to_string_lossy(), 0);
        assert_eq!(preview["kind"], "html");
        assert!(preview["html"]
            .as_str()
            .unwrap_or_default()
            .contains("data-path"));
    }
}
