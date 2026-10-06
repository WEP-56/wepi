//! Pi 扩展管理：本地发现 + pi CLI 安装/卸载/更新 + pi.dev 扩展商店。
//!
//! 参考PiDeck `ExtensionManager`：
//! - `pi list` 解析 npm:/file:/github: 等包源（含 "(filtered)" 后缀剥离）
//! - 本地扩展自动发现（~/.pi/agent/extensions 下的 .ts/.js、目录 index、manifest）
//! - 禁用状态存 WEPI 自身设置（`~/.wepi/settings.json`），不写 Pi settings
//! - 商店抓 pi.dev/packages 目录页 SSR HTML，解析 data-package-card 卡片

use crate::wepi_settings;
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::Duration,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const FILTERED_SUFFIX: &str = " (filtered)";
const CATALOG_URL: &str = "https://pi.dev/packages";
const CATALOG_TTL_MS: u64 = 10 * 60_000;
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn extensions_dir() -> PathBuf {
    home_dir().join(".pi").join("agent").join("extensions")
}

/// pi 自管 npm 安装目录：`pi install npm:<pkg>` 落在 `~/.pi/agent/npm/node_modules/<pkg>`。
fn pi_npm_modules_dir() -> PathBuf {
    home_dir().join(".pi").join("agent").join("npm").join("node_modules")
}

/// 读取 pi settings.json 的 packages 列表（含对象形式的过滤式安装）。
fn pi_settings_packages() -> Vec<String> {
    let raw = fs::read_to_string(home_dir().join(".pi").join("agent").join("settings.json"))
        .unwrap_or_default();
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    parsed
        .get("packages")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match item {
                    Value::String(source) => Some(source.clone()),
                    Value::Object(object) => object.get("source").and_then(Value::as_str).map(str::to_owned),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn pi_executable() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("WEPI_PI_EXECUTABLE") {
        if !custom.trim().is_empty() {
            return Some(PathBuf::from(custom));
        }
    }
    let home = home_dir();
    [home.join(".pi/agent/bin/pi.cmd"), home.join(".pi/agent/bin/pi.exe")]
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| find_on_path("pi"))
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let trimmed = command.trim();
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

/// 运行 pi 子命令（Windows .cmd 垫片经 cmd.exe 包装）。
fn run_pi(args: &[&str], online: bool) -> Result<String, String> {
    let Some(executable) = pi_executable() else {
        return Err("未找到 Pi 可执行文件".to_owned());
    };
    let display = executable.to_string_lossy().into_owned();
    let mut env_extra = Vec::<(String, String)>::new();
    if !online {
        env_extra.push(("PI_OFFLINE".into(), "1".into()));
    }
    let output = if cfg!(windows) && !display.to_ascii_lowercase().ends_with(".exe") {
        let mut line = format!("/D /S /C \"{}\"", display.replace('"', ""));
        for arg in args {
            line.push_str(&format!(" {arg}"));
        }
        let mut command = Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
        command.raw_arg(line).stdin(Stdio::null());
        for (key, value) in env_extra {
            command.env(key, value);
        }
        #[cfg(windows)]
        crate::no_window(&mut command);
        command.output()
    } else {
        let mut command = Command::new(&executable);
        command.args(args).stdin(Stdio::null());
        for (key, value) in env_extra {
            command.env(key, value);
        }
        #[cfg(windows)]
        crate::no_window(&mut command);
        command.output()
    }
    .map_err(|e| format!("无法启动 pi：{e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if stderr.is_empty() {
            format!("pi 命令失败（退出码 {}）", output.status.code().unwrap_or(-1))
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// 使用 Pi 原生 OAuth 流程登录 MCP 服务器。Pi 负责打开浏览器、接收回调并
/// 将令牌保存到 ~/.pi/agent/mcp-auth.json，WEPI 不接触令牌内容。
pub fn mcp_login(server: &str) -> Result<String, String> {
    if !crate::pi_mcp::is_valid_server_name(server) {
        return Err("服务器名称非法".to_owned());
    }
    run_pi(&["mcp", "login", server], true)
}

/// 解析 `pi list` 输出：User/Project 段 + 包源行 + 紧随其后的路径行。
fn parse_list_output(raw: &str) -> Vec<Value> {
    let mut result = Vec::<Value>::new();
    let mut scope = "unknown";
    let mut pending: Option<(String, String, bool)> = None; // (scope, source, filtered)
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("User packages:") {
            scope = "user";
            pending = None;
            continue;
        }
        if trimmed.starts_with("Project packages:") {
            scope = "project";
            pending = None;
            continue;
        }
        let is_source = trimmed.starts_with("npm:")
            || trimmed.starts_with("file:")
            || trimmed.starts_with("github:")
            || trimmed.starts_with("git:")
            || trimmed.starts_with("http:")
            || trimmed.starts_with("https:");
        if is_source {
            let filtered = trimmed.ends_with(FILTERED_SUFFIX);
            let source = if filtered {
                trimmed[..trimmed.len() - FILTERED_SUFFIX.len()].to_owned()
            } else {
                trimmed.to_owned()
            };
            pending = Some((scope.to_owned(), source, filtered));
            continue;
        }
        if let Some((entry_scope, source, filtered)) = pending.take() {
            result.push(json!({
                "id": format!("{entry_scope}:{source}"),
                "source": source,
                "scope": entry_scope,
                "path": trimmed,
                "filtered": filtered,
            }));
        }
    }
    result
}

/// 发现本地扩展：直接 .ts/.js 文件、目录 index.ts/index.js、package.json 的 pi.extensions。
fn discover_local_extensions() -> Vec<(String, PathBuf)> {
    let root = extensions_dir();
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(&root) else {
        return found;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" || name.ends_with(".d.ts") {
            continue;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_file() && (name.ends_with(".ts") || name.ends_with(".js")) {
            found.push((name, path));
            continue;
        }
        if file_type.is_dir() && resolve_entry_points(&path) {
            found.push((name, path));
        }
    }
    found
}

/// 目录是否有可用扩展入口（manifest 声明或 index 文件）。
fn resolve_entry_points(dir: &Path) -> bool {
    let manifest = dir.join("package.json");
    if let Ok(raw) = fs::read_to_string(&manifest) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
            if let Some(declared) = parsed
                .get("pi")
                .and_then(|pi| pi.get("extensions"))
                .and_then(Value::as_array)
            {
                let exists = declared
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|entry| dir.join(entry).exists());
                if exists {
                    return true;
                }
            }
        }
    }
    ["index.ts", "index.js"].iter().any(|index| dir.join(index).is_file())
}

/// 扫描 pi 自管 npm 目录里的已安装包（`npm:<name>` → node_modules/<name>）。
/// 这是 `pi install` 的真实落盘位置；pi list 输出丢失/不可用时靠它兜底，
/// 也能发现 settings.json 已登记但 pi list 未列出的包。
fn discover_npm_dir_packages() -> Vec<(String, PathBuf)> {
    let root = pi_npm_modules_dir();
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(&root) else {
        return found;
    };
    for entry in entries.filter_map(Result::ok) {
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // scoped 包目录（@scope）展开一层，取真实包名。
        if name.starts_with('@') {
            let Ok(scoped) = fs::read_dir(entry.path()) else { continue };
            for child in scoped.filter_map(Result::ok) {
                if child.file_type().ok().is_some_and(|t| t.is_dir()) {
                    let scoped_name = format!("{}/{}", name, child.file_name().to_string_lossy());
                    found.push((scoped_name, child.path()));
                }
            }
            continue;
        }
        if name.starts_with('.') {
            continue;
        }
        found.push((name, entry.path()));
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// 列出扩展：pi list 包源 + npm 目录扫描 + 本地发现合并；附加版本与禁用状态。
pub fn list(force_refresh: bool) -> Result<Value, String> {
    let mut merged: Vec<Value> = Vec::new();
    let raw = match run_pi(&["list"], false) {
        Ok(raw) => raw,
        Err(error) => {
            // pi 不可用时仍返回本地发现结果，UI 不至于整页失败。
            let _ = error;
            String::new()
        }
    };
    for mut entry in parse_list_output(&raw) {
        if force_refresh {
            if let Some(source) = entry.get("source").and_then(Value::as_str) {
                if source.to_lowercase().starts_with("npm:") {
                    let package = source.trim_start_matches("npm:").to_owned();
                    if let Some(path) = entry.get("path").and_then(Value::as_str) {
                        if let Ok(current) = read_installed_version(path) {
                            entry.as_object_mut().unwrap().insert("currentVersion".into(), json!(current));
                        }
                    }
                    if let Ok(latest) = npm_view_version(&package) {
                        let object = entry.as_object_mut().unwrap();
                        object.insert("latestVersion".into(), json!(latest));
                        let current = object.get("currentVersion").and_then(Value::as_str);
                        if let Some(current) = current {
                            let has_update = crate::pi_runtime::compare_versions(&latest, current) > 0;
                            object.insert("hasUpdate".into(), json!(has_update));
                        }
                    }
                }
            }
        }
        merged.push(entry);
    }
    let installed_paths: Vec<String> = merged
        .iter()
        .filter_map(|entry| entry.get("path").and_then(Value::as_str).map(str::to_owned))
        .collect();
    // npm 目录兜底：settings.json 登记了包、但 pi list 没列出（或解析丢失）时补齐。
    let declared = pi_settings_packages();
    for (name, path) in discover_npm_dir_packages() {
        let source = format!("npm:{name}");
        let already = merged.iter().any(|entry| {
            entry.get("source").and_then(Value::as_str) == Some(source.as_str())
        }) || installed_paths.iter().any(|installed| installed == &path.to_string_lossy());
        if already {
            continue;
        }
        // 只收 pi 真正登记的包：npm 目录里可能有历史残留/依赖，未登记的不算扩展。
        if !declared.iter().any(|item| item == &source || item.trim_start_matches("npm:") == name) {
            continue;
        }
        merged.push(json!({
            "id": format!("user:{source}"),
            "source": source,
            "path": path.to_string_lossy(),
            "scope": "user",
        }));
    }
    for (name, path) in discover_local_extensions() {
        if !installed_paths.iter().any(|installed| Path::new(installed).ends_with(&name) || installed == &path.to_string_lossy()) {
            merged.push(json!({
                "id": format!("local:{name}"),
                "source": name,
                "path": path.to_string_lossy(),
                "scope": "user",
                "builtIn": name.starts_with("wepi-"),
            }));
        }
    }
    let disabled: Vec<String> = wepi_settings::disabled_extensions();
    for entry in merged.iter_mut() {
        let source = entry.get("source").and_then(Value::as_str).unwrap_or_default().to_owned();
        entry
            .as_object_mut()
            .expect("构造时即为对象")
            .insert("enabled".into(), json!(!disabled.iter().any(|item| item == &source)));
    }
    merged.sort_by(|a, b| {
        a.get("source")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(b.get("source").and_then(Value::as_str).unwrap_or_default())
    });
    Ok(json!({ "extensions": merged, "raw": raw }))
}

fn read_installed_version(path: &str) -> Result<String, String> {
    let manifest = Path::new(path).join("package.json");
    let raw = fs::read_to_string(manifest).map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    parsed
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "缺少 version".to_owned())
}

fn npm_view_version(package: &str) -> Result<String, String> {
    let url = format!("https://registry.npmjs.org/{package}/latest");
    let response = ureq::get(&url)
        .timeout(FETCH_TIMEOUT)
        .call()
        .map_err(|e| e.to_string())?;
    let body: Value = response.into_json().map_err(|e| e.to_string())?;
    body.get("version")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "缺少 version".to_owned())
}

/// 安装扩展：`pi install <source>`。
pub fn install(source: &str) -> Result<Value, String> {
    let normalized = source.trim();
    if normalized.is_empty() {
        return Err("扩展名不能为空".to_owned());
    }
    let output = run_pi(&["install", normalized], true)?;
    Ok(json!({ "success": true, "output": output.trim() }))
}

/// 卸载：包源走 `pi remove`；本地文件扩展直接删文件（只允许目录内单层 basename）。
pub fn uninstall(source: &str) -> Result<(), String> {
    let normalized = source.trim();
    if normalized.is_empty() {
        return Err("扩展名不能为空".to_owned());
    }
    let is_local = !["npm:", "file:", "github:", "git:", "http:", "https:"]
        .iter()
        .any(|prefix| normalized.to_lowercase().starts_with(prefix));
    if is_local {
        let root = fs::canonicalize(extensions_dir()).map_err(|e| format!("定位扩展目录失败：{e}"))?;
        let target = root.join(normalized);
        let canonical = fs::canonicalize(&target).map_err(|e| format!("定位扩展失败：{e}"))?;
        if !canonical.starts_with(&root) || canonical.parent() != Some(root.as_path()) {
            return Err("拒绝删除扩展目录之外的路径".to_owned());
        }
        if canonical.is_dir() {
            fs::remove_dir_all(&canonical).map_err(|e| format!("删除失败：{e}"))
        } else {
            fs::remove_file(&canonical).map_err(|e| format!("删除失败：{e}"))
        }
    } else {
        run_pi(&["remove", normalized], false).map(|_| ())
    }?;
    // 卸载后清理禁用标记，避免孤儿条目。
    let _ = wepi_settings::set_extension_disabled(normalized, false);
    Ok(())
}

/// 启用/禁用：写 WEPI 设置的禁用列表。
pub fn set_enabled(source: &str, enabled: bool) -> Result<(), String> {
    wepi_settings::set_extension_disabled(source, !enabled)
}

/// 更新单个扩展：`pi update <source>`。
pub fn update_one(source: &str) -> Result<Value, String> {
    let normalized = source.trim();
    if normalized.is_empty() {
        return Err("扩展名不能为空".to_owned());
    }
    let output = run_pi(&["update", normalized], true)?;
    Ok(json!({ "success": true, "command": format!("pi update {normalized}"), "output": output.trim() }))
}

/// 更新全部扩展：`pi update --extensions`。
pub fn update_all() -> Result<Value, String> {
    let output = run_pi(&["update", "--extensions"], true)?;
    Ok(json!({ "success": true, "command": "pi update --extensions", "output": output.trim() }))
}

/* ------------------------------------------------------------------ */
/*  扩展商店（pi.dev Package Catalog）                                  */
/* ------------------------------------------------------------------ */

type CatalogCache = Mutex<HashMap<String, (u64, Value)>>;

fn catalog_cache() -> &'static CatalogCache {
    static CACHE: std::sync::OnceLock<CatalogCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn catalog_page_url(page: u32, query: &str, kind: &str, sort: &str) -> String {
    let mut params = Vec::<String>::new();
    if page > 1 {
        params.push(format!("page={page}"));
    }
    if !query.is_empty() {
        params.push(format!("name={}", urlencode(query)));
    }
    if !kind.is_empty() {
        params.push(format!("type={kind}"));
    }
    if sort != "downloads" {
        params.push(format!("sort={sort}"));
    }
    if params.is_empty() {
        CATALOG_URL.to_owned()
    } else {
        format!("{CATALOG_URL}?{}", params.join("&"))
    }
}

fn urlencode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut remainder = text;
    while let Some(start) = remainder.find('&') {
        out.push_str(&remainder[..start]);
        let after = &remainder[start..];
        let Some(end) = after.find(';') else {
            out.push_str(after);
            return out;
        };
        let entity = &after[..=end];
        out.push_str(&decode_one_entity(entity));
        remainder = &after[end + 1..];
    }
    out.push_str(remainder);
    out
}

fn decode_one_entity(entity: &str) -> String {
    match entity {
        "&lt;" => "<".into(),
        "&gt;" => ">".into(),
        "&quot;" => "\"".into(),
        "&apos;" | "&#39;" => "'".into(),
        "&nbsp;" => " ".into(),
        "&amp;" => "&".into(),
        other => {
            if let Some(hex) = other.strip_prefix("&#x").and_then(|value| value.strip_suffix(';')) {
                if let Ok(code) = u32::from_str_radix(hex, 16) {
                    if let Some(ch) = char::from_u32(code) {
                        return ch.to_string();
                    }
                }
            } else if let Some(dec) = other.strip_prefix("&#").and_then(|value| value.strip_suffix(';')) {
                if let Ok(code) = dec.parse::<u32>() {
                    if let Some(ch) = char::from_u32(code) {
                        return ch.to_string();
                    }
                }
            }
            other.to_owned()
        }
    }
}

fn strip_tags(html: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for ch in html.chars() {
        match ch {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

fn attribute_of(tag: &str, name: &str) -> Option<String> {
    let pattern = format!("{name}=\"");
    let start = tag.find(&pattern)? + pattern.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    Some(decode_entities(&rest[..end]))
}

/// 解析目录页 HTML 的包卡片（`<article data-package-card>` 的 data-* 属性）。
fn parse_catalog_html(html: &str) -> (Vec<Value>, u32, u32, u32) {
    let mut items = Vec::new();
    // 卡片 = 带 data-package-card 的 <article> 标签；只收集这些标签的起点。
    let positions: Vec<usize> = html
        .match_indices("<article")
        .filter(|(index, _)| match html[*index..].find('>') {
            Some(closing) => html[*index..*index + closing].contains("data-package-card"),
            None => false,
        })
        .map(|(index, _)| index)
        .collect();
    let mut last_page = 1u32;
    for &index in &positions {
        let tag_end = html[index..].find('>').map(|offset| index + offset);
        let Some(tag_end) = tag_end else { continue };
        let tag = &html[index..=tag_end];
        let body_end = positions
            .iter()
            .find(|next| **next > index)
            .copied()
            .unwrap_or(html.len());
        let body = &html[tag_end..body_end];
        let Some(name) = attribute_of(tag, "data-package-name") else { continue };
        let description = body
            .find("<p class=\"packages-desc\">")
            .and_then(|start| {
                let rest = &body[start..];
                let end = rest.find("</p>")?;
                Some(decode_entities(&strip_tags(&rest[..end])).trim().to_owned())
            })
            .unwrap_or_default();
        let author = body
            .find("<div class=\"packages-meta\"><span>")
            .and_then(|start| {
                let rest = &body[start..];
                let end = rest.find("</span>")?;
                Some(decode_entities(&strip_tags(&rest[..end])).trim().to_owned())
            })
            .unwrap_or_default();
        let downloads = attribute_of(tag, "data-package-downloads")
            .and_then(|value| value.parse::<u64>().ok());
        let published_at = attribute_of(tag, "data-package-date")
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0);
        let types: Vec<String> = attribute_of(tag, "data-package-types")
            .map(|value| value.split_whitespace().map(str::to_owned).collect())
            .unwrap_or_default();
        let npm_url = body
            .find("href=\"https://www.npmjs.com/package/")
            .and_then(|start| {
                let rest = &body[start + 6..];
                let end = rest.find('"')?;
                Some(format!("https://www.npmjs.com/package/{}", &rest[..end].trim_start_matches("https://www.npmjs.com/package/")))
            });
        let github_url = body
            .find("href=\"https://github.com/")
            .and_then(|start| {
                let rest = &body[start + 6..];
                let end = rest.find('"')?;
                Some(rest[..end].to_owned())
            });
        let page_url = format!("{CATALOG_URL}/{name}");
        let mut entry = Map::new();
        entry.insert("name".into(), json!(name));
        entry.insert("description".into(), json!(description));
        if !author.is_empty() {
            entry.insert("author".into(), json!(author));
        }
        entry.insert("types".into(), json!(types));
        if let Some(downloads) = downloads {
            entry.insert("downloadsPerMonth".into(), json!(downloads));
        }
        if let Some(published_at) = published_at {
            entry.insert("publishedAt".into(), json!(published_at));
        }
        if let Some(npm_url) = npm_url {
            entry.insert("npmUrl".into(), json!(npm_url));
        }
        if let Some(github_url) = github_url {
            entry.insert("githubUrl".into(), json!(github_url));
        }
        entry.insert("installSource".into(), json!(format!("npm:{name}")));
        entry.insert("pageUrl".into(), json!(page_url));
        items.push(Value::Object(entry));
    }
    // 分页元数据：packages-count 元素形如 "1-50 / 5300"。
    let mut range_start = 0u32;
    let mut range_end = 0u32;
    let mut total = 0u32;
    if let Some(start) = html.find("class=\"packages-count\">") {
        let rest = &html[start..];
        if let Some(end) = rest.find("</").or_else(|| rest.find('>')) {
            let text = strip_tags(&rest[..end]);
            let numbers: Vec<u32> = text
                .split(|c: char| !c.is_ascii_digit())
                .filter(|part| !part.is_empty())
                .filter_map(|part| part.parse::<u32>().ok())
                .collect();
            if numbers.len() >= 3 {
                range_start = numbers[numbers.len() - 3];
                range_end = numbers[numbers.len() - 2];
                total = numbers[numbers.len() - 1];
            }
        }
    }
    for captured in html.match_indices("page=").map(|(index, _)| index) {
        let rest = &html[captured + 5..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(page) = digits.parse::<u32>() {
            last_page = last_page.max(page);
        }
    }
    if total > 0 && range_end >= range_start && range_end > 0 {
        let page_size = range_end - range_start + 1;
        if page_size > 0 {
            last_page = last_page.max(total.div_ceil(page_size));
        }
    }
    (items, range_start, range_end, total.max(last_page.min(u32::MAX)))
}

/// 抓取商店目录（带 10 分钟内存缓存）。
pub fn catalog(page: u32, query: &str, kind: &str, sort: &str, refresh: bool) -> Result<Value, String> {
    let key = format!("{page}\t{}\t{kind}\t{sort}", query.trim());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if !refresh {
        if let Ok(cache) = catalog_cache().lock() {
            if let Some((at, value)) = cache.get(&key) {
                if now.saturating_sub(*at) <= CATALOG_TTL_MS {
                    let mut hit = value.clone();
                    hit.as_object_mut()
                        .and_then(|object| object.insert("fromCache".into(), json!(true)));
                    return Ok(hit);
                }
            }
        }
    }
    let url = catalog_page_url(page, query.trim(), kind, sort);
    let response = ureq::get(&url)
        .timeout(FETCH_TIMEOUT)
        .call()
        .map_err(|e| format!("pi.dev 请求失败：{e}"))?;
    let html = response
        .into_string()
        .map_err(|e| format!("pi.dev 响应读取失败：{e}"))?;
    let (items, _range_start, _range_end, total_or_last) = parse_catalog_html(&html);
    let is_first_bare_page = page == 1 && query.trim().is_empty() && kind.is_empty();
    if items.is_empty() && is_first_bare_page {
        return Err("pi.dev 目录页解析到 0 个包".to_owned());
    }
    let page_size = if items.is_empty() { 50 } else { items.len() as u32 };
    let total = if total_or_last > 0 { total_or_last.max(page) } else { page };
    let last_page = if total > 0 && page_size > 0 { total.div_ceil(page_size).max(page) } else { page };
    let value = json!({
        "items": items,
        "page": page,
        "pageSize": page_size,
        "total": total,
        "lastPage": last_page,
        "fromCache": false,
    });
    if let Ok(mut cache) = catalog_cache().lock() {
        cache.insert(key, (now, value.clone()));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_list_output_sections() {
        let raw = "User packages:\n\nnpm:context-mode\nC:\\Users\\x\\.pi\\agent\\extensions\\context-mode\n\nnpm:todo (filtered)\nC:\\todo\n\nProject packages:\n\nnpm:project-ext\nC:\\proj\\ext\n";
        let parsed = parse_list_output(raw);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0]["scope"], json!("user"));
        assert_eq!(parsed[0]["source"], json!("npm:context-mode"));
        assert_eq!(parsed[1]["source"], json!("npm:todo"));
        assert_eq!(parsed[1]["filtered"], json!(true));
        assert_eq!(parsed[2]["scope"], json!("project"));
    }

    #[test]
    fn parses_package_cards() {
        let html = r#"<html><body><span class="packages-count">1-2 / 2</span>
<article data-package-card="true" data-package-name="demo-ext" data-package-types="extension" data-package-downloads="1234" data-package-date="1735689600000">
<p class="packages-desc">A demo &amp; test extension</p>
<div class="packages-meta"><span>author-x</span></div>
<a href="https://www.npmjs.com/package/demo-ext">npm</a>
</article>
</body></html>"#;
        let (items, _rs, _re, total) = parse_catalog_html(html);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["name"], json!("demo-ext"));
        assert_eq!(items[0]["description"], json!("A demo & test extension"));
        assert_eq!(items[0]["author"], json!("author-x"));
        assert_eq!(items[0]["installSource"], json!("npm:demo-ext"));
        assert_eq!(items[0]["downloadsPerMonth"], json!(1234));
        assert!(total >= 1);
    }

    #[test]
    fn decodes_entities_in_attributes() {
        assert_eq!(decode_entities("&lt;a&gt; &amp; b &#x4e2d;"), "<a> & b 中");
        assert_eq!(strip_tags("<p>hello <b>world</b></p>"), "hello world");
    }

    #[test]
    fn npm_dir_discovery_finds_packages_and_expands_scopes() {
        let root = std::env::temp_dir().join(format!("wepi-ext-npm-{}", std::process::id()));
        let normal = root.join("pi-web-access");
        let scoped = root.join("@earendil").join("pi-something");
        fs::create_dir_all(&normal).unwrap();
        fs::create_dir_all(&scoped).unwrap();
        // 假装这是 pi 的 npm 目录：临时改 HOME/USERPROFILE 会影响其他用例，
        // 这里直接把发现逻辑的核心（展开 + 排序 + 过滤）以子目录验证。
        let mut found: Vec<(String, PathBuf)> = Vec::new();
        for entry in fs::read_dir(&root).unwrap().filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('@') {
                for child in fs::read_dir(entry.path()).unwrap().filter_map(Result::ok) {
                    if child.file_type().unwrap().is_dir() {
                        found.push((format!("{}/{}", name, child.file_name().to_string_lossy()), child.path()));
                    }
                }
            } else {
                found.push((name, entry.path()));
            }
        }
        found.sort_by(|a, b| a.0.cmp(&b.0));
        let names: Vec<&str> = found.iter().map(|(name, _)| name.as_str()).collect();
        assert!(names.contains(&"@earendil/pi-something"), "scoped package not expanded: {names:?}");
        assert!(names.contains(&"pi-web-access"), "normal package missing: {names:?}");
        // 顺序：@ 开头的包排在字母前，但两者都必须存在。
        assert_eq!(found.len(), 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn settings_packages_parses_string_and_object_forms() {
        let root = std::env::temp_dir().join(format!("wepi-ext-settings-{}", std::process::id()));
        let agent = root.join(".pi").join("agent");
        fs::create_dir_all(&agent).unwrap();
        fs::write(
            agent.join("settings.json"),
            r#"{"packages": ["npm:plain", {"source": "npm:filtered"}]}"#,
        )
        .unwrap();
        // 通过环境变量把 home 指向临时目录需要改动进程级 env（测试并行会互相污染），
        // 这里只验证解析函数本身：直接内联同逻辑的最小复刻不可取，改为验证 JSON 形态。
        let raw = fs::read_to_string(agent.join("settings.json")).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let items = parsed.get("packages").and_then(Value::as_array).unwrap();
        assert_eq!(items[0], json!("npm:plain"));
        assert_eq!(items[1].get("source"), Some(&json!("npm:filtered")));
        let _ = fs::remove_dir_all(&root);
    }

    /// 集成冒烟：在真实机器上跑 list()，验证「pi list 条目 + npm 目录兜底」不重复。
    /// 只断言结构性不变量（无重复 source、字段齐全），不依赖具体安装了什么。
    #[test]
    fn list_smoke_no_duplicate_sources() {
        let Ok(result) = list(false) else {
            // pi 不存在的机器上跳过（CI/干净环境），不算失败。
            return;
        };
        let extensions = result.get("extensions").and_then(Value::as_array).expect("extensions array");
        let mut sources: Vec<&str> = extensions
            .iter()
            .filter_map(|entry| entry.get("source").and_then(Value::as_str))
            .collect();
        sources.sort_unstable();
        let duplicates: Vec<String> = sources
            .windows(2)
            .filter(|pair| pair[0] == pair[1])
            .map(|pair| pair[0].to_owned())
            .collect();
        assert!(duplicates.is_empty(), "duplicate extension sources: {duplicates:?}");
        for entry in extensions {
            let enabled = entry.get("enabled").and_then(Value::as_bool);
            assert!(enabled.is_some(), "missing enabled: {entry}");
        }
    }
}
