//! WEPI 自身的设置存储（`~/.wepi/settings.json`）。
//!
//! 只存 WEPI 的桌面层状态（Pi 命令来源、扩展禁用列表），绝不写 Pi 的
//! `settings.json`——那是 Pi 自己的领域（与 PiDeck 的边界约定一致）。

use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Mutex};

fn settings_path() -> PathBuf {
    if let Ok(dir) = std::env::var("WEPI_SETTINGS_DIR") {
        if !dir.trim().is_empty() {
            let path = PathBuf::from(dir).join("settings.json");
            if path.is_file() {
                return path;
            }
        }
    }
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".wepi")
        .join("settings.json")
}

fn load() -> Value {
    fs::read_to_string(settings_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({}))
}

fn store(value: Value) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建 WEPI 设置目录：{e}"))?;
    }
    let raw = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(&path, format!("{raw}\n")).map_err(|e| format!("无法写入 WEPI 设置：{e}"))
}

/// 进程内设置缓存：读多写少，写时整体替换。
fn cache() -> &'static Mutex<Option<Value>> {
    static CACHE: std::sync::OnceLock<Mutex<Option<Value>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

pub fn read() -> Value {
    let mut guard = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_none() {
        *guard = Some(load());
    }
    guard.clone().unwrap_or_else(|| json!({}))
}

pub fn patch(mutator: impl FnOnce(&mut Value)) -> Result<Value, String> {
    let mut guard = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut current = guard.clone().unwrap_or_else(|| json!({}));
    if !current.is_object() {
        current = json!({});
    }
    mutator(&mut current);
    store(current.clone())?;
    *guard = Some(current.clone());
    Ok(current)
}

/// 用户自加的 Pi 命令来源路径（非自动发现）。
pub fn custom_pi_paths() -> Vec<String> {
    read()
        .get("customPiPaths")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub fn add_custom_pi_path(path: &str) -> Result<(), String> {
    let normalized = path.trim().to_owned();
    if normalized.is_empty() {
        return Err("路径不能为空".to_owned());
    }
    patch(|settings| {
        let list = settings
            .as_object_mut()
            .expect("patch 前已保证为对象")
            .entry("customPiPaths")
            .or_insert_with(|| json!([]));
        if !list
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(normalized.as_str())))
        {
            if let Some(items) = list.as_array_mut() {
                items.push(json!(normalized));
            }
        }
    })
    .map(|_| ())
}

pub fn remove_custom_pi_path(path: &str) -> Result<(), String> {
    let normalized = path.trim().to_owned();
    patch(|settings| {
        if let Some(list) = settings.get_mut("customPiPaths").and_then(Value::as_array_mut) {
            list.retain(|item| item.as_str() != Some(normalized.as_str()));
        }
    })
    .map(|_| ())
}

/// 被禁用的扩展来源列表（scope:user 的禁用标记，纯 WEPI 侧状态）。
pub fn disabled_extensions() -> Vec<String> {
    read()
        .get("disabledExtensions")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub fn set_extension_disabled(source: &str, disabled: bool) -> Result<(), String> {
    let source = source.trim().to_owned();
    patch(|settings| {
        let list = settings
            .as_object_mut()
            .expect("patch 前已保证为对象")
            .entry("disabledExtensions")
            .or_insert_with(|| json!([]));
        if let Some(items) = list.as_array_mut() {
            items.retain(|item| item.as_str() != Some(source.as_str()));
            if disabled {
                items.push(json!(source));
            }
        }
    })
    .map(|_| ())
}
