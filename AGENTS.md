# AGENTS.md

给在 WEPI 仓库里干活的 AI agent（以及新加入的人）看的操作手册。
用户向的说明在 [README.md](README.md)，这里只讲**代码在哪、改哪、怎么验、别踩什么**。

## 0. 三十秒理解

WEPI 是 Tauri 2 桌面壳，把 Pi coding agent 当子进程跑（`pi --mode rpc`，stdio JSONL）。
React 前端**从不直连 Pi**，一律经过 Rust。

```
输入框 → App.send() ──invoke──▶ Rust: write_record ──▶ Pi stdin
                                                          │
Pi stdout ──▶ normalize_rpc_record ──emit('pi-rpc-event')──┘
                    │
                    ▼
前端 piEventReducer.applyPiEvent → TurnBlock[] → ChatView / Steps → 屏幕
```

第二条通道只给"桌面能力"用（浏览器、模拟器、终端）：

```
Pi 调用工具 → 内置扩展 wepi-tools.ts → POST 127.0.0.1:<port>/tools（Bearer）
            → bridge.rs::respond → 模块 dispatch → adb / webview / 文件 → 结果回 Pi
```

三条铁律：**不给内部能力引 MCP**、**不往 `~/.pi` 写东西**（扩展靠 `--extension` 注入）、
**前端不解析 RPC 原始事件**（只吃归约后的 `TurnBlock`）。

## 1. 命令

| 目的 | 命令 |
|---|---|
| 只调前端（浏览器预览，Pi 功能不可用） | `npm run dev` |
| 完整桌面端（会编译 Rust） | `npm run desktop:dev` |
| 类型检查（提交前必过） | `npx tsc --noEmit` |
| Rust 检查 / 单测（提交前必过） | `cd src-tauri && cargo check && cargo test` |
| 真机联调（需一台运行中的 AVD `Medium_Phone`） | `cd src-tauri && cargo test -- --ignored` |
| 取帧性能探针 | `cd src-tauri && cargo test -- --ignored frame_paths_timing --nocapture` |
| 打包 | `npm run desktop:build` |

提交门槛：`tsc` 零错 + `cargo check` 无新警告 + `cargo test` 全绿。跑过 `desktop:dev` 的话顺手看一眼 stderr 有没有新的 `[wepi]` 报错。

## 2. 目录地图

### 前端 `src/`

| 路径 | 职责 | 什么时候动它 |
|---|---|---|
| `App.tsx` | 全局状态（项目/会话/导航/草稿/菜单/对话框）、发送流程、事件订阅 | 改跨视图行为；**已 1600+ 行，见 §5** |
| `data.ts` | 全部领域类型 + 初始数据 + `uid()` | 加/改数据结构 |
| `index.css` | Tailwind 4 + 主题变量（`--bg` `--text` `--border` …） | 改配色/全局样式 |
| `components/Sidebar.tsx` | 左栏：项目树 + 最近会话 + 右键菜单 | 改左栏 |
| `components/ChatView.tsx` | 聊天主体：消息流、粘滞滚动、附件行 | 改聊天布局 |
| `components/Steps.tsx` | 工具调用 / 思考步骤卡片 | 改工具过程展示 |
| `components/Composer.tsx` | 输入框、附件、模型与思考档位、斜杠菜单 | 改输入区 |
| `components/Markdown.tsx` | Markdown 渲染、代码块、链接拦截 | 改文本渲染 |
| `components/RightPanel.tsx` | 右栏：标签页 + 文件树/预览/diff/终端/网页 + 宽度拖拽 | 改右栏；**1100+ 行，见 §5** |
| `components/SimulatorView.tsx` | 模拟器面板（独立文件，作为新视图的范本） | 改模拟器 UI |
| `components/Attachments.tsx` | 附件 chip（图片 / 文件 / 页面元素） | 加附件类型 |
| `components/ApprovalCards.tsx` | 安全门审批卡 | 改审批交互 |
| `components/TodoStrip.tsx` | 待办条 | 改 todo 展示 |
| `components/kit.tsx` `ui.tsx` | 基础控件：`kit` 是 `Btn/Card/Field/Modal/PageShell/Segmented/Select/RenameInput`，`ui` 是 `IconBtn/Popover/MenuItem/Kbd/Toggle/AppIcon` | **新控件先加这里**，别就地搓 |
| `components/Dialogs.tsx` `ContextMenu.tsx` `SlashMenu.tsx` `ModelEffortPanel.tsx` `ContextUsage.tsx` `MessageNavigator.tsx` `Resizer.tsx` `TitleBar.tsx` | 单用途小组件 | 对应功能 |
| `components/Settings.tsx` + `components/pages/*` | 设置页、管理页（MCP / Skill / 扩展 / 版本） | 改设置与管理 |
| `lib/piRpc.ts` | IPC 封装：`ensurePiSession` `sendPiRpc` `listenPiRpc` `stopPiSession` `isDesktopRuntime` | 改与 Pi 的传输 |
| `lib/piEventReducer.ts` | **纯函数**归约器：RPC 事件 → `TurnBlock[]` | 改流式渲染逻辑 |
| `lib/piSession.ts` | 会话 JSONL 读取与摘要 | 改历史会话 |
| `lib/workspace.ts` | `workspace_request` 包装 + 路径/链接解析（`fileTarget`） | 改文件类调用 |
| `lib/attachments.ts` | 附件 → 提示词块 | 改附件如何进对话 |
| `lib/piAdmin.ts` `slashCommands.ts` `extensionUi.ts` `fs.ts` | 管理页调用、斜杠命令、扩展 UI 桥、文件选择 | 对应功能 |

### 后端 `src-tauri/src/`

| 路径 | 职责 |
|---|---|
| `lib.rs` | Pi 进程生命周期、RPC 归一化、会话扫描、命令注册、托盘；**1800 行，见 §5** |
| `workspace.rs` | 文件读写、git review/diff/提交、PTY 终端、子 webview（含网页元素拾取） |
| `simulator/` | 安卓模拟器：`mod.rs`（adb/截图/input/元素树）、`stream.rs`（取帧线程）、`tools.rs`（agent 工具）、`commands.rs`（面板 IPC） |
| `bridge.rs` | 回环工具桥：`tools/list` + `tools/call`，Bearer + 拒 Origin |
| `pi_mcp.rs` `pi_skills.rs` `pi_ext.rs` `pi_runtime.rs` | MCP 配置、Skill、扩展管理、Pi 安装与版本 |
| `wepi_settings.rs` `wepi_security.rs` | 应用偏好（`~/.wepi/settings.json`）、安全门策略快照 |
| `shell_open.rs` `tray.rs` `app_update.rs` `toml_lite.rs` | 打开外部程序、托盘、更新检查、极简 TOML |
| `browser/picker.js` | 注入 guest webview 的选择器脚本（**不是 Rust 模块**，别加 `mod`） |

### 内置 Pi 扩展 `src-tauri/extensions/`

| 文件 | 作用 |
|---|---|
| `wepi-security-gate.ts` | `pi.on('tool_call')` 审批，`ctx.ui.select('[WEPI_SECURITY_CONFIRM]…')` |
| `wepi-todo.ts` + `wepi-todo-state.ts` | todo widget（`ctx.ui.setWidget`） |
| `wepi-tools.ts` | 从 `WEPI_BRIDGE` 拉工具目录并 `pi.registerTool`；桥不在就静默跳过 |

打包时整目录由 `tauri.conf.json` 的 `resources` 复制，**新扩展不用改配置**。

## 3. 常见任务怎么下手

### A. 加一个右栏标签页

1. `lib/workspace.ts` 的 `TabKind` 加成员。
2. `RightPanel.tsx` 顶部三个 `Record<TabKind, …>`（`titles` / `icons` / `tools`）补齐——缺一个 `tsc` 立刻报错，这是故意的。
3. `RightPanel` 的渲染分支加 `{tab.kind === 'x' && <XView active={isActive} …/>}`。
4. 视图组件**单独一个文件**（照抄 `SimulatorView.tsx` 的骨架：`active` 控制取帧循环、`notice` 显示错误）。
5. 需要从别处（聊天里的链接、菜单）打开：走 `openKind` / `PanelTarget`，链接解析在 `workspace.ts::fileTarget`。

### B. 加一个 agent 工具

先判断能力放哪：

- **纯逻辑、Node 里就能做**（读写 Pi 会话、组织提示词）→ 直接在 `extensions/*.ts` 里 `pi.registerTool`，别绕 Rust。
- **需要 Rust 能力**（adb、文件系统、子进程、webview）→ 照模拟器那条路：

  1. 实现放对应 Rust 模块，尽量拆成纯函数 + 单元测试（`simulator::tools` 的 `dispatch` 就是纯函数，测试直接打）。
  2. 工具目录（名字 + 描述 + JSON Schema）写在模块的 `catalog()`，返回 `Vec<Value>`。
  3. `bridge.rs::call()` 里按前缀路由到该模块的 `dispatch`。
  4. 前端扩展不用改：`wepi-tools.ts` 启动时自动拉目录注册。
  5. 结果形状固定：`{ "content": [{ "type": "text", "text": … } | { "type": "image", "data": <base64>, "mimeType": … }], "isError"?: true }`。
  6. 失败要回 `isError` 结果（让模型看见并自我纠正），不要回 JSON-RPC error。

写工具描述时把"单位、坐标系、副作用"写清楚——模型只靠这段文字决定怎么调。

### C. 加一个 Rust IPC 命令

```rust
#[tauri::command]
async fn my_cmd(app: AppHandle, some_arg: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || { /* 耗时活 */ })
        .await.map_err(|e| e.to_string())?
}
```

- 注册到 `lib.rs` 的 `invoke_handler`。
- 前端 `invoke('my_cmd', { someArg })`：**JS 用 camelCase，Rust 用 snake_case**（Tauri 默认转换）。
- 阻塞操作（adb、扫盘、git）一律 `spawn_blocking`，别堵 IPC 线程。
- 起子进程一律包 `no_window(&mut command)`，否则 release 下会闪黑框。
- 事件用 `app.emit_to(EventTarget::webview("main"), "名字", payload)`，别 `emit` 全窗口。

### D. 改左栏

- `Sidebar.tsx` 是纯展示，只吃 props；状态在 `App.tsx`（`usePersistedStore` + `nav`）。
- 会话右键菜单在 `App.tsx::threadMenu`，项目菜单同理；加菜单项就加一个 `CtxItem`。
- 持久化：`loadStore` / `usePersistedStore`（localStorage）。

### E. 改聊天界面

数据流是单向的，别绕：

```
pi-rpc-event → piEventReducer.applyPiEvent(state, event) → TurnBlock[]
             → ChatView 遍历 → Steps / Markdown / 附件行
```

- 加一种新的块：`data.ts` 的 `TurnBlock` 联合加成员 → reducer 产出它 → `Steps.tsx` 渲染。
- 流式文本合并、工具增量合并都在 reducer 里，**不要**在组件里做节流或拼接。
- 粘滞滚动（用户上滑后不抢焦点）在 `ChatView`，动它之前先想清楚自动滚动的条件。

### F. 改设置 / 管理页

- `Settings.tsx` 管偏好（外观、关闭行为、安全等级），`pages/*` 管 MCP / Skill / 扩展 / 版本。
- 后端对应 `wepi_settings.rs` / `pi_mcp.rs` / `pi_skills.rs` / `pi_ext.rs` / `app_update.rs`。
- 偏好落盘 `~/.wepi/settings.json`；**不要**写 `~/.pi`（那是 Pi 自己的地盘）。

## 4. 约定

- **注释写"为什么"**，不写"是什么"；中文。非显然的取舍要留一句原因（"这里必须 resize_exact，否则…"）。
- **诊断日志** `eprintln!("[wepi] …")`，前缀固定，方便 `Select-String`。前端错误要有 toast / notice，不许空 `catch {}`。
- **单位**：模拟器坐标一律 dp（Android 的 dp == 逻辑像素）；时长一律 ms；屏幕尺寸走 `Screen { width, height, scale }`。
- **依赖宁缺毋滥**：加之前先翻 `Cargo.lock` / `package-lock.json`，已经在树里的才考虑提升为直接依赖（`image` 就是这么加的）。
- **`[profile.dev.package."*"] opt-level = 2` 别删**：图像编解码在 opt-level 0 下慢三十倍，删了面板直接卡成 0.6fps。
- **安全门只管内置工具**：自定义工具默认放行。需要确认时在扩展里自己调 `ctx.ui.confirm`，别指望 `wepi-security-gate.ts`。
- **提交**：一次改动一个 commit；消息中文，前缀 `feat: / fix: / chore: / docs:`；正文写清"为什么这么选"，因为半年后没人记得。

## 5. 文件体量纪律（重要）

**目标 ≤400 行，硬上限 600 行**（Rust 数据/协议类文件可到 800）。超了就拆，别等下次。

当前超标名单（2026-10）：

| 文件 | 行数 | 拆分方向 |
|---|---|---|
| `src-tauri/src/lib.rs` | 1806 | `rpc/process.rs`（进程与握手）、`rpc/normalize.rs`（事件归一化）、`sessions.rs`（扫描/摘要）、`commands.rs`（命令注册） |
| `src/App.tsx` | 1626 | `lib/store.ts`（`loadStore`/`usePersistedStore`）、`lib/threadMenu.ts`、`lib/sendTurn.ts`、`components/chat/*` |
| `src/components/RightPanel.tsx` | 1118 | `components/rightpanel/{FilesView,DiffView,TerminalView,WebView}.tsx` + `index.tsx` 只留标签栏与布局 |
| `src-tauri/src/simulator/mod.rs` | 1008 | `simulator/{adb,capture,input,tree}.rs`，`mod.rs` 只留类型与 re-export |
| `src/data.ts` | 867 | `types/`（按域拆：chat / workspace / simulator）+ `seed/`（初始数据） |

规矩：

- **新代码进新文件**；god file 只允许"删"，不允许"加"。
- 拆文件时保持 `mod.rs` / `index.ts` 只做导出和装配，行为不变就不改逻辑。
- 一个文件里出现第二个"职责"就拆，别等它长到 800 行。
- 新增子模块记得同步 §2 的目录地图（这份文档要一直准）。

## 6. 合作范式（人机分工）

这是本项目默认的协作方式，**不要越界**：

| 谁 | 负责 |
|---|---|
| **人** | 真实鼠标点击/拖拽、键盘输入、看画面、剪贴板、需要账号或凭据的操作、审美与产品判断 |
| **AI** | 读代码、写实现、`tsc` / `cargo check` / `cargo test`、单元与真机集成测试、读 stderr 与日志、git 操作 |

具体到执行：

- **不要自己抢鼠标**去点应用窗口做视觉验证。需要 UI 验证时，给一份清单：**点哪里 → 期望看到什么 → 出问题时贴哪段日志**，最多三步。
- 反过来，人报"点了没反应/很慢/显示不对"，先定位到文件与行，再改；不确定就加日志，别猜。
- 改完先自证：`tsc` + `cargo test`；模拟器相关再跑 `cargo test -- --ignored`（设备在跑的话）。
- 需要人跑的命令，给完整一行，别给半句。

## 7. 已知坑

- **E: 盘不支持硬链接**：新建文件别用会走硬链接的写入方式（报 `EISDIR`），用 `Set-Content`；`cargo` 的 "hard linking files in the incremental compilation cache failed" 是无害警告。
- **模拟器 GPU**：`-no-window -gpu auto` 最快；`-gpu host` 反而慢一倍（实测 1000ms vs 600ms 取帧）。
- **屏幕休眠**：`screencap` 返回纯黑图。工具已自动 `KEYCODE_WAKEUP` + 取消锁屏，并在文本里注明；面板不加这个副作用，靠 dock 的锁屏键。
- **`input text` 只吃可打印 ASCII**：中文得走输入法/剪贴板，别硬塞。
- **面板取帧走模拟器控制台**（`adb emu screenrecord screenshot`，~210ms）而不是 `exec-out screencap`（~750ms）；老模拟器不支持时连续失败 5 次自动降级，日志里会出现一条 `[wepi] 模拟器控制台截图不可用`。
- **子 webview 里的脚本不能抛异常**：`eval_with_callback` 会吞掉异常并回 `null`，注入脚本必须整体包 try/catch。
- **`example/`** 是 pandacode 参考仓库，已 ignore，别提交、别依赖。

## 8. 不要做的事

- 不给内部能力引 MCP，不写 `~/.pi`，不开第二条与 Pi 通信的通道。
- 不在 UI 线程做阻塞 I/O；不阻塞地 `sleep` 等子进程（用超时 + 轮询）。
- 不在组件里解析 RPC 原始事件。
- 不为了"顺手"往 god file 里塞新功能。
- 不提交 `example/`、`target/`、临时截图与测试会话。
