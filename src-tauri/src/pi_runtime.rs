//! Pi 可执行文件定位、版本检测、命令来源管理与环境诊断。
//!
//! 参考PiDeck `PiLocator` + `PiCommandSourcePanel`：
//! - 多安装候选扫描（managed 安装 / npm / pnpm / yarn / PATH）
//! - `--version` 探测与 npm registry 最新版比对
//! - 用户自加路径（`~/.wepi/settings.json` 的 customPiPaths）
//! - 环境诊断：node / npx / git / curl 可用性

use crate::wepi_settings;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const NPM_REGISTRY: &str = "https://registry.npmjs.org";
const PI_PACKAGE: &str = "@earendil-works/pi-coding-agent";
const VERSION_TIMEOUT_SECS: u64 = 15;

fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// 候选来源标签 → 路径列表（与 PiDeck PiLocator 的发现面一致）。
fn candidate_installations() -> Vec<(String, Vec<PathBuf>)> {
    let home = home_dir();
    let mut groups: Vec<(String, Vec<PathBuf>)> = Vec::new();
    let mut managed = Vec::new();
    for name in ["pi.cmd", "pi.exe", "pi"] {
        let path = home.join(".pi").join("agent").join("bin").join(name);
        if path.is_file() {
            managed.push(path);
            break;
        }
    }
    if !managed.is_empty() {
        groups.push(("Pi 官方 managed 安装".into(), managed));
    }
    let mut local_bin = Vec::new();
    let local = home.join(".local").join("bin");
    for name in ["pi.cmd", "pi.exe", "pi"] {
        let path = local.join(name);
        if path.is_file() {
            local_bin.push(path);
            break;
        }
    }
    if !local_bin.is_empty() {
        groups.push(("~/.local/bin".into(), local_bin));
    }
    let mut npm_dirs = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        let path = PathBuf::from(appdata).join("npm").join("pi.cmd");
        if path.is_file() {
            npm_dirs.push(path);
        }
    }
    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        let base = PathBuf::from(localappdata);
        for candidate in [("pnpm".to_owned(), "pi.cmd"), ("Yarn".to_owned(), "bin\\pi.cmd")] {
            let path = base.join(&candidate.0).join(candidate.1);
            if path.is_file() {
                npm_dirs.push(path);
            }
        }
    }
    if !npm_dirs.is_empty() {
        groups.push(("npm / pnpm / yarn 全局".into(), npm_dirs));
    }
    if let Some(path) = find_on_path("pi") {
        groups.push(("系统 PATH".into(), vec![path]));
    }
    groups
}

pub fn find_on_path(command: &str) -> Option<PathBuf> {
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

/// 运行 `pi --version`（或自定义路径），返回纯版本号。
fn probe_version(executable: &str) -> Result<String, String> {
    let trimmed = executable.trim();
    if trimmed.is_empty() {
        return Err("路径为空".to_owned());
    }
    let path = PathBuf::from(trimmed);
    let output = if cfg!(windows) && !trimmed.to_ascii_lowercase().ends_with(".exe") {
        // .cmd 垫片必须经 cmd.exe；raw_arg 避免二次转义。
        let mut command = Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
        command.raw_arg(format!("/D /S /C \"{}\" --version", trimmed.replace('"', "")))
            .stdin(Stdio::null());
        #[cfg(windows)]
        crate::no_window(&mut command);
        command.output()
    } else {
        let mut command = Command::new(&path);
        command.arg("--version").stdin(Stdio::null());
        #[cfg(windows)]
        crate::no_window(&mut command);
        command.output()
    }
    .map_err(|e| format!("无法启动：{e}"))?;
    if !output.status.success() {
        return Err(format!("退出码 {}", output.status.code().unwrap_or(-1)));
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let version = text
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix('v').map(str::to_owned).or_else(|| {
            // 直接匹配 x.y.z 形态。
            let found = line.split_whitespace().find(|token| looks_like_version(token))?;
            Some(found.to_owned())
        }))
        .unwrap_or(text);
    Ok(version)
}

fn looks_like_version(token: &str) -> bool {
    let cleaned = token.strip_prefix('v').unwrap_or(token);
    !cleaned.is_empty()
        && cleaned.split('.').count() >= 2
        && cleaned
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

/// 语义化版本比较：left < right 返回 -1，相等 0，大于 1。
pub fn compare_versions(left: &str, right: &str) -> i32 {
    let parse = |text: &str| -> Vec<u64> {
        text.trim()
            .trim_start_matches('v')
            .split(|c: char| c == '.' || c == '-')
            .filter(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
            .filter_map(|part| part.parse::<u64>().ok())
            .collect()
    };
    let left_parts = parse(left);
    let right_parts = parse(right);
    for index in 0..left_parts.len().max(right_parts.len()) {
        let l = left_parts.get(index).copied().unwrap_or(0);
        let r = right_parts.get(index).copied().unwrap_or(0);
        if l != r {
            return if l < r { -1 } else { 1 };
        }
    }
    0
}

/// npm registry 最新版本（拿不到时返回 Err，由 UI 降级展示）。
pub fn fetch_latest_version() -> Result<String, String> {
    let url = format!("{NPM_REGISTRY}/{PI_PACKAGE}/latest");
    let response = ureq::get(&url)
        .timeout(Duration::from_secs(VERSION_TIMEOUT_SECS))
        .call()
        .map_err(|e| format!("npm registry 请求失败：{e}"))?;
    let body: Value = response
        .into_json()
        .map_err(|e| format!("npm registry 响应解析失败：{e}"))?;
    body.get("version")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "响应缺少 version 字段".to_owned())
}

fn installation_entry(source: &str, path: &Path, version: Option<String>, missing: bool) -> Value {
    json!({
        "source": source,
        "path": path.to_string_lossy(),
        "version": version,
        "missing": missing,
    })
}

/// 扫描全部 Pi 安装：自动发现 + 用户自加；附带当前选中的可执行文件。
pub fn scan_installations() -> Result<Value, String> {
    let mut installations = Vec::<Value>::new();
    for (source, paths) in candidate_installations() {
        for path in paths {
            let version = probe_version(&path.to_string_lossy()).ok();
            installations.push(installation_entry(&source, &path, version, false));
        }
    }
    for path in wepi_settings::custom_pi_paths() {
        let exists = Path::new(&path).is_file();
        let version = if exists { probe_version(&path).ok() } else { None };
        installations.push(installation_entry("我添加的路径", Path::new(&path), version, !exists));
    }
    // 找出最高版本供前端标记「较旧」。
    let mut newest: Option<String> = None;
    for entry in &installations {
        if let Some(version) = entry.get("version").and_then(Value::as_str) {
            newest = Some(match newest {
                None => version.to_owned(),
                Some(current) => {
                    if compare_versions(version, &current) > 0 {
                        version.to_owned()
                    } else {
                        current
                    }
                }
            });
        }
    }
    for entry in installations.iter_mut() {
        let version = entry.get("version").and_then(Value::as_str).map(str::to_owned);
        if let (Some(version), Some(best)) = (version, newest.as_deref()) {
            entry
                .as_object_mut()
                .expect("构造时即为对象")
                .insert("isNewest".into(), Value::Bool(compare_versions(&version, best) >= 0));
        }
    }
    Ok(json!({ "installations": installations }))
}

/// 校验用户自加路径并写入设置。
pub fn add_custom_path(path: &str) -> Result<Value, String> {
    let trimmed = path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("路径不能为空".to_owned());
    }
    let version = probe_version(trimmed)?;
    wepi_settings::add_custom_pi_path(trimmed)?;
    Ok(json!({ "path": trimmed, "version": version }))
}

pub fn remove_custom_path(path: &str) -> Result<(), String> {
    wepi_settings::remove_custom_pi_path(path)
}

/// 检查 Pi 更新：本地版本 + npm 最新版。
pub fn check_update() -> Result<Value, String> {
    let installations = scan_installations()?;
    let current = installations
        .get("installations")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .filter(|item| item.get("version").is_some_and(Value::is_string))
                .find_map(|item| item.get("version").and_then(Value::as_str).map(str::to_owned))
        });
    let latest = match fetch_latest_version() {
        Ok(latest) => latest,
        Err(error) => {
            return Ok(json!({
                "currentVersion": current,
                "hasUpdate": false,
                "error": error,
            }))
        }
    };
    let has_update = current
        .as_deref()
        .map(|current| compare_versions(&latest, current) > 0)
        .unwrap_or(true);
    Ok(json!({
        "currentVersion": current,
        "latestVersion": latest,
        "hasUpdate": has_update,
    }))
}

/// 执行 Pi 自更新；成功后返回命令与输出。
pub fn update_pi() -> Result<Value, String> {
    let installations = scan_installations()?;
    let executable = installations
        .get("installations")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .filter(|item| item.get("version").is_some_and(Value::is_string))
                .find_map(|item| item.get("path").and_then(Value::as_str).map(str::to_owned))
        })
        .ok_or("未找到可用的 Pi 安装")?;
    // pi 0.84.3+ 用 `pi update --self`；旧版子命令是 `pi update pi`。
    let version = probe_version(&executable).unwrap_or_default();
    let args: Vec<String> = if compare_versions(&version, "0.84.3") >= 0 {
        vec!["update".into(), "--self".into()]
    } else {
        vec!["update".into(), "pi".into()]
    };
    let output = if cfg!(windows) && !executable.to_ascii_lowercase().ends_with(".exe") {
        let mut line = format!("/D /S /C \"{}\"", executable.replace('"', ""));
        for arg in &args {
            line.push_str(&format!(" {arg}"));
        }
        let mut command = Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
        command.raw_arg(line)
            .stdin(Stdio::null());
        #[cfg(windows)]
        crate::no_window(&mut command);
        command.output()
    } else {
        let mut command = Command::new(&executable);
        command.args(&args).stdin(Stdio::null());
        #[cfg(windows)]
        crate::no_window(&mut command);
        command.output()
    }
    .map_err(|e| format!("无法启动更新：{e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let command = format!("pi {}", args.join(" "));
    let combined = format!("{stdout}{stderr}");
    Ok(json!({
        "command": command,
        "output": combined.trim(),
        "updated": output.status.success(),
    }))
}

/// 环境诊断：关键工具可用性 + Pi 配置目录状态。
pub fn run_diagnostics() -> Result<Value, String> {
    let checks = vec![
        ("Pi CLI", find_on_path("pi").or_else(|| {
            let home = home_dir();
            [".pi/agent/bin/pi.cmd", ".pi/agent/bin/pi.exe"]
                .iter()
                .map(|relative| home.join(relative))
                .find(|path| path.is_file())
        }).is_some(), "运行 Agent 会话的必要组件"),
        ("Node.js", find_on_path("node").is_some() || find_node_install().is_some(), "Pi（npm 安装形态）的运行时"),
        ("npx", find_on_path("npx").is_some(), "技能商店一键安装使用 npx"),
        ("git", find_on_path("git").is_some(), "项目 Git 面板与 diff 功能"),
        ("curl", find_on_path("curl").is_some(), "MCP HTTP 连通性探测"),
    ];
    let pi_dir = home_dir().join(".pi").join("agent");
    let checks_json: Vec<Value> = checks
        .into_iter()
        .map(|(name, ok, purpose)| json!({ "name": name, "ok": ok, "purpose": purpose }))
        .collect();
    Ok(json!({
        "checks": checks_json,
        "agentDir": pi_dir.to_string_lossy(),
        "agentDirExists": pi_dir.is_dir(),
        "mcpConfigExists": pi_dir.join("mcp.json").is_file(),
        "modelsConfigExists": pi_dir.join("models.json").is_file(),
        "skillsDirExists": pi_dir.join("skills").is_dir(),
    }))
}

fn find_node_install() -> Option<PathBuf> {
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        let path = PathBuf::from(program_files).join("nodejs").join("node.exe");
        if path.is_file() {
            return Some(path);
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let path = PathBuf::from(local).join("Programs").join("nodejs").join("node.exe");
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_semver_correctly() {
        assert_eq!(compare_versions("0.79.0", "0.84.3"), -1);
        assert_eq!(compare_versions("1.0.0", "0.99.9"), 1);
        assert_eq!(compare_versions("2.1.0", "2.1.0"), 0);
        assert_eq!(compare_versions("v1.2.3-beta", "1.2.3"), 0);
    }

    #[test]
    fn recognizes_version_tokens() {
        assert!(looks_like_version("0.84.3"));
        assert!(looks_like_version("v1.2.3"));
        assert!(!looks_like_version("pi"));
        assert!(!looks_like_version("2026-01-01"));
    }
}
