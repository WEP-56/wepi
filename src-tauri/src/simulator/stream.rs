//! 面板的实时画面：每台设备一个 producer 线程，只在前端持续要帧时活着。
//! 前端长轮询 `next(after)` 拿最新一帧；超过 6 秒没人要帧，线程自己收摊，
//! 不留后台进程、也不在面板关着时继续截图。

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

/// 没人要帧这么久就停。
const IDLE: Duration = Duration::from_secs(6);
/// 两帧之间的最小间隔：`screencap` 一次 1–2 MB，再快没有意义。
const POLL_GAP: Duration = Duration::from_millis(120);
/// 帧序号跨 producer 单调递增：换设备/重启后前端仍能识别"这是新帧"。
static SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct Latest {
    seq: u64,
    jpeg: Arc<Vec<u8>>,
    error: Option<String>,
    finished: bool,
}

struct Producer {
    latest: Mutex<Latest>,
    ready: Condvar,
    pulled: Mutex<Instant>,
}

impl Producer {
    fn idle(&self) -> bool {
        self.pulled.lock().map(|at| at.elapsed() > IDLE).unwrap_or(true)
    }
    fn touch(&self) {
        if let Ok(mut pulled) = self.pulled.lock() {
            *pulled = Instant::now();
        }
    }
    fn push(&self, jpeg: Vec<u8>) {
        if let Ok(mut latest) = self.latest.lock() {
            latest.seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
            latest.jpeg = Arc::new(jpeg);
            latest.error = None;
        }
        self.ready.notify_all();
    }
    fn finish(&self, error: Option<String>) {
        if let Ok(mut latest) = self.latest.lock() {
            latest.finished = true;
            latest.error = error;
        }
        self.ready.notify_all();
    }
}

#[derive(Default)]
pub struct Streams(Mutex<HashMap<String, Arc<Producer>>>);

pub struct Frame {
    pub seq: u64,
    pub jpeg: Arc<Vec<u8>>,
}

impl Streams {
    fn producer(&self, name: &str) -> Arc<Producer> {
        let mut map = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(existing) = map.get(name) {
            let finished = existing.latest.lock().map(|latest| latest.finished).unwrap_or(true);
            if !finished {
                existing.touch();
                return existing.clone();
            }
        }
        let producer = Arc::new(Producer { latest: Mutex::default(), ready: Condvar::new(), pulled: Mutex::new(Instant::now()) });
        map.insert(name.to_owned(), producer.clone());
        let worker = producer.clone();
        let name = name.to_owned();
        thread::spawn(move || {
            let mut failures = 0;
            while !worker.idle() {
                let started = Instant::now();
                match super::frame(&name) {
                    Ok(jpeg) => {
                        failures = 0;
                        worker.push(jpeg);
                    }
                    Err(error) => {
                        failures += 1;
                        if failures >= 3 {
                            worker.finish(Some(error));
                            return;
                        }
                    }
                }
                thread::sleep(POLL_GAP.saturating_sub(started.elapsed()));
            }
            worker.finish(None);
        });
        producer
    }

    /// `after` 之后的最新一帧，最多等 `wait`；没有新帧返回 `None`。
    pub fn next(&self, name: &str, after: u64, wait: Duration) -> Result<Option<Frame>, String> {
        let producer = self.producer(name);
        let deadline = Instant::now() + wait;
        let mut latest = producer.latest.lock().map_err(|error| error.to_string())?;
        loop {
            if latest.seq > after {
                return Ok(Some(Frame { seq: latest.seq, jpeg: latest.jpeg.clone() }));
            }
            if latest.finished {
                return match latest.error.clone() {
                    Some(error) => Err(error),
                    None => Ok(None),
                };
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(None);
            }
            latest = producer.ready.wait_timeout(latest, left).map_err(|error| error.to_string())?.0;
        }
    }

    /// 关机或关闭面板时停掉该设备的 producer。
    pub fn stop(&self, name: &str) {
        let mut map = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(producer) = map.remove(name) {
            if let Ok(mut pulled) = producer.pulled.lock() {
                *pulled = Instant::now() - IDLE * 2;
            }
            producer.ready.notify_all();
        }
    }
}
