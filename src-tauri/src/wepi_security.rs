//! WEPI 安全管理（对齐 PiDeck 的 security 域）。
//!
//! 两端协作模型：
//! - 本模块（宿主侧）：等级配置持久化在 `~/.wepi/settings.json` 的
//!   `securityConfig`；每次变更后把「策略快照」写到 `~/.wepi/security-policy.json`。
//! - pi 进程内扩展（wepi-security-gate.ts）：通过 `WEPI_SECURITY_CONFIG`
//!   环境变量拿到快照路径、`WEPI_SESSION_ID` 拿到会话身份，在 tool_call
//!   事件上按快照拦截。扩展侧有等价的自包含实现，两侧以快照 schema 为契约。
//!
//! 设计原则：
//! 1. 默认启用安全门（enabled=true），默认等级 off（完全放行）：开箱零干预；
//! 2. 等级（Level）是一等公民：内置 off/standard/strict 三档；
//! 3. 每个等级独立声明「工具动作」「bash 危险命令」「文件目录边界」「兜底动作」；
//! 4. 会话级覆盖：sessionId → levelId，输入框切换即时生效（快照 mtime 热更新）。

use serde_json::{json, Value};
use std::{fs, path::PathBuf};

pub const SECURITY_SCHEMA_VERSION: u64 = 1;

/// 受管控的内置工具全集（pi 内置 7 个文件/命令工具）。
pub const SECURITY_TOOLS: [&str; 7] = ["read", "write", "edit", "bash", "grep", "find", "ls"];

/// 默认危险 bash 命令模式（正则源字符串）。
pub const DEFAULT_DENY_BASH_PATTERNS: [&str; 17] = [
    r"\brm\s+-[a-z]*[rf]",
    r"\brmdir\b",
    r"\bmv\b",
    r"\bcp\b",
    r"\bchmod\b",
    r"\bchown\b",
    r"\btee\b",
    r"\btruncate\b",
    r"(^|[^<])>(?!>)",
    r">>",
    r"\bnpm\s+(install|uninstall|update|ci|link|publish)",
    r"\byarn\s+(add|remove|install|publish)",
    r"\bpnpm\s+(add|remove|install|publish)",
    r"\bpip\s+(install|uninstall)",
    r"\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)",
    r"\bsudo\b",
    r"\bkill\b",
];

/// 默认敏感路径（相对文件名匹配；保护 .env / 密钥 / git 元数据）。
/// 执行副本在扩展侧（wepi-security-gate.ts 的 SENSITIVE_PATH_PATTERNS）；
/// 此常量供文档对齐与未来 Rust 侧预检使用。
#[allow(dead_code)]
pub const DEFAULT_SENSITIVE_PATH_PATTERNS: [&str; 5] = [
    r"(^|[\\/])\.env([.$]|$)",
    r"(^|[\\/])\.git([\\/]|$)",
    r"(^|[\\/])(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$",
    r"(^|[\\/])\.(npmrc|yarnrc|pnpm-workspace)([.$]|$)",
    r"(\.pem|\.key|\.p12)$",
];

fn wepi_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("WEPI_SETTINGS_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".wepi")
}

/// 策略快照落盘路径（spawn 时注入 WEPI_SECURITY_CONFIG）。
pub fn snapshot_path() -> PathBuf {
    wepi_dir().join("security-policy.json")
}

fn tool_actions(pairs: &[(&str, &str)]) -> Value {
    let mut map = serde_json::Map::new();
    for (tool, action) in pairs {
        map.insert(tool.to_string(), json!(action));
    }
    Value::Object(map)
}

fn deny_bash_patterns_value() -> Value {
    Value::Array(
        DEFAULT_DENY_BASH_PATTERNS
            .iter()
            .map(|pattern| json!(pattern))
            .collect(),
    )
}

/// 内置默认等级（每次返回全新副本，避免共享引用被 UI 修改）。
pub fn default_levels() -> Value {
    json!([
        {
            "id": "off",
            "name": "关闭",
            "description": "完全放行所有工具调用，等同未启用安全管理。",
            "builtin": true,
            "toolActions": {},
            "denyBashPatterns": [],
            "pathPolicy": "unrestricted",
            "customAllowDirs": [],
            "denyDirs": [],
            "protectSensitivePaths": false,
            "defaultAction": "allow",
        },
        {
            "id": "standard",
            "name": "标准",
            "description": "危险命令先确认，敏感文件受保护，目录不限制。",
            "builtin": true,
            "toolActions": tool_actions(&[("bash", "ask")]),
            "denyBashPatterns": deny_bash_patterns_value(),
            "pathPolicy": "unrestricted",
            "customAllowDirs": [],
            "denyDirs": [],
            "protectSensitivePaths": true,
            "defaultAction": "allow",
        },
        {
            "id": "strict",
            "name": "严格",
            "description": "只读为主，写操作逐一确认；危险命令直接拒绝；文件访问仅限工作目录。",
            "builtin": true,
            "toolActions": tool_actions(&[
                ("read", "allow"),
                ("grep", "allow"),
                ("find", "allow"),
                ("ls", "allow"),
                ("write", "ask"),
                ("edit", "ask"),
                ("bash", "ask"),
            ]),
            "denyBashPatterns": deny_bash_patterns_value(),
            "pathPolicy": "workspace",
            "customAllowDirs": [],
            "denyDirs": [],
            "protectSensitivePaths": true,
            "defaultAction": "deny",
        },
    ])
}

/// 默认配置工厂：enabled=true + 默认等级 standard（危险命令确认 + 敏感文件
/// 保护，目录不限制）——开箱即有基线防护；off 需用户显式选择（UI 侧带告警）。
pub fn default_config() -> Value {
    json!({
        "enabled": true,
        "defaultLevelId": "standard",
        "levels": default_levels(),
        "sessionOverrides": {},
    })
}

/// 读取安全配置（settings.json 的 securityConfig；缺失/损坏时回退默认）。
pub fn load_config() -> Value {
    let settings = crate::wepi_settings::read();
    let config = settings.get("securityConfig").cloned().unwrap_or(Value::Null);
    if config.is_object() && config.get("levels").and_then(Value::as_array).is_some_and(|l| !l.is_empty()) {
        // 补齐可能缺失的字段（旧版本升级兜底）。
        let mut merged = config;
        if merged.get("enabled").and_then(Value::as_bool).is_none() {
            merged.as_object_mut().unwrap().insert("enabled".into(), json!(true));
        }
        if merged.get("defaultLevelId").and_then(Value::as_str).is_none() {
            merged.as_object_mut().unwrap().insert("defaultLevelId".into(), json!("standard"));
        }
        if merged.get("sessionOverrides").and_then(Value::as_object).is_none() {
            merged.as_object_mut().unwrap().insert("sessionOverrides".into(), json!({}));
        }
        merged
    } else {
        default_config()
    }
}

/// 生成扩展消费的策略快照。
pub fn build_snapshot(config: &Value) -> Value {
    let session_overrides = config.get("sessionOverrides").cloned().unwrap_or(json!({}));
    json!({
        "schemaVersion": SECURITY_SCHEMA_VERSION,
        "enabled": config.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        "defaultLevelId": config.get("defaultLevelId").and_then(Value::as_str).unwrap_or("standard"),
        "levels": config.get("levels").cloned().unwrap_or_else(default_levels),
        "sessionLevels": session_overrides,
    })
}

/// 把快照写入 `~/.wepi/security-policy.json`（原子性靠同目录临时文件 + rename；
/// exFAT 不支持 rename 跨设备，这里临时文件就在同目录内）。
pub fn write_snapshot(snapshot: &Value) -> Result<PathBuf, String> {
    let path = snapshot_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建 WEPI 目录：{e}"))?;
    }
    let raw = serde_json::to_string_pretty(snapshot).map_err(|e| e.to_string())?;
    // exFAT 无 rename 保障，直接写（快照文件小，写坏时扩展侧 fail-safe 放行）。
    fs::write(&path, format!("{raw}\n")).map_err(|e| format!("无法写入安全策略快照：{e}"))?;
    Ok(path)
}

/// 保存安全配置并同步落盘快照。返回快照路径。
pub fn save_config(config: Value) -> Result<Value, String> {
    // 边界校验：defaultLevelId 必须存在于 levels；非法动作值拒绝。
    let levels = config
        .get("levels")
        .and_then(Value::as_array)
        .ok_or("levels 必须是非空数组")?;
    if levels.is_empty() {
        return Err("levels 不能为空".to_owned());
    }
    let default_id = config
        .get("defaultLevelId")
        .and_then(Value::as_str)
        .unwrap_or("off");
    let exists = levels
        .iter()
        .any(|level| level.get("id").and_then(Value::as_str) == Some(default_id));
    if !exists {
        return Err(format!("默认等级不存在: {default_id}"));
    }
    for level in levels {
        let id = level.get("id").and_then(Value::as_str).unwrap_or("");
        if let Some(actions) = level.get("toolActions").and_then(Value::as_object) {
            for (tool, action) in actions {
                if !SECURITY_TOOLS.contains(&tool.as_str()) {
                    return Err(format!("等级 {id} 包含未知工具: {tool}"));
                }
                if !matches!(action.as_str(), Some("allow" | "ask" | "deny")) {
                    return Err(format!("等级 {id} 工具 {tool} 动作非法: {action}"));
                }
            }
        }
    }
    let snapshot = build_snapshot(&config);
    crate::wepi_settings::patch(|settings| {
        settings
            .as_object_mut()
            .expect("patch 前已保证为对象")
            .insert("securityConfig".into(), config.clone());
    })?;
    write_snapshot(&snapshot)?;
    Ok(snapshot)
}

/// 读取当前快照（供前端展示）。
pub fn read_snapshot() -> Value {
    let config = load_config();
    build_snapshot(&config)
}

/// 设置某会话的等级覆盖（sessionKey → levelId；None 移除覆盖）。
pub fn set_session_level(session_id: &str, level_id: Option<&str>) -> Result<Value, String> {
    let mut config = load_config();
    let overrides = config
        .get_mut("sessionOverrides")
        .and_then(Value::as_object_mut)
        .ok_or("sessionOverrides 结构损坏")?;
    match level_id {
        Some(level) => {
            overrides.insert(session_id.to_owned(), json!(level));
        }
        None => {
            overrides.remove(session_id);
        }
    }
    let snapshot = save_config(config)?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_baseline_protection() {
        let config = default_config();
        assert_eq!(config["enabled"], json!(true));
        // 默认 standard：危险 bash 确认 + 敏感路径保护，目录不限制。
        // off 不再是默认（用户要求基线防护；切换到 off 由 UI 弹窗告警）。
        assert_eq!(config["defaultLevelId"], json!("standard"));
        let levels = config["levels"].as_array().unwrap();
        assert_eq!(levels.len(), 3);
        let standard = &levels[1];
        assert_eq!(standard["toolActions"]["bash"], json!("ask"));
        assert_eq!(standard["protectSensitivePaths"], json!(true));
        assert_eq!(standard["pathPolicy"], json!("unrestricted"));
    }

    #[test]
    fn snapshot_schema_matches_extension_contract() {
        let snapshot = build_snapshot(&default_config());
        assert_eq!(snapshot["schemaVersion"], json!(SECURITY_SCHEMA_VERSION));
        assert_eq!(snapshot["enabled"], json!(true));
        assert_eq!(
            snapshot["levels"].as_array().map(Vec::len),
            Some(3),
            "快照必须带全部等级供扩展解析"
        );
        // 扩展侧 SCHEMA_VERSION = 1；两侧不一致时扩展 fail-safe 放行。
        assert_eq!(SECURITY_SCHEMA_VERSION, 1);
    }

    #[test]
    fn save_rejects_unknown_default_level() {
        // 把设置目录指到临时目录：save_config 会真实落盘，不能污染开发机的
        // ~/.wepi/settings.json（此前直接跑会在本机留下测试配置）。
        let dir = std::env::temp_dir().join(format!("wepi-sec-test-{}", std::process::id()));
        std::env::set_var("WEPI_SETTINGS_DIR", &dir);
        let result = {
            let mut config = default_config();
            config
                .as_object_mut()
                .unwrap()
                .insert("defaultLevelId".into(), json!("nonexistent"));
            save_config(config)
        };
        std::env::remove_var("WEPI_SETTINGS_DIR");
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn strict_level_covers_write_tools_with_ask() {
        let levels = default_levels();
        let strict = &levels.as_array().unwrap()[2];
        assert_eq!(strict["pathPolicy"], json!("workspace"));
        assert_eq!(strict["defaultAction"], json!("deny"));
        assert_eq!(strict["toolActions"]["write"], json!("ask"));
        assert_eq!(strict["toolActions"]["edit"], json!("ask"));
        assert_eq!(strict["toolActions"]["read"], json!("allow"));
    }
}
