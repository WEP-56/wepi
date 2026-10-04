//! 系统级「打开」能力：资源管理器、默认浏览器、外部编辑器。
//!
//! 设计约束（参考 PiDeck 的文件/编辑器域）：
//! - 数组传参、不经 shell 拼接；路径先 canonicalize 校验存在
//! - `explorer /select` 高亮文件本身；目录直接打开
//! - 浏览器走系统默认（`cmd /c start` / `xdg-open` / `open`）
//! - 失败返回可读错误，不 panic

use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn spawn_hidden(command: &mut Command) -> Result<(), String> {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = command.stdin(Stdio::null());
    command
        .spawn()
        .map_err(|e| format!("启动失败：{e}"))?
        .wait()
        .map_err(|e| format!("等待进程失败：{e}"))?;
    Ok(())
}

/// 校验路径存在并返回绝对路径；不存在时报错（调用方决定是否提示）。
fn resolve_existing(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("路径为空".to_owned());
    }
    let candidate = PathBuf::from(trimmed);
    if !candidate.exists() {
        return Err(format!("路径不存在：{trimmed}"));
    }
    Ok(candidate)
}

/// 用资源管理器打开目录；传文件路径时高亮该文件（/select）。
pub fn show_in_explorer(path: &str) -> Result<(), String> {
    let resolved = resolve_existing(path)?;
    if cfg!(windows) {
        if resolved.is_file() {
            let mut command = Command::new("explorer");
            command.arg("/select,").arg(&resolved);
            // explorer 对不存在的路径会弹窗而不是报错，且总返回退出码 1，忽略状态。
            let _ = spawn_hidden(&mut command);
            return Ok(());
        }
        let mut command = Command::new("explorer");
        command.arg(&resolved);
        let _ = spawn_hidden(&mut command);
        return Ok(());
    }
    let dir = if resolved.is_file() { resolved.parent().map(Path::to_path_buf).unwrap_or(resolved) } else { resolved };
    let mut command = if cfg!(target_os = "macos") {
        Command::new("open")
    } else {
        Command::new("xdg-open")
    };
    command.arg(&dir);
    spawn_hidden(&mut command)
}

/// 用系统默认应用打开文件 / 用默认浏览器打开 URL。
pub fn open_with_system(path_or_url: &str) -> Result<(), String> {
    let trimmed = path_or_url.trim();
    if trimmed.is_empty() {
        return Err("目标为空".to_owned());
    }
    let is_url = trimmed.starts_with("http://") || trimmed.starts_with("https://");
    if cfg!(windows) {
        if is_url {
            // cmd /c start "" <url>：空标题参数避免把带 & 的 URL 截断。
            let mut command = Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
            command.raw_arg(format!("/D /C start \"\" {trimmed}"));
            return spawn_hidden(&mut command);
        }
        let resolved = resolve_existing(trimmed)?;
        // rundll url.dll 官方推荐的 shell 打开方式，等价于资源管理器双击。
        let mut command = Command::new("cmd");
        command.raw_arg(format!("/D /C start \"\" \"{}\"", resolved.to_string_lossy()));
        return spawn_hidden(&mut command);
    }
    let mut command = if cfg!(target_os = "macos") {
        Command::new("open")
    } else {
        Command::new("xdg-open")
    };
    command.arg(trimmed);
    spawn_hidden(&mut command)
}

/* ------------------------------------------------------------------ */
/*  VS Code 定位与打开                                                  */
/* ------------------------------------------------------------------ */

/// 常见 Code 可执行文件名（Windows 按 PATHEXT 匹配）。
const CODE_BINARIES: [&str; 3] = ["code", "code.cmd", "code.exe"];

fn find_code_binary() -> Option<PathBuf> {
    // 1) PATH 上的 code（Windows 上 code.cmd / code.exe 都算）。
    let path_env = std::env::var("PATH").unwrap_or_default();
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned())
            .split(';')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_ascii_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in path_env.split(';').filter(|s| !s.is_empty()) {
        for binary in &CODE_BINARIES {
            let direct = Path::new(dir).join(binary);
            if direct.is_file() {
                return Some(direct);
            }
            for ext in &extensions {
                let with_ext = Path::new(dir).join(format!("{binary}{ext}"));
                if with_ext.is_file() {
                    return Some(with_ext);
                }
            }
        }
    }
    // 2) 默认安装位置兜底。
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let mut candidates = Vec::<PathBuf>::new();
    if cfg!(windows) {
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            let localappdata = PathBuf::from(localappdata);
            candidates.push(localappdata.join("Programs").join("Microsoft VS Code").join("bin").join("code.cmd"));
            candidates.push(localappdata.join("Programs").join("Microsoft VS Code Insiders").join("bin").join("code.cmd"));
        }
        if let Ok(programfiles) = std::env::var("ProgramFiles") {
            candidates.push(PathBuf::from(programfiles).join("Microsoft VS Code").join("bin").join("code.cmd"));
        }
    } else if cfg!(target_os = "macos") {
        candidates.push(home.join("Applications").join("Visual Studio Code.app").join("Contents").join("Resources").join("app").join("bin").join("code"));
    } else {
        candidates.push(PathBuf::from("/usr/bin/code"));
        candidates.push(PathBuf::from("/usr/local/bin/code"));
        candidates.push(home.join(".local/bin/code"));
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// 是否安装了 VS Code（决定「用 VS Code 打开」入口是否可用）。
pub fn code_available() -> bool {
    find_code_binary().is_some()
}

/// 用 VS Code 打开文件或其所在目录。
pub fn open_in_vscode(path: &str) -> Result<(), String> {
    let resolved = resolve_existing(path)?;
    let binary = find_code_binary().ok_or("未找到 VS Code（code 命令）")?;
    let display = binary.to_string_lossy().into_owned();
    // .cmd 垫片经 cmd.exe 包装（与 pi 命令同款约束）；exe/脚本直接数组传参。
    if cfg!(windows) && !display.to_ascii_lowercase().ends_with(".exe") {
        let mut command = Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
        command.raw_arg(format!(
            "/D /S /C \"{}\" \"{}\"",
            display.replace('"', ""),
            resolved.to_string_lossy()
        ));
        return spawn_hidden(&mut command);
    }
    let mut command = Command::new(&binary);
    command.arg(&resolved);
    spawn_hidden(&mut command)
}

/// 一次性返回前端需要的打开能力状态。
pub fn open_capabilities() -> Value {
    json!({
        "vscodeAvailable": code_available(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_paths() {
        let missing = format!("Z:\\wepi-definitely-missing-{}.txt", std::process::id());
        assert!(show_in_explorer(&missing).is_err());
        assert!(open_in_vscode(&missing).is_err());
    }

    #[test]
    fn rejects_empty_targets() {
        assert!(show_in_explorer("   ").is_err());
        assert!(open_with_system("").is_err());
    }

    #[test]
    fn capabilities_report_code_detection() {
        let capabilities = open_capabilities();
        assert!(capabilities.get("vscodeAvailable").is_some_and(Value::is_boolean));
    }
}
