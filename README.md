# WEPI

React + Vite + Tauri 2 桌面应用。

## 开发

Windows 需要 Node.js、Rust（MSVC 工具链）、Visual Studio C++ Build Tools 和 WebView2 Runtime。

```sh
npm install
npm run desktop:dev
```

该命令自动启动 Vite 和桌面窗口，修改 React 代码可热更新。首次运行需要下载并编译 Rust 依赖。

仅在浏览器中预览：`npm run dev`。

## 构建

```sh
npm run desktop:build
```

Windows 安装包输出到 `src-tauri/target/release/bundle/nsis/`。
前端构建：`npm run build`。

`src-tauri/tauri.conf.json` 配置窗口及应用信息；`src-tauri/capabilities/default.json` 管理窗口权限。
自定义标题栏支持拖动、最小化、最大化/还原和关闭。聊天等业务功能沿用现有前端实现。

## Pi RPC

桌面端发送消息时会在 Tauri 进程中启动长期运行的 `pi --mode rpc --no-session` 子进程，React 通过 `src/lib/piRpc.ts` 发送 JSONL 命令并监听事件。Pi CLI 必须已安装并能从 PATH 找到；Windows 下 Tauri 会通过 `cmd.exe` 解析 `pi` / `pi.cmd`，也可以在调用 `startPiRpc` 时传入 `executable` 指定路径。项目示例路径不存在时会自动忽略 `cwd`，避免阻止 Pi 启动。

RPC 事件会映射到现有消息视图：`message_update` / `message_end` 更新回答文本，`tool_execution_start` 生成可展开的任务轨迹，`agent_settled` 结束流式状态。Pi 启动失败时会回退到内置演示回复，方便浏览器开发模式继续预览界面。

Pi 的 API 密钥、模型和会话配置由 Pi 自己管理。当前不会把前端演示用的模型 ID 强行发送给 Pi，避免 `openai:gpt-5` 这类 UI 占位值覆盖 Pi 的真实配置；后续模型下拉框应改为调用 Pi 的 `get_available_models`。

`example/pilo` 是运行时接入的主要参考：它按项目和会话维护 Pi 进程、使用 `chat_session_start` / `chat_session_send_rpc`、集中适配 Pi 事件并通过事件通道推送到前端。`example/PiDeck` 是配置与管理界面的参考，包含 Pi 安装检测、多 provider、Skill、MCP、插件和 Pi 版本管理。WEPI 的下一步会沿用这些边界，把 ChatGPT 风格界面接到同一套会话运行时。
