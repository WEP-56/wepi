//! Pi 全局技能管理：发现 / 查看 / 编辑 / 新建 / 删除 + skills.sh 商店安装。
//!
//! 参考PiDeck `SkillManager`：只操作全局目录（`~/.pi/agent/skills` 与
//! `~/.agents/skills`），不触碰项目级目录，避免误删项目资产。
//! 启用状态通过 frontmatter 的 `disable-model-invocation` 落在技能文件本身，
//! 与 Pi 的加载语义一致（Pi 加载只看目录内容，WEPI 不引入第二份禁用列表）。

use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

const SKILL_FILE: &str = "SKILL.md";
const NAME_MAX: usize = 64;
const DESCRIPTION_MAX: usize = 1024;
const READ_LIMIT: u64 = 256 * 1024;

fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn skill_locations() -> Vec<(&'static str, &'static str, PathBuf, bool)> {
    let home = home_dir();
    vec![
        ("pi-global", "~/.pi/agent/skills", home.join(".pi").join("agent").join("skills"), true),
        ("agents-global", "~/.agents/skills", home.join(".agents").join("skills"), false),
    ]
}

/// 归一化技能名：Unicode 字母/数字/连字符（与 PiDeck normalizeSkillName 一致）。
fn normalize_skill_name(value: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in value.trim().chars() {
        if ch.is_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch.to_lowercase().next().unwrap_or(ch));
        } else {
            if !out.is_empty() {
                pending_dash = true;
            }
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.chars().take(NAME_MAX).collect()
}

/// 解析 SKILL.md frontmatter 的最小 YAML 子集（键: 值 行）。
fn parse_frontmatter(raw: &str) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    let Some(start) = raw.starts_with("---").then(|| raw.find('\n').map(|index| index + 1).unwrap_or(3)) else {
        return result;
    };
    let rest = &raw[start..];
    let Some(end) = rest.find("\n---") else {
        return result;
    };
    for line in rest[..end].lines() {
        let Some(colon) = line.find(':') else { continue };
        let key = line[..colon].trim();
        let mut value = line[colon + 1..].trim().to_owned();
        if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
            value = value[1..value.len() - 1].to_owned();
        } else if value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2 {
            value = value[1..value.len() - 1].to_owned();
        }
        if !key.is_empty() {
            result.insert(key.to_owned(), value);
        }
    }
    result
}

fn set_frontmatter_flag(raw: &str, key: &str, value: bool) -> String {
    let target = format!("{key}: {}", if value { "true" } else { "false" });
    let Some(start) = raw.starts_with("---").then(|| raw.find('\n').map(|index| index + 1).unwrap_or(3)) else {
        return format!("---\n{target}\n---\n\n{raw}");
    };
    let rest = &raw[start..];
    if let Some(end) = rest.find("\n---") {
        let body = &rest[..end];
        let mut replaced = false;
        let lines: Vec<String> = body
            .lines()
            .map(|line| {
                if line.trim().starts_with(&format!("{key}:")) {
                    replaced = true;
                    target.clone()
                } else {
                    line.to_owned()
                }
            })
            .collect();
        let mut next_body = lines.join("\n");
        if !replaced {
            next_body = format!("{next_body}\n{target}");
        }
        return format!("---\n{next_body}\n---{}", &rest[end + 3..]);
    }
    format!("---\n{target}\n---\n\n{raw}")
}

fn skill_summary(skill_path: &Path, location_id: &str, location_label: &str, kind: &str) -> Option<Value> {
    let raw = fs::read_to_string(skill_path).unwrap_or_default();
    if raw.is_empty() {
        return None;
    }
    let frontmatter = parse_frontmatter(&raw);
    let fallback = if kind == "markdown" {
        skill_path.file_stem()?.to_string_lossy().into_owned()
    } else {
        skill_path.parent()?.file_name()?.to_string_lossy().into_owned()
    };
    let name = frontmatter.get("name").filter(|v| !v.trim().is_empty()).cloned().unwrap_or(fallback);
    let description = frontmatter.get("description").cloned().unwrap_or_default();    let mut warnings = Vec::new();
    if name.is_empty() {
        warnings.push("缺少 name".to_owned());
    }
    if name.chars().count() > NAME_MAX {
        warnings.push("名称超过 64 字符".to_owned());
    }
    if description.is_empty() {
        warnings.push("缺少 description".to_owned());
    }
    if description.chars().count() > DESCRIPTION_MAX {
        warnings.push("描述超过 1024 字符".to_owned());
    }
    let user_only = frontmatter.get("disable-model-invocation").map(String::as_str) == Some("true");
    let dir = skill_path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    Some(json!({
        "id": format!("{location_id}:{}", skill_path.to_string_lossy()),
        "name": name,
        "description": description,
        "path": skill_path.to_string_lossy(),
        "dir": dir,
        "sourceId": location_id,
        "sourceLabel": location_label,
        "type": kind,
        "userOnly": user_only,
        // WEPI 沿用 Pi 语义：目录里的技能默认启用，disable-model-invocation 仅停止模型自动调用。
        "enabled": true,
        "warnings": warnings,
    }))
}

/// 递归收集目录下的技能（目录型：直接/嵌套含 SKILL.md；markdown：根目录单文件）。
fn scan_location(location_id: &str, label: &str, root: &Path, root_markdown: bool) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return out;
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let file_type = entry.file_type().ok();
        if file_type.as_ref().is_some_and(|t| t.is_dir()) {
            dirs.push(path);
        } else if root_markdown
            && file_type.as_ref().is_some_and(|t| t.is_file())
            && path.extension().and_then(|e| e.to_str()) == Some("md")
        {
            if let Some(summary) = skill_summary(&path, location_id, label, "markdown") {
                out.push(summary);
            }
        }
    }
    // 目录型技能：一层目录优先；没有 SKILL.md 的目录再下探一层（pi 的发现规则）。
    for dir in dirs {
        let direct = dir.join(SKILL_FILE);
        if direct.is_file() {
            if let Some(summary) = skill_summary(&direct, location_id, label, "directory") {
                out.push(summary);
            }
            continue;
        }
        if let Ok(nested) = fs::read_dir(&dir) {
            for child in nested.filter_map(Result::ok) {
                let child_path = child.path();
                if child.file_type().ok().is_some_and(|t| t.is_dir()) {
                    let nested_skill = child_path.join(SKILL_FILE);
                    if nested_skill.is_file() {
                        if let Some(summary) = skill_summary(&nested_skill, location_id, label, "directory") {
                            out.push(summary);
                        }
                    }
                }
            }
        }
    }
    out
}

/// 列出全部技能：两个全局目录按 name 去重，pi-global 优先。
pub fn list() -> Result<Value, String> {
    let locations: Vec<Value> = skill_locations()
        .into_iter()
        .map(|(id, label, path, root_markdown)| {
            json!({ "id": id, "label": label, "path": path.to_string_lossy(), "rootMarkdownEnabled": root_markdown })
        })
        .collect();
    let mut seen: BTreeMap<String, Value> = BTreeMap::new();
    for (id, label, path, root_markdown) in skill_locations() {
        fs::create_dir_all(&path).ok();
        for summary in scan_location(id, label, &path, root_markdown) {
            let name = summary.get("name").and_then(Value::as_str).unwrap_or_default().to_lowercase();
            let replace = match seen.get(&name) {
                None => true,
                Some(existing) => existing.get("sourceId").and_then(Value::as_str) == Some("agents-global") && id == "pi-global",
            };
            if replace {
                seen.insert(name, summary);
            }
        }
    }
    let mut skills: Vec<Value> = seen.into_values().collect();
    skills.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(b.get("name").and_then(Value::as_str).unwrap_or_default())
    });
    Ok(json!({ "locations": locations, "skills": skills }))
}

fn find_skill(skill_path: &str) -> Result<Value, String> {
    let snapshot = list()?;
    snapshot
        .get("skills")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("path").and_then(Value::as_str) == Some(skill_path))
                .cloned()
        })
        .ok_or_else(|| "未找到该技能（可能已被移动或删除）".to_owned())
}

/// 读取技能正文（带大小上限）。
pub fn read_content(skill_path: &str) -> Result<Value, String> {
    let summary = find_skill(skill_path)?;
    let path = PathBuf::from(skill_path);
    let meta = fs::metadata(&path).map_err(|e| format!("读取技能失败：{e}"))?;
    if meta.len() > READ_LIMIT {
        return Err("技能文件过大（>256KB）".to_owned());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取技能失败：{e}"))?;
    Ok(json!({ "content": raw, "skill": summary }))
}

/// 新建技能：frontmatter + 正文模板落到指定位置。
pub fn create(location_id: &str, name: &str, description: &str, content: Option<&str>) -> Result<Value, String> {
    let normalized = normalize_skill_name(name);
    if normalized.is_empty() {
        return Err("技能名不能为空".to_owned());
    }
    let description = description.trim();
    if description.is_empty() {
        return Err("描述不能为空".to_owned());
    }
    let (_, _, root, _) = skill_locations()
        .into_iter()
        .find(|(id, _, _, _)| id == &location_id)
        .ok_or("未知技能位置".to_owned())?;
    let skill_dir = root.join(&normalized);
    if skill_dir.exists() {
        return Err(format!("技能「{normalized}」已存在").to_owned());
    }
    fs::create_dir_all(&skill_dir).map_err(|e| format!("无法创建技能目录：{e}"))?;
    let body = content.unwrap_or("# 使用说明\n\n描述 Agent 在什么场景下使用这个技能，以及具体步骤。\n");
    let raw = format!("---\nname: {normalized}\ndescription: {}\n---\n\n{body}\n", description.replace('\n', " "));
    let skill_path = skill_dir.join(SKILL_FILE);
    fs::write(&skill_path, raw).map_err(|e| format!("无法写入技能：{e}"))?;
    skill_summary(&skill_path, location_id, "~/.pi/agent/skills", "directory")
        .ok_or_else(|| "技能已创建但读取失败".to_owned())
}

/// 保存技能正文（含 frontmatter 的整体内容）。
pub fn write_content(skill_path: &str, content: &str) -> Result<(), String> {
    find_skill(skill_path)?;
    if content.len() as u64 > READ_LIMIT {
        return Err("内容过大（>256KB）".to_owned());
    }
    fs::write(skill_path, content).map_err(|e| format!("无法写入技能：{e}"))
}

/// 切换「仅手动调用」（disable-model-invocation）。
pub fn set_user_only(skill_path: &str, user_only: bool) -> Result<Value, String> {
    find_skill(skill_path)?;
    let raw = fs::read_to_string(skill_path).map_err(|e| format!("读取技能失败：{e}"))?;
    let next = set_frontmatter_flag(&raw, "disable-model-invocation", user_only);
    fs::write(skill_path, next).map_err(|e| format!("写入技能失败：{e}"))?;
    find_skill(skill_path)
}

/// 重命名：目录技能重命名目录并改写 frontmatter name。
pub fn rename(skill_path: &str, new_name: &str) -> Result<Value, String> {
    let summary = find_skill(skill_path)?;
    let normalized = normalize_skill_name(new_name);
    if normalized.is_empty() {
        return Err("新名称不能为空".to_owned());
    }
    let kind = summary.get("type").and_then(Value::as_str).unwrap_or("directory");
    let old_path = PathBuf::from(skill_path);
    let raw = fs::read_to_string(&old_path).map_err(|e| format!("读取技能失败：{e}"))?;
    let target = if kind == "markdown" {
        old_path.with_file_name(format!("{normalized}.md"))
    } else {
        let parent = old_path.parent().ok_or("路径异常")?.to_path_buf();
        parent.join(&normalized)
    };
    if target.exists() {
        return Err(format!("目标「{normalized}」已存在").to_owned());
    }
    fs::rename(&old_path, &target).map_err(|e| format!("重命名失败：{e}"))?;
    let new_skill_path = if kind == "markdown" { target.clone() } else { target.join(SKILL_FILE) };
    let next_raw = set_frontmatter_name(&raw, new_name.trim());
    fs::write(&new_skill_path, next_raw).map_err(|e| format!("更新技能名失败：{e}"))?;
    let location_id = summary.get("sourceId").and_then(Value::as_str).unwrap_or("pi-global");
    let location_label = summary.get("sourceLabel").and_then(Value::as_str).unwrap_or("~/.pi/agent/skills");
    skill_summary(&new_skill_path, location_id, location_label, kind).ok_or_else(|| "重命名成功但读取失败".to_owned())
}

fn set_frontmatter_name(raw: &str, name: &str) -> String {
    let target = format!("name: {name}");
    let Some(start) = raw.starts_with("---").then(|| raw.find('\n').map(|index| index + 1).unwrap_or(3)) else {
        return format!("---\n{target}\n---\n\n{raw}");
    };
    let rest = &raw[start..];
    if let Some(end) = rest.find("\n---") {
        let body = &rest[..end];
        let mut replaced = false;
        let mut lines: Vec<String> = body
            .lines()
            .map(|line| {
                if line.trim().starts_with("name:") {
                    replaced = true;
                    target.clone()
                } else {
                    line.to_owned()
                }
            })
            .collect();
        if !replaced {
            lines.insert(0, target);
        }
        return format!("---\n{}\n---{}", lines.join("\n"), &rest[end + 3..]);
    }
    format!("---\n{target}\n---\n\n{raw}")
}

/// 删除技能：目录技能删整个目录；markdown 技能删单文件。
/// 只允许删除两个全局技能目录内的路径（canonicalize 防穿越）。
pub fn delete(skill_path: &str) -> Result<(), String> {
    let summary = find_skill(skill_path)?;
    let target = PathBuf::from(skill_path);
    let canonical = fs::canonicalize(&target).map_err(|e| format!("定位技能失败：{e}"))?;
    let allowed = skill_locations().iter().any(|(_, _, root, _)| {
        fs::canonicalize(root)
            .is_ok_and(|root_canonical| canonical.starts_with(root_canonical))
    });
    if !allowed {
        return Err("拒绝删除技能目录之外的路径".to_owned());
    }
    let kind = summary.get("type").and_then(Value::as_str).unwrap_or("directory");
    if kind == "markdown" {
        fs::remove_file(&canonical).map_err(|e| format!("删除失败：{e}"))
    } else {
        let dir = canonical.parent().ok_or("路径异常")?;
        fs::remove_dir_all(dir).map_err(|e| format!("删除失败：{e}"))
    }
}

/* ------------------------------------------------------------------ */
/*  技能商店（skills.sh）                                               */
/* ------------------------------------------------------------------ */

/// 搜索 skills.sh：返回 slug/name/installs/source。
pub fn store_search(query: &str, limit: u32) -> Result<Value, String> {
    let trimmed = query.trim();
    let bounded_limit = limit.clamp(1, 100);
    let url = format!(
        "https://www.skills.sh/api/search?q={}&limit={}",
        urlencode(trimmed),
        bounded_limit
    );
    let response = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| format!("skills.sh 请求失败：{e}"))?;
    let body: Value = response
        .into_json()
        .map_err(|e| format!("skills.sh 响应解析失败：{e}"))?;
    let mut items = Vec::<Value>::new();
    if let Some(skills) = body.get("skills").and_then(Value::as_array) {
        for item in skills {
            let slug = item.get("id").and_then(Value::as_str).unwrap_or_default();
            let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
            let installs = item.get("installs").and_then(Value::as_u64).unwrap_or(0);
            let source = item.get("source").and_then(Value::as_str).unwrap_or_default();
            if slug.is_empty() {
                continue;
            }
            items.push(json!({
                "slug": slug,
                "name": name,
                "description": format!("来自 {source} 的技能包"),
                "installs": installs,
                "source": source,
            }));
        }
    }
    items.sort_by(|a, b| b.get("installs").and_then(Value::as_u64).cmp(&a.get("installs").and_then(Value::as_u64)));
    Ok(json!({ "query": trimmed, "total": items.len(), "items": items }))
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

/// 安装 skills.sh 技能：`npx skills add <pkg> [--skill <name>] --global --yes`。
/// Windows 下 npx 是 .cmd 垫片，必须经 cmd.exe /d /s /c 执行（PiDeck 同款约束）。
pub fn store_install(slug: &str) -> Result<Value, String> {
    let trimmed = slug.trim();
    if trimmed.is_empty() {
        return Err("技能标识不能为空".to_owned());
    }
    let (pkg, skill_name) = match trimmed.rfind('/') {
        Some(index) if index > 0 => (&trimmed[..index], &trimmed[index + 1..]),
        _ => (trimmed, ""),
    };
    // 参数进 cmd /c 命令串前必须白名单校验（防注入）。
    if !is_safe_slug(pkg) || (!skill_name.is_empty() && !is_safe_slug(skill_name)) {
        return Err(format!("技能标识包含非法字符：{trimmed}"));
    }
    let mut cmdline = format!("npx skills add {pkg} --agent pi");
    if !skill_name.is_empty() {
        cmdline.push_str(&format!(" --skill {skill_name}"));
    }
    cmdline.push_str(" --global --yes");
    let shell = if cfg!(windows) {
        std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_owned())
    } else {
        "sh".to_owned()
    };
    let (program, args): (String, Vec<String>) = if cfg!(windows) {
        (shell, vec!["/d".into(), "/s".into(), "/c".into(), cmdline])
    } else {
        ("npx".into(), build_unix_args(pkg, skill_name))
    };
    let _ = cmdline;
    let mut command = std::process::Command::new(&program);
    command
        .args(&args)
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    crate::no_window(&mut command);
    let output = command
        .output()
        .map_err(|e| format!("启动安装失败：{e}（请确认已安装 Node.js / npx）"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        let detail = if stderr.trim().is_empty() { stdout.clone() } else { stderr };
        return Ok(json!({ "success": false, "slug": trimmed, "output": truncate(&detail, 2000) }));
    }
    Ok(json!({ "success": true, "slug": trimmed, "output": truncate(&stdout, 2000) }))
}

fn build_unix_args(pkg: &str, skill_name: &str) -> Vec<String> {
    let mut args = vec![
        "skills".into(),
        "add".into(),
        pkg.to_owned(),
        "--agent".into(),
        "pi".into(),
    ];
    if !skill_name.is_empty() {
        args.push("--skill".into());
        args.push(skill_name.to_owned());
    }
    args.push("--global".into());
    args.push("--yes".into());
    args
}

fn is_safe_slug(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '-' | '_' | '.'))
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_skill_names() {
        assert_eq!(normalize_skill_name("My Cool Skill"), "my-cool-skill");
        // 非字母数字折叠为单个连字符，首尾不留（与 PiDeck normalizeSkillName 一致）。
        assert_eq!(normalize_skill_name("  数据__分析!  "), "数据-分析");
        assert_eq!(normalize_skill_name("--leading"), "leading");
    }

    #[test]
    fn parses_and_writes_frontmatter_flags() {
        let raw = "---\nname: demo\ndescription: 测试\n---\n\n正文";
        let flags_on = set_frontmatter_flag(raw, "disable-model-invocation", true);
        assert!(flags_on.contains("disable-model-invocation: true"));
        let flags_off = set_frontmatter_flag(&flags_on, "disable-model-invocation", false);
        assert!(flags_off.contains("disable-model-invocation: false"));
        assert!(flags_off.contains("name: demo"));
    }

    #[test]
    fn parses_frontmatter_with_quotes() {
        let raw = "---\nname: \"quoted\"\ndescription: 'single'\n---\nbody";
        let parsed = parse_frontmatter(raw);
        assert_eq!(parsed.get("name").map(String::as_str), Some("quoted"));
        assert_eq!(parsed.get("description").map(String::as_str), Some("single"));
    }
}
