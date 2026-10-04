//! 系统托盘与关闭行为。
//!
//! 关闭行为的两个模式：
//! - `quit`   ：点窗口关闭按钮直接退出应用（默认，符合直觉）。
//! - `tray`   ：点关闭按钮只隐藏窗口，应用留在托盘继续运行（后台任务
//!              不中断）；托盘菜单提供「打开 WEPI / 退出 WEPI」。
//!
//! 偏好持久化在 `~/.wepi/settings.json`（wepi_settings），前端修改后
//! 通过 `set_close_behavior` 命令同步到 Rust 侧——窗口关闭事件在 Rust
//! 层处理，必须在 Rust 层读到当前值。

use crate::wepi_settings;
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

pub const CLOSE_BEHAVIOR_QUIT: &str = "quit";
pub const CLOSE_BEHAVIOR_TRAY: &str = "tray";

/// 读取当前关闭行为；非法/缺失值回退 `quit`（宁可退出也不要留僵尸进程）。
pub fn current_behavior() -> String {
    let value = wepi_settings::read()
        .get("closeBehavior")
        .and_then(Value::as_str)
        .unwrap_or(CLOSE_BEHAVIOR_QUIT)
        .to_owned();
    if value == CLOSE_BEHAVIOR_TRAY {
        CLOSE_BEHAVIOR_TRAY.to_owned()
    } else {
        CLOSE_BEHAVIOR_QUIT.to_owned()
    }
}

/// 窗口关闭请求处理：tray 模式下拦截关闭改为隐藏。
/// 返回 true 表示已拦截（不退出），false 表示放行默认关闭。
pub fn handle_close_requested(app: &AppHandle) -> bool {
    if current_behavior() != CLOSE_BEHAVIOR_TRAY {
        return false;
    }
    if let Some(window) = app.get_window("main") {
        let _ = window.hide();
    }
    true
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 建立托盘图标与菜单。在 setup 阶段调用一次。
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 WEPI", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 WEPI", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut tray = TrayIconBuilder::with_id("wepi-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("WEPI")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => {
                // 托盘退出走 app.exit：绕过 close 拦截（隐藏逻辑），真正退出。
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击 = 显示主窗口（常见桌面习惯：单击唤起、右键菜单）。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    // 托盘图标不再由 tauri.conf.json 声明（配置声明会额外创建一个无菜单
    // 的托盘实例，与这里的实例叠加成「双托盘」）。图标统一在此显式设置：
    // 先试打包资源路径，dev 模式退回源码目录。
    let mut icon_loaded = false;
    if let Ok(resource) = app.path().resolve("icons/icon.png", tauri::path::BaseDirectory::Resource) {
        if resource.is_file() {
            if let Ok(bytes) = std::fs::read(&resource) {
                if let Ok(decoded) = tauri::image::Image::from_bytes(&bytes) {
                    tray = tray.icon(decoded);
                    icon_loaded = true;
                }
            }
        }
    }
    if !icon_loaded {
        // dev 模式：resource 目录不存在，直接读 src-tauri/icons/icon.png。
        let fallback = std::env::current_dir()
            .map(|dir| dir.join("icons/icon.png"))
            .ok();
        if let Some(path) = fallback.filter(|p| p.is_file()) {
            if let Ok(bytes) = std::fs::read(&path) {
                if let Ok(decoded) = tauri::image::Image::from_bytes(&bytes) {
                    tray = tray.icon(decoded);
                }
            }
        }
    }
    tray.build(app)?;
    Ok(())
}

/* ---------------- 前端命令 ---------------- */

#[tauri::command]
pub fn close_behavior_get() -> Result<Value, String> {
    Ok(json!({ "behavior": current_behavior() }))
}

#[tauri::command]
pub fn close_behavior_set(app: AppHandle, behavior: String) -> Result<Value, String> {
    if behavior != CLOSE_BEHAVIOR_QUIT && behavior != CLOSE_BEHAVIOR_TRAY {
        return Err(format!("未知关闭行为：{behavior}"));
    }
    wepi_settings::patch(|settings| {
        settings
            .as_object_mut()
            .expect("patch 前已保证为对象")
            .insert("closeBehavior".into(), json!(behavior));
    })?;
    // 同步给前端其它监听者（如标题栏提示文案）。
    let _ = app.emit("wepi-close-behavior-changed", &behavior);
    Ok(json!({ "behavior": behavior }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_behavior_falls_back_to_quit() {
        wepi_settings::patch(|settings| {
            settings
                .as_object_mut()
                .expect("patch 前已保证为对象")
                .insert("closeBehavior".into(), json!("garbage"));
        })
        .unwrap();
        assert_eq!(current_behavior(), CLOSE_BEHAVIOR_QUIT);
        // 清理，避免污染同进程其它测试。
        wepi_settings::patch(|settings| {
            settings
                .as_object_mut()
                .expect("patch 前已保证为对象")
                .remove("closeBehavior");
        })
        .unwrap();
    }
}
