//! WEPI 应用自身的更新检查（基于 GitHub Release tag）。
//!
//! 产品决策（用户拍板）：
//! - **不做自动化更新**：不下载、不安装、不替换二进制——发现新版本只给
//!   release 链接，用户自己去下载（桌面应用自更新涉及签名/杀毒/文件锁，
//!   收益远小于成本）。
//! - 自动检查默认**关闭**：设置页有开关，开启后启动时静默查一次，
//!   有新版本 toast 提示；手动「检查更新」按钮始终可用。
//!
//! 版本比对复用 pi_runtime::compare_versions（语义化 x.y.z，忽略 v 前缀）。
//! GitHub API 失败（无网/限流/私有仓）返回结构化错误，UI 降级展示。

use crate::pi_runtime::compare_versions;
use serde_json::{json, Value};
use std::time::Duration;

const GITHUB_LATEST_API: &str = "https://api.github.com/repos/WEP-56/wepi/releases/latest";
const GITHUB_RELEASES_PAGE: &str = "https://github.com/WEP-56/wepi/releases";
const REQUEST_TIMEOUT_SECS: u64 = 15;

/// 查询 GitHub 最新 release，返回 { tag, url, notes }。
/// tag 形如 "v0.2.0" 或 "0.2.0"（比对时统一剥 v 前缀）。
fn fetch_latest_release() -> Result<Value, String> {
    let response = ureq::get(GITHUB_LATEST_API)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "wepi-update-check")
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .call()
        .map_err(|e| format!("GitHub 请求失败：{e}"))?;
    let body: Value = response
        .into_json()
        .map_err(|e| format!("GitHub 响应解析失败：{e}"))?;
    let tag = body
        .get("tag_name")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or("响应缺少 tag_name 字段")?;
    Ok(json!({
        "tag": tag,
        // html_url 是 release 页面（用户可下载的落地页）；缺失时回退仓库 releases 列表页。
        "url": body
            .get("html_url")
            .and_then(Value::as_str)
            .unwrap_or(GITHUB_RELEASES_PAGE),
        // 正文截断到 600 字符：只做预览，全文在 release 页看。
        "notes": body
            .get("body")
            .and_then(Value::as_str)
            .map(|text| {
                let trimmed = text.trim();
                if trimmed.chars().count() > 600 {
                    let cut: String = trimmed.chars().take(600).collect();
                    format!("{cut}…")
                } else {
                    trimmed.to_owned()
                }
            })
            .unwrap_or_default(),
    }))
}

/// 检查更新：本地版本 vs 最新 release tag。
/// 返回 { currentVersion, latestVersion, hasUpdate, releaseUrl, notes }；
/// 网络失败时返回 hasUpdate:false + error 字段，UI 降级展示不阻塞。
#[tauri::command]
pub fn app_update_check() -> Result<Value, String> {
    let current = env!("CARGO_PKG_VERSION").to_owned();
    let latest = match fetch_latest_release() {
        Ok(latest) => latest,
        Err(error) => {
            return Ok(json!({
                "currentVersion": current,
                "hasUpdate": false,
                "error": error,
            }))
        }
    };
    let tag = latest
        .get("tag")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let normalized = tag.trim().trim_start_matches('v');
    let has_update = compare_versions(normalized, &current) > 0;
    Ok(json!({
        "currentVersion": current,
        "latestVersion": normalized,
        "hasUpdate": has_update,
        "releaseUrl": latest.get("url").cloned().unwrap_or(Value::String(GITHUB_RELEASES_PAGE.to_owned())),
        "notes": latest.get("notes").cloned().unwrap_or(Value::String(String::new())),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare_strips_v_prefix() {
        // tag 带 v 前缀时必须先剥掉再比较（GitHub 惯例两种形态都有）。
        assert!(compare_versions("0.2.0", "0.1.1") > 0);
        assert_eq!(compare_versions("0.2.0", "0.2.0"), 0);
        assert!(compare_versions("0.1.1", "0.2.0") < 0);
    }
}
