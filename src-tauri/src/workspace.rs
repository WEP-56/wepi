use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use similar::TextDiff;
use std::{collections::{BTreeMap, BTreeSet, HashMap}, fs, io::{Read, Write}, path::{Component, Path, PathBuf}, process::{Command, Output}, sync::{Arc, Mutex}, time::{Duration, SystemTime}};
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const FILE_LIMIT: u64 = 2 * 1024 * 1024;
const SNAPSHOT_LIMIT: usize = 32 * 1024 * 1024;

struct TerminalSlot {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}
#[derive(Default)]
pub struct WorkspaceState {
    terminals: Arc<Mutex<HashMap<String, TerminalSlot>>>,
    mutations: Arc<Mutex<()>>,
}
impl Drop for WorkspaceState {
    fn drop(&mut self) {
        if let Ok(mut slots) = self.terminals.lock() {
            for (_, mut slot) in slots.drain() { let _ = slot.killer.kill(); }
        }
    }
}

fn trusted(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() != "main" { return Err("此网页无法访问桌面工作区".into()); }
    Ok(())
}
fn arg<'a>(args: &'a Value, key: &str) -> &'a str { args[key].as_str().unwrap_or("") }
fn root_path(value: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(value).map_err(|e| format!("无法打开工作区：{e}"))?;
    if !path.is_dir() { return Err("工作区必须是目录".into()); }
    Ok(path)
}

// Canonicalize the nearest existing ancestor so deleted files and symlinks
// obey the same workspace boundary as existing files.
fn child_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    if value.is_empty() { return Ok(root.to_owned()); }
    let path = root.join(value);
    if path.components().any(|part| matches!(part, Component::ParentDir)) { return Err("不能访问工作区外的路径".into()); }
    let mut ancestor = path.as_path();
    let mut tail = Vec::new();
    while !ancestor.exists() {
        tail.push(ancestor.file_name().ok_or("无效路径")?.to_owned());
        ancestor = ancestor.parent().ok_or("无效路径")?;
    }
    let mut resolved = fs::canonicalize(ancestor).map_err(|e| e.to_string())?;
    if !resolved.starts_with(root) { return Err("路径不在当前工作区中".into()); }
    for part in tail.iter().rev() { resolved.push(part); }
    Ok(resolved)
}
fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}
fn mutation_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    let path = child_path(root, value)?;
    if path == root || relative(root, &path).split('/').any(|v| v.eq_ignore_ascii_case(".git")) { return Err("不能修改 Git 元数据或工作区目录".into()); }
    Ok(path)
}
fn git(root: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
    command.args(["--no-optional-locks", "-c", "core.quotepath=false"]).args(args).current_dir(root);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command.output().map_err(|e| format!("无法运行 Git：{e}"))
}
fn git_ok(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = git(root, args)?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned()); }
    Ok(output.stdout)
}
fn git_text(root: &Path, args: &[&str]) -> String {
    git_ok(root, args).map(|v| String::from_utf8_lossy(&v).trim().to_owned()).unwrap_or_default()
}
fn verify_ref(root: &Path, value: &str) -> Result<String, String> {
    if value.is_empty() { return Err("请选择比较分支".into()); }
    let reference = format!("{value}^{{commit}}");
    let bytes = git_ok(root, &["rev-parse", "--verify", "--end-of-options", &reference])?;
    Ok(String::from_utf8_lossy(&bytes).trim().to_owned())
}

#[derive(Clone, Serialize, Deserialize)]
struct Change { file: String, add: usize, del: usize, status: String, binary: bool }
fn changed(file: &str, before: &[u8], after: &[u8], existed: bool, exists: bool) -> Change {
    let binary = before.contains(&0) || after.contains(&0) || std::str::from_utf8(before).is_err() || std::str::from_utf8(after).is_err();
    let (add, del) = if binary { (0, 0) } else {
        let old = String::from_utf8_lossy(before); let new = String::from_utf8_lossy(after);
        let diff = TextDiff::from_lines(old.as_ref(), new.as_ref());
        let mut add = 0; let mut del = 0;
        for c in diff.iter_all_changes() { match c.tag() { similar::ChangeTag::Insert => add += 1, similar::ChangeTag::Delete => del += 1, _ => {} } }
        (add, del)
    };
    Change { file: file.into(), add, del, binary, status: if !existed { "added" } else if !exists { "deleted" } else { "modified" }.into() }
}
fn patch(file: &str, before: &[u8], after: &[u8], context: usize) -> String {
    let old = String::from_utf8_lossy(before); let new = String::from_utf8_lossy(after);
    TextDiff::from_lines(old.as_ref(), new.as_ref()).unified_diff().context_radius(context).header(&format!("a/{file}"), &format!("b/{file}")).to_string()
}
/// 前端展开未修改区域时会请求更大的上下文；这里统一夹紧到安全范围。
fn context_radius(args: &Value) -> usize {
    args["context"].as_u64().unwrap_or(3).clamp(0, 400) as usize
}

#[derive(Serialize, Deserialize)]
struct Snapshot { files: BTreeMap<String, Vec<u8>>, skipped: BTreeSet<String> }
#[derive(Serialize, Deserialize)]
struct Turn { root: PathBuf, before: Snapshot, after: Option<Snapshot>, undone: bool }
fn snapshot(root: &Path) -> Result<Snapshot, String> {
    let mut files = BTreeMap::new(); let mut skipped = BTreeSet::new(); let mut total = 0;
    let walker = ignore::WalkBuilder::new(root).hidden(false).follow_links(false).build();
    for entry in walker {
        let entry = entry.map_err(|e| format!("快照读取失败：{e}"))?;
        if !entry.file_type().is_some_and(|t| t.is_file()) { continue; }
        let file = relative(root, entry.path());
        if file.split('/').any(|v| v == ".git" || v == "node_modules" || v == "target" || v == ".npm-cache" || v == "dist") { continue; }
        let meta = fs::metadata(entry.path()).map_err(|e| e.to_string())?;
        if meta.len() > FILE_LIMIT || total + meta.len() as usize > SNAPSHOT_LIMIT || files.len() >= 4000 { skipped.insert(file); continue; }
        let data = fs::read(entry.path()).map_err(|e| e.to_string())?;
        total += data.len(); files.insert(file, data);
    }
    Ok(Snapshot { files, skipped })
}
fn turn_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 100 || !id.chars().all(|v| v.is_ascii_alphanumeric() || v == '-' || v == '_') { return Err("无效回合标识".into()); }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("reviews");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{id}.json")))
}
fn save_turn(path: &Path, turn: &Turn) -> Result<(), String> {
    let bytes = serde_json::to_vec(turn).map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| e.to_string())
}
fn load_turn(app: &AppHandle, root: &Path, id: &str) -> Result<Turn, String> {
    let turn: Turn = serde_json::from_slice(&fs::read(turn_path(app, id)?).map_err(|_| "这轮变更快照不存在或已清理")?).map_err(|e| e.to_string())?;
    if turn.root != root { return Err("这轮变更属于另一个工作区".into()); }
    Ok(turn)
}
fn turn_changes(turn: &Turn) -> Result<Vec<Change>, String> {
    let after = turn.after.as_ref().ok_or("这轮任务尚未结束")?;
    let mut paths: BTreeSet<_> = turn.before.files.keys().chain(after.files.keys()).collect();
    paths.retain(|p| !turn.before.skipped.contains(*p) && !after.skipped.contains(*p));
    Ok(paths.into_iter().filter_map(|file| {
        let old = turn.before.files.get(file); let new = after.files.get(file);
        if old == new { return None; }
        Some(changed(file, old.map(Vec::as_slice).unwrap_or_default(), new.map(Vec::as_slice).unwrap_or_default(), old.is_some(), new.is_some()))
    }).collect())
}

fn git_review(root: &Path, args: &Value) -> Result<Value, String> {
    git_ok(root, &["rev-parse", "--is-inside-work-tree"])?;
    let scope = arg(args, "scope");
    let branch = git_text(root, &["branch", "--show-current"]);
    let upstream = git_text(root, &["rev-parse", "--abbrev-ref", "@{upstream}"]);
    let branches = git_text(root, &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]).lines().map(str::to_owned).collect::<Vec<_>>();
    let base = if arg(args, "base").is_empty() { if upstream.is_empty() { "HEAD" } else { &upstream } } else { arg(args, "base") };
    let comparison = if scope == "branch" { format!("{}...HEAD", verify_ref(root, base)?) } else { String::new() };
    let mut diff_args = vec!["diff", "--numstat", "-z", "--no-renames"];
    if scope == "staged" { diff_args.push("--cached"); }
    if scope == "branch" { diff_args.push(&comparison); }
    let stats = git_ok(root, &diff_args)?;
    let mut files = Vec::new();
    for record in stats.split(|b| *b == 0).filter(|v| !v.is_empty()) {
        let text = String::from_utf8_lossy(record);
        let mut fields = text.splitn(3, '\t');
        let add = fields.next().unwrap_or("0"); let del = fields.next().unwrap_or("0"); let file = fields.next().unwrap_or_default();
        if file.is_empty() { continue; }
        files.push(Change { file: file.into(), add: add.parse().unwrap_or(0), del: del.parse().unwrap_or(0), binary: add == "-", status: "modified".into() });
    }
    if scope == "working" {
        for file in git_ok(root, &["ls-files", "--others", "--exclude-standard", "-z"] )?.split(|b| *b == 0).filter(|v| !v.is_empty()) {
            let file = String::from_utf8_lossy(file).into_owned();
            let path = child_path(root, &file)?;
            if path.is_file() {
                let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
                let data = if size <= FILE_LIMIT { fs::read(path).map_err(|e| e.to_string())? } else { vec![0] };
                files.push(changed(&file, &[], &data, false, true));
            }
        }
    }
    let divergence = git_text(root, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    let counts: Vec<_> = divergence.split_whitespace().collect();
    Ok(json!({ "files": files, "branch": if branch.is_empty() { "HEAD" } else { &branch }, "branches": branches, "upstream": upstream, "base": base,
        "ahead": counts.first().and_then(|s| s.parse::<usize>().ok()).unwrap_or(0), "behind": counts.get(1).and_then(|s| s.parse::<usize>().ok()).unwrap_or(0) }))
}

fn request(app: &AppHandle, action: &str, root: &Path, args: &Value) -> Result<Value, String> {
    match action {
        "list" => {
            let path = child_path(root, arg(args, "path"))?;
            let mut entries = Vec::new();
            for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let file_type = entry.file_type().map_err(|e| e.to_string())?;
                let allowed = child_path(root, &relative(root, &entry.path())).is_ok();
                entries.push(json!({ "name": entry.file_name().to_string_lossy(), "path": relative(root, &entry.path()), "directory": allowed && entry.path().is_dir(), "symlink": file_type.is_symlink(), "blocked": !allowed }));
            }
            entries.sort_by(|a, b| b["directory"].as_bool().cmp(&a["directory"].as_bool()).then(arg(a, "name").to_lowercase().cmp(&arg(b, "name").to_lowercase())));
            Ok(json!(entries))
        }
        "read" => {
            let path = child_path(root, arg(args, "path"))?;
            let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
            if size > 12 * FILE_LIMIT { return Err("文件超过 24 MB，请使用外部应用打开".into()); }
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            let extension = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
            let mime = match extension.as_str() { "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp", "bmp" => "image/bmp", "ico" => "image/x-icon", _ => "" };
            let (kind, content) = if !mime.is_empty() { ("image", format!("data:{mime};base64,{}", STANDARD.encode(&bytes))) }
                else if bytes.starts_with(b"%PDF") { ("pdf", STANDARD.encode(&bytes)) }
                else if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() { ("binary", String::new()) }
                else { if size > FILE_LIMIT { return Err("文本文件超过 2 MB，请使用外部应用打开".into()); } ("text", String::from_utf8(bytes).map_err(|e| e.to_string())?) };
            Ok(json!({ "path": relative(root, &path), "kind": kind, "content": content, "size": size }))
        }
        "open" => {
            let path = child_path(root, arg(args, "path"))?;
            if !path.exists() { return Err("文件不存在".into()); }
            let mut command;
            #[cfg(windows)] { command = Command::new("explorer.exe"); command.creation_flags(0x08000000); }
            #[cfg(target_os = "macos")] { command = Command::new("open"); }
            #[cfg(all(not(windows), not(target_os = "macos")))] { command = Command::new("xdg-open"); }
            command.arg(path).spawn().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "review" => {
            if arg(args, "scope") == "turn" {
                let turn = load_turn(app, root, arg(args, "id"))?;
                Ok(json!({ "files": turn_changes(&turn)?, "skipped": turn.before.skipped.len() + turn.after.as_ref().map(|s| s.skipped.len()).unwrap_or(0), "undone": turn.undone }))
            } else { git_review(root, args) }
        }
        "diff" => {
            let file = arg(args, "path"); child_path(root, file)?;
            let context = context_radius(args);
            if arg(args, "scope") == "turn" {
                let turn = load_turn(app, root, arg(args, "id"))?;
                let after = turn.after.as_ref().ok_or("任务尚未完成")?;
                let old = turn.before.files.get(file).map(Vec::as_slice).unwrap_or_default();
                let new = after.files.get(file).map(Vec::as_slice).unwrap_or_default();
                let meta = changed(file, old, new, turn.before.files.contains_key(file), after.files.contains_key(file));
                Ok(json!({ "patch": if meta.binary { String::new() } else { patch(file, old, new, context) }, "binary": meta.binary }))
            } else {
                let comparison = if arg(args, "scope") == "branch" { format!("{}...HEAD", verify_ref(root, arg(args, "base"))?) } else { String::new() };
                let unified = format!("--unified={context}");
                let mut diff_args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", &unified];
                if arg(args, "scope") == "staged" { diff_args.push("--cached"); }
                if !comparison.is_empty() { diff_args.push(&comparison); }
                diff_args.extend(["--", file]);
                let mut output = String::from_utf8_lossy(&git_ok(root, &diff_args)?).into_owned();
                if output.is_empty() && arg(args, "scope") == "working" && git_ok(root, &["ls-files", "--", file])?.is_empty() {
                    let path = child_path(root, file)?;
                    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > FILE_LIMIT { return Ok(json!({ "patch": "", "binary": true })); }
                    let data = fs::read(path).map_err(|e| e.to_string())?;
                    if changed(file, &[], &data, false, true).binary { return Ok(json!({ "patch": "", "binary": true })); }
                    output = patch(file, &[], &data, context);
                }
                Ok(json!({ "binary": output.contains("Binary files ") || output.contains("GIT binary patch"), "patch": output }))
            }
        }
        "stage" | "unstage" => {
            let file = arg(args, "path"); mutation_path(root, file)?;
            if action == "stage" { git_ok(root, &["add", "--", file])?; }
            else if verify_ref(root, "HEAD").is_ok() { git_ok(root, &["restore", "--staged", "--", file])?; }
            else { git_ok(root, &["rm", "--cached", "--", file])?; }
            Ok(Value::Null)
        }
        "commit" => {
            let message = arg(args, "message").trim();
            if message.is_empty() { return Err("请输入提交说明".into()); }
            git_ok(root, &["commit", "-m", message])?; Ok(Value::Null)
        }
        "checkout" => {
            let branch = arg(args, "branch"); verify_ref(root, branch)?;
            git_ok(root, &["switch", "--", branch])?; Ok(Value::Null)
        }
        "turn_begin" => {
            let path = turn_path(app, arg(args, "id"))?;
            if path.exists() { return Err("回合快照已存在".into()); }
            save_turn(&path, &Turn { root: root.to_owned(), before: snapshot(root)?, after: None, undone: false })?;
            // Keep recent reviews across restarts while bounding disk usage.
            let directory = path.parent().ok_or("无效快照目录")?;
            let cutoff = SystemTime::now() - Duration::from_secs(30 * 86400);
            for entry in fs::read_dir(directory).map_err(|e| e.to_string())?.flatten() {
                if entry.path().extension().is_some_and(|v| v == "json") && entry.metadata().and_then(|m| m.modified()).is_ok_and(|v| v < cutoff) { let _ = fs::remove_file(entry.path()); }
            }
            Ok(Value::Null)
        }
        "turn_end" => {
            let id = arg(args, "id"); let mut turn = load_turn(app, root, id)?;
            if turn.after.is_none() { turn.after = Some(snapshot(root)?); save_turn(&turn_path(app, id)?, &turn)?; }
            Ok(json!({ "id": id, "files": turn_changes(&turn)?, "skipped": turn.before.skipped.len() + turn.after.as_ref().map(|s| s.skipped.len()).unwrap_or(0) }))
        }
        "turn_undo" => {
            let id = arg(args, "id"); let mut turn = load_turn(app, root, id)?;
            if turn.undone { return Err("这轮变更已经撤销".into()); }
            let after = turn.after.as_ref().ok_or("任务尚未结束")?;
            let changes = turn_changes(&turn)?;
            // Verify every current file before writing any file. Later edits
            // must never be silently replaced by an older turn's undo.
            for change in &changes {
                let path = mutation_path(root, &change.file)?;
                let current = if path.exists() { Some(fs::read(path).map_err(|e| e.to_string())?) } else { None };
                if current.as_ref() != after.files.get(&change.file) { return Err(format!("{} 已有后续修改，无法撤销这一轮", change.file)); }
            }
            let mut restored: Vec<String> = Vec::new();
            for change in &changes {
                let result = restore_file(root, &change.file, turn.before.files.get(&change.file));
                if let Err(error) = result {
                    let mut rollback_errors = Vec::new();
                    for file in restored.iter().rev() { if let Err(e) = restore_file(root, file, after.files.get(file)) { rollback_errors.push(e); } }
                    return Err(format!("撤销失败：{error}{}", if rollback_errors.is_empty() { String::new() } else { format!("；回滚失败：{}", rollback_errors.join("；")) }));
                }
                restored.push(change.file.clone());
            }
            turn.undone = true; save_turn(&turn_path(app, id)?, &turn)?;
            Ok(Value::Null)
        }
        _ => Err(format!("未知工作区操作：{action}")),
    }
}
fn restore_file(root: &Path, file: &str, bytes: Option<&Vec<u8>>) -> Result<(), String> {
    let path = mutation_path(root, file)?;
    if let Some(bytes) = bytes {
        if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        fs::write(path, bytes).map_err(|e| e.to_string())
    } else { fs::remove_file(path).map_err(|e| e.to_string()) }
}
#[tauri::command]
pub async fn workspace_request(app: AppHandle, webview: tauri::Webview, state: State<'_, WorkspaceState>, action: String, root: String, args: Value) -> Result<Value, String> {
    trusted(&webview)?;
    let mutations = state.mutations.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = mutations.lock().map_err(|e| e.to_string())?;
        request(&app, &action, &root_path(&root)?, &args)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn terminal_start(app: AppHandle, webview: tauri::Webview, state: State<'_, WorkspaceState>, id: String, root: String, cols: u16, rows: u16) -> Result<(), String> {
    trusted(&webview)?;
    let slots = state.terminals.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_path(&root)?;
        let mut guard = slots.lock().map_err(|e| e.to_string())?;
        if guard.contains_key(&id) { return Err("终端已经启动".into()); }
        if guard.len() >= 12 { return Err("最多同时打开 12 个终端".into()); }
        let pair = native_pty_system().openpty(PtySize { cols: cols.max(2), rows: rows.max(2), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
        let mut command = CommandBuilder::new(if cfg!(windows) { "powershell.exe".into() } else { std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()) });
        if cfg!(windows) { command.args(["-NoLogo", "-NoProfile"]); }
        command.cwd(root); command.env("TERM", "xterm-256color");
        let mut child: Box<dyn Child + Send + Sync> = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        guard.insert(id.clone(), TerminalSlot { master: pair.master, writer, killer });
        drop(guard);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(size) = reader.read(&mut buffer) {
                if size == 0 { break; }
                let _ = app.emit_to(tauri::EventTarget::webview("main"), "workspace-terminal", json!({ "id": id, "data": STANDARD.encode(&buffer[..size]) }));
            }
            let status = child.wait().ok().map(|s| s.exit_code());
            if let Ok(mut guard) = slots.lock() { guard.remove(&id); }
            let _ = app.emit_to(tauri::EventTarget::webview("main"), "workspace-terminal", json!({ "id": id, "exit": status }));
        });
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn terminal_write(webview: tauri::Webview, state: State<'_, WorkspaceState>, id: String, data: String) -> Result<(), String> {
    trusted(&webview)?;
    let mut slots = state.terminals.lock().map_err(|e| e.to_string())?;
    let slot = slots.get_mut(&id).ok_or("终端已关闭")?;
    slot.writer.write_all(data.as_bytes()).and_then(|_| slot.writer.flush()).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn terminal_resize(webview: tauri::Webview, state: State<'_, WorkspaceState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    trusted(&webview)?;
    let slots = state.terminals.lock().map_err(|e| e.to_string())?;
    slots.get(&id).ok_or("终端已关闭")?.master.resize(PtySize { cols: cols.max(2), rows: rows.max(2), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn terminal_close(webview: tauri::Webview, state: State<'_, WorkspaceState>, id: String) -> Result<(), String> {
    trusted(&webview)?;
    if let Some(mut slot) = state.terminals.lock().map_err(|e| e.to_string())?.remove(&id) { slot.killer.kill().map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
pub async fn browser_control(app: AppHandle, webview: tauri::Webview, id: String, action: String, args: Value) -> Result<(), String> {
    trusted(&webview)?;
    if !id.starts_with("browser-") || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("无效浏览器标签".into()); }
    match action.as_str() {
        "create" => {
            let url: tauri::Url = arg(&args, "url").parse().map_err(|_| "无效网址")?;
            if !matches!(url.scheme(), "http" | "https") { return Err("仅支持 HTTP 和 HTTPS 网页".into()); }
            let window = app.get_window("main").ok_or("主窗口不存在")?;
            let event_id = id.clone();
            let event_app = app.clone();
            let builder = tauri::webview::WebviewBuilder::new(&id, tauri::WebviewUrl::External(url))
                .on_navigation(|url| matches!(url.scheme(), "http" | "https"))
                .on_page_load(move |view, payload| {
                    let _ = event_app.emit_to(tauri::EventTarget::webview("main"), "workspace-browser", json!({"id": event_id, "url": payload.url().as_str(), "loading": matches!(payload.event(), tauri::webview::PageLoadEvent::Started), "title": view.label()}));
                });
            window.add_child(builder, tauri::LogicalPosition::new(args["x"].as_f64().unwrap_or(0.0), args["y"].as_f64().unwrap_or(0.0)), tauri::LogicalSize::new(args["width"].as_f64().unwrap_or(640.0).max(1.0), args["height"].as_f64().unwrap_or(480.0).max(1.0))).map_err(|e| e.to_string())?;
        }
        "close" => { if let Some(view) = app.get_webview(&id) { view.close().map_err(|e| e.to_string())?; } }
        _ => {
            let view = app.get_webview(&id).ok_or("网页已关闭")?;
            match action.as_str() {
                "bounds" => view.set_bounds(tauri::Rect { position: tauri::LogicalPosition::new(args["x"].as_f64().unwrap_or(0.0), args["y"].as_f64().unwrap_or(0.0)).into(), size: tauri::LogicalSize::new(args["width"].as_f64().unwrap_or(1.0).max(1.0), args["height"].as_f64().unwrap_or(1.0).max(1.0)).into() }).map_err(|e| e.to_string())?,
                "hide" => view.hide().map_err(|e| e.to_string())?,
                "show" => view.show().map_err(|e| e.to_string())?,
                "navigate" => {
                    let url: tauri::Url = arg(&args, "url").parse().map_err(|_| "无效网址")?;
                    if !matches!(url.scheme(), "http" | "https") { return Err("仅支持 HTTP 和 HTTPS 网页".into()); }
                    view.navigate(url).map_err(|e| e.to_string())?;
                }
                "back" => view.eval("history.back()").map_err(|e| e.to_string())?,
                "forward" => view.eval("history.forward()").map_err(|e| e.to_string())?,
                "reload" => view.eval("location.reload()").map_err(|e| e.to_string())?,
                _ => return Err("未知浏览器操作".into()),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_cannot_escape_the_workspace() {
        let root = fs::canonicalize(std::env::temp_dir()).unwrap();
        assert!(child_path(&root, "../outside").is_err());
        assert!(child_path(&root, "new-file.txt").is_ok());
        assert!(mutation_path(&root, ".git/config").is_err());
    }
    #[test]
    fn turn_diff_handles_additions_deletions_and_binary_files() {
        let before = Snapshot { files: BTreeMap::from([("old.txt".into(), b"old\n".to_vec()), ("binary".into(), vec![0, 1])]), skipped: BTreeSet::new() };
        let after = Snapshot { files: BTreeMap::from([("new.txt".into(), b"new\n".to_vec()), ("binary".into(), vec![0, 2])]), skipped: BTreeSet::new() };
        let changes = turn_changes(&Turn { root: PathBuf::new(), before, after: Some(after), undone: false }).unwrap();
        assert_eq!(changes.len(), 3);
        assert!(changes.iter().any(|c| c.file == "old.txt" && c.del == 1 && c.status == "deleted"));
        assert!(changes.iter().any(|c| c.file == "new.txt" && c.add == 1 && c.status == "added"));
        assert!(changes.iter().any(|c| c.file == "binary" && c.binary));
    }
}
