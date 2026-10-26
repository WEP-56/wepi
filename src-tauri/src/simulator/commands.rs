//! 面板 IPC：状态、选择、开关机、长轮询取帧、输入、复制截图。
//! 与 agent 工具共用同一批 `super::*` 函数，坐标约定也完全一致（point）。

use std::time::Duration;
use tauri::{ipc::Response, AppHandle, Manager};

use super::{Input, Simulators};

fn name_of(udid: &str) -> Result<String, String> {
    super::avd(udid).map(str::to_owned).ok_or_else(|| "无效的模拟器 id".to_string())
}

#[tauri::command]
pub async fn simulator_status(app: AppHandle) -> Result<super::Status, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(app.state::<Simulators>().status()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn simulator_select(app: AppHandle, udid: Option<String>) -> Result<super::Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sims = app.state::<Simulators>();
        sims.select(udid)?;
        Ok(sims.status())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn simulator_power(app: AppHandle, udid: String, on: bool) -> Result<super::Status, String> {
    let name = name_of(&udid)?;
    tauri::async_runtime::spawn_blocking(move || {
        let sims = app.state::<Simulators>();
        sims.forget(&name);
        if on {
            super::boot(&name)?;
            sims.select(Some(udid))?;
        } else {
            sims.streams.stop(&name);
            super::shutdown(&name)?;
        }
        Ok(sims.status())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 最新一帧：8 字节小端序号 + JPEG 字节。没有新帧时返回空。
/// 长轮询 1.5 秒，前端拿到就立刻再要，等于一个由前端驱动的帧率。
#[tauri::command]
pub async fn simulator_frame(app: AppHandle, udid: String, after: u64) -> Result<Response, String> {
    let name = name_of(&udid)?;
    tauri::async_runtime::spawn_blocking(move || {
        let sims = app.state::<Simulators>();
        let frame = sims.streams.next(&name, after, Duration::from_millis(1500))?;
        Ok(Response::new(frame.map_or_else(Vec::new, |frame| {
            let mut bytes = Vec::with_capacity(frame.jpeg.len() + 8);
            bytes.extend_from_slice(&frame.seq.to_le_bytes());
            bytes.extend_from_slice(&frame.jpeg);
            bytes
        })))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn simulator_input(app: AppHandle, udid: String, input: Input) -> Result<String, String> {
    let name = name_of(&udid)?;
    tauri::async_runtime::spawn_blocking(move || {
        let sims = app.state::<Simulators>();
        let screen = sims.shown(&name)?;
        super::input(&name, screen, &input)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 原分辨率 PNG，供面板"复制截图"。
#[tauri::command]
pub async fn simulator_capture(udid: String) -> Result<Response, String> {
    let name = name_of(&udid)?;
    tauri::async_runtime::spawn_blocking(move || super::capture(&name).map(Response::new))
        .await
        .map_err(|error| error.to_string())?
}

/// 面板的深浅色切换（agent 走 wepi_simulator_manage 的 appearance）。
#[tauri::command]
pub async fn simulator_appearance(udid: String, mode: String) -> Result<String, String> {
    let name = name_of(&udid)?;
    tauri::async_runtime::spawn_blocking(move || super::appearance(&name, &mode))
        .await
        .map_err(|error| error.to_string())?
}
