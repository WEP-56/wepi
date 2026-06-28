import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Settings,
  Check,
  ChevronLeft,
  ChevronDown,
  Folder,
  FolderPlus,
  Info,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Play,
  Plus,
  Paperclip,
  ShieldCheck,
  Brain,
  Gauge,
  FolderOpen,
  Terminal as TerminalIcon,
  Sparkles,
  ArrowUp,
  Trash2,
  Minus,
  Globe,
  Pin,
  Square,
  X,
} from "lucide-react";
import { createPreviewApi } from "./previewApi";
import { createBrowserApi } from "./browserApi";
import { ConfigSettingsPanel } from "./ConfigModal";
import { TerminalDock } from "./components/terminal/TerminalDock";
import { CloseIconButton } from "./components/ui/IconButton";
import { getComposerEnterIntent } from "./composerBehavior";
import {
  getProjectAgentSessionDisplay,
  isSameSessionPath,
} from "./agentListDisplay";
import { resolveLocale, setI18nLocale, t } from "./i18n";
import {
  pruneTerminalDockState,
  setTerminalDockCollapsed,
  setTerminalDockOpen,
  type TerminalDockStateByAgent,
} from "./terminalDockState";
import { useMessagePagination } from "./hooks/useMessagePagination";
import { useSessionLoader } from "./hooks/useSessionLoader";
import { LazyWrapper } from "./hooks/useLazyComponent";
import {
  AgentContextMenu,
  ConversationOutline,
  DrawerContent,
  EnvironmentDialog,
  FileContextMenu,
  ConfirmDialog,
  ImagePreviewModal,
  ModelPicker,
  ProjectAvatar,
  ProjectContextMenu,
  PromptSuggestions,
  RpcLogModal,
  SessionContextMenu,
  SessionHistoryModal,
  SessionFileSummary,
  SettingsModal,
  ThinkingPicker,
  TurnRow,
  UserBubble,
  AssistantText,
  ToolGroupCard,
  ThinkingBlock,
  ThinkingIndicator,
  applySuggestion,
  buildOutline,
  buildSuggestionItems,
  clearSuggestionTrigger,
  detectTrigger,
  displayPath,
  flattenFiles,
  groupToolMessages,
  matches,
  type DrawerPanel,
  type SessionModifiedFile,
} from "./components/app/AppParts";

const appIconUrl = new URL("../../../build/icon.png", import.meta.url).href;
import {
	getCaretOffset as getCaretOffsetOf,
	getRichInputCaretCoords,
	RichInput,
	type RichInputChip,
} from "./components/app/RichInput";
import { FileDiffViewer } from "./components/app/FileDiffViewer";
import { createDefaultExternalEditorSettings } from "../../shared/types";
import type {
  AgentRuntimeState,
  AgentTab,
  AppInfo,
  AppSettings,
  AppUpdateDownloadProgress,
  AppUpdateInfo,
  AvailableModel,
  PiCliUpdateResult,
  ExternalEditor,
  ChatMessage,
  FileTreeNode,
  ImageContent,
  PiCommand,
  PiInstallStatus,
  PiUpdateCheckResult,
  Project,
  SessionSummary,
  ThinkingUpdate,
} from "../../shared/types";

const isLanWeb =
  !window.piDesktop && window.location.protocol.startsWith("http");
const api =
  window.piDesktop ?? (isLanWeb ? createBrowserApi() : createPreviewApi());
// 输入框默认高度增加,提供更好的输入体验,适合多行输入和代码片段
const COMPOSER_MIN_HEIGHT = 240;
const COMPOSER_DEFAULT_TERMINAL_HEIGHT = 260;
const COMPOSER_MIN_TIMELINE_HEIGHT = 160;
const SIDEBAR_PROJECT_CHILD_PAGE_SIZE = 5;

function countContentLines(value: unknown) {
  if (typeof value !== "string") return 0;
  if (!value) return 0;
  return value.split(/\r\n|\r|\n/).length;
}

function getToolChangedLineCount(toolName: string, args: any) {
  // 会话结束摘要只能使用 renderer 已收到的工具参数,不能重新 diff 工作区;
  // 这里按编辑/写入工具的输入估算"本次触达行数",避免把用户在会话外的改动也计入。
  if (/edit|patch/i.test(toolName)) {
    const edits = Array.isArray(args?.edits) ? args.edits : undefined;
    if (edits) {
      return edits.reduce((total: number, edit: any) => {
        const oldLines = countContentLines(edit?.oldText ?? edit?.old_text);
        const newLines = countContentLines(edit?.newText ?? edit?.new_text);
        return total + Math.max(oldLines, newLines);
      }, 0);
    }
    return Math.max(
      countContentLines(args?.oldText ?? args?.old_text),
      countContentLines(args?.newText ?? args?.new_text),
    );
  }
  if (/write|create/i.test(toolName)) {
    return countContentLines(args?.content ?? args?.text ?? args?.data ?? args?.body);
  }
  return 0;
}

function getToolFilePath(args: any) {
  return typeof args?.filePath === "string"
    ? args.filePath
    : typeof args?.file_path === "string"
      ? args.file_path
      : typeof args?.path === "string"
        ? args.path
        : typeof args?.targetPath === "string"
          ? args.targetPath
          : typeof args?.target_path === "string"
            ? args.target_path
            : typeof args?.outputPath === "string"
              ? args.outputPath
              : typeof args?.output_path === "string"
                ? args.output_path
                : typeof args?.file === "string"
                  ? args.file
                  : typeof args?.fileName === "string"
                    ? args.fileName
                    : typeof args?.filename === "string"
                      ? args.filename
                      : undefined;
}

/** Extract new file content from tool args for historical diff display */
function getToolNewContent(toolName: string, args: any, originalContent?: string): string | undefined {
  if (!args) return undefined;
  if (/write|create/i.test(toolName) && typeof args.content === "string") return args.content;
  if (/edit|patch/i.test(toolName) && typeof args.oldText === "string" && typeof args.newText === "string" && originalContent) {
    const idx = originalContent.indexOf(args.oldText);
    if (idx >= 0) return originalContent.slice(0, idx) + args.newText + originalContent.slice(idx + args.oldText.length);
  }
  return undefined;
}

function displayProjectDirectoryName(project: Project) {
  if (isChatProject(project)) return "Chat";
  const normalizedPath = project.path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedPath.split("/").pop() || project.name || project.path;
}

function isChatProject(project?: Project) {
  return project?.kind === "chat";
}

function isAbsoluteFilePath(path: string) {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/");
}

function formatRuntimeCompact(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return String(value);
}

function resolveFileLinkPath(path: string, basePath?: string) {
  if (!path || isAbsoluteFilePath(path) || !basePath) return path;
  // 浏览器端不引入 Node path;按项目根路径分隔符拼接,满足点击 AI 输出的项目相对路径。
  const separator = basePath.includes("\\") ? "\\" : "/";
  return `${basePath.replace(/[\\/]+$/, "")}${separator}${path.replace(/^[\\/]+/, "")}`;
}

const EDITOR_LOGO_URLS: Record<string, string> = {
  vscode: new URL("./assets/editors/vscode.png", import.meta.url).href,
  cursor: new URL("./assets/editors/cursor.ico", import.meta.url).href,
  zed: new URL("./assets/editors/zed.png", import.meta.url).href,
  idea: new URL("./assets/editors/idea.svg", import.meta.url).href,
  webstorm: new URL("./assets/editors/webstorm.svg", import.meta.url).href,
  phpstorm: new URL("./assets/editors/phpstorm.svg", import.meta.url).href,
  pycharm: new URL("./assets/editors/pycharm.svg", import.meta.url).href,
};

function getEditorLogoUrl(editorId: string) {
  return EDITOR_LOGO_URLS[editorId];
}

function isReplacementForPendingAgent(agent: AgentTab, pending: AgentTab) {
  if (!pending.id.startsWith("pending-")) return false;
  if (agent.projectId !== pending.projectId || agent.cwd !== pending.cwd)
    return false;
  if (isSameSessionPath(agent.sessionPath, pending.sessionPath)) return true;
  if (pending.sessionPath && agent.createdAt >= pending.createdAt - 1000)
    return true;
  return (
    agent.title === pending.title && agent.createdAt >= pending.createdAt - 1000
  );
}

function isPendingAgentId(agentId?: string) {
  return Boolean(agentId?.startsWith("pending-"));
}

const NEW_SESSION_DRAFT_ID = "__new-session-draft__";

function migrateAgentRecord<T>(
  current: Record<string, T>,
  replacementById: Map<string, string>,
  liveIds: Set<string>,
) {
  const next: Record<string, T> = {};
  for (const [agentId, value] of Object.entries(current)) {
    const nextAgentId = replacementById.get(agentId) ?? agentId;
    if (liveIds.has(nextAgentId)) next[nextAgentId] = value;
  }
  return next;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [draggingProjectId, setDraggingProjectId] = useState<string>();
  const [dragOverProjectId, setDragOverProjectId] = useState<string>();
  const [agents, setAgents] = useState<AgentTab[]>([]);
  const [pendingAgents, setPendingAgents] = useState<AgentTab[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [activeAgentId, setActiveAgentId] = useState<string>();
  const activeAgentIdRef = useRef<string | undefined>(activeAgentId);
  activeAgentIdRef.current = activeAgentId;
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    new Set(),
  );
  const [activeAgentByProject, setActiveAgentByProject] = useState<
    Record<string, string>
  >({});
  const [messagesByAgent, setMessagesByAgent] = useState<
    Record<string, ChatMessage[]>
  >({});
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  /** Git 工作区中对比 HEAD 有变更的文件列表（用于右侧面板展示）。 */
  const [gitChangedFiles, setGitChangedFiles] = useState<
    { path: string; status: string }[]
  >([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsByProject, setSessionsByProject] = useState<
    Record<string, SessionSummary[]>
  >({});
  const [sessionLoadingByProject, setSessionLoadingByProject] = useState<
    Record<string, boolean>
  >({});
  const [visibleProjectChildCountByProject, setVisibleProjectChildCountByProject] =
    useState<Record<string, number>>({});
  const [commands, setCommands] = useState<PiCommand[]>([]);
  const [runtimeStateByAgent, setRuntimeStateByAgent] = useState<
    Record<string, AgentRuntimeState>
  >({});
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [externalEditors, setExternalEditors] = useState<ExternalEditor[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [thinkingPickerOpen, setThinkingPickerOpen] = useState(false);
  const [starterProjectId, setStarterProjectId] = useState<string>();
  const [starterProjectSearch, setStarterProjectSearch] = useState("");
  const [starterProjectMenuOpen, setStarterProjectMenuOpen] = useState(false);
  const [starterProjectBusy, setStarterProjectBusy] = useState(false);
  const [composerAccessMenuOpen, setComposerAccessMenuOpen] = useState(false);
  const [composerAccessMode, setComposerAccessMode] = useState<
    "ask" | "auto" | "full"
  >("ask");
  const [sendBehaviorMenuOpen, setSendBehaviorMenuOpen] = useState(false);
  const [fileActionsOpen, setFileActionsOpen] = useState(false);
  const [promptByAgent, setPromptByAgent] = useState<Record<string, string>>(
    {},
  );
  /** 当前进行的操作类型,用于按钮 loading 状态 */
  const [attachedImagesByAgent, setAttachedImagesByAgent] = useState<
    Record<string, ImageContent[]>
  >({});
  const [previewImage, setPreviewImage] = useState<ImageContent | null>(null);
  /** Goal 状态 */
  const [goalText, setGoalText] = useState<string>("");
  const goalTextRef = useRef("");
  const [goalStatus, setGoalStatus] = useState<"none" | "active" | "paused" | "complete">("none");
  const goalStatusRef = useRef<"none" | "active" | "paused" | "complete">("none");
  const [goalStartedAt, setGoalStartedAt] = useState(0);
  const goalStartedAtRef = useRef(0);
  const [goalCompletedAt, setGoalCompletedAt] = useState(0);
  const goalIterationRef = useRef(0);
  /** 标记是否已经在等待自动续接,防止多个异步续接冲突 */
  const goalContinuationPendingRef = useRef(false);
  /** 记录上次续接前已看到的 agent 响应,用于识别运行状态抖动造成的无进展空转。 */
  const goalLastResponseSignatureRef = useRef("");
  /** 最大自动续接次数,达到后暂停而不是伪装完成,避免目标未完成时进入死循环。 */
  const GOAL_MAX_CONTINUATIONS = 5;
  /** 上一次 isAgentBusy 状态,用于检测 busy→idle 转换 */
  const prevIsAgentBusyRef = useRef(false);

  /** 当前 agent 流式思考的实时文本,agent_end 时清空 */
  const [streamingThinking, setStreamingThinking] = useState<
    Record<string, string>
  >({});
  /** 每个 agent 最后一次会话的开始时间(status 变为 running 时记录),用 ref 避免 effect 闭包陈旧 */
  /** 每个 agent 最后一次会话的总时长(ms),仅在会话结束后更新 */
  /** 会话结束后固化的文件修改摘要;新一轮运行时继续展示上一轮结果,避免完成信息被隐藏。 */
  const [sessionFileSummaryByAgent, setSessionFileSummaryByAgent] = useState<
    Record<string, SessionModifiedFile[]>
  >({});
  /** 每轮回答完成后固化的文件修改摘要,key 为 assistant message id,便于卡片贴在对应回答后。 */
  const [turnFileSummaryByMessage, setTurnFileSummaryByMessage] = useState<
    Record<string, SessionModifiedFile[]>
  >({});
  // 记录每轮回答开始前已有的修改文件累计状态,用增量差异避免聊天卡片重复展示历史会话文件。
  const turnFileBaselineByAgentRef = useRef<
    Record<string, Map<string, SessionModifiedFile>>
  >({});
  const finalizedTurnByAgentRef = useRef<Record<string, string | null>>({});
  const agentStatusByAgentRef = useRef<Record<string, AgentTab["status"]>>({});
  /** RPC 日志,用于调试 */
  const [rpcLogs, setRpcLogs] = useState<
    Array<{
      id: string;
      agentId: string;
      direction: string;
      summary: string;
      data?: unknown;
      time: number;
    }>
  >([]);
  const [_logs, setLogs] = useState<string[]>([]); // 写入式调试日志,仅用于 onLog/onError 捕获
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  // 记录 composer 光标位置,用于光标相关的 @ / 触发检测与建议项替换。
  const [composerCursor, setComposerCursor] = useState(0);
  const [fileMenu, setFileMenu] = useState<{
    x: number;
    y: number;
    node: FileTreeNode;
  } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
    danger?: boolean;
    confirmLabel?: string;
  } | null>(null);
  const [renamingFile, setRenamingFile] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [renamingFileInput, setRenamingFileInput] = useState("");
  const [agentMenu, setAgentMenu] = useState<{
    x: number;
    y: number;
    agent: AgentTab;
  } | null>(null);
  const [sessionMenu, setSessionMenu] = useState<{
    x: number;
    y: number;
    projectId: string;
    session: SessionSummary;
  } | null>(null);
  const [agentActionLoading, setAgentActionLoading] = useState<
    "copy" | "export" | null
  >(null);
  const [sessionActionLoading, setSessionActionLoading] = useState<
    "copy" | "export" | null
  >(null);
  const [agentRenameTarget, setAgentRenameTarget] = useState<AgentTab | null>(
    null,
  );
  const [sessionRenameTarget, setSessionRenameTarget] = useState<{
    projectId: string;
    session: SessionSummary;
  } | null>(null);
  const [agentRenameValue, setAgentRenameValue] = useState("");
  const [agentRenaming, setAgentRenaming] = useState(false);
  const [projectMenu, setProjectMenu] = useState<{
    x: number;
    y: number;
    project: Project;
  } | null>(null);
  const [diffViewFile, setDiffViewFile] = useState<string | null>(null);
  const [diffViewMode, setDiffViewMode] = useState<"view" | "diff">("view");
  const [diffViewOriginalContent, setDiffViewOriginalContent] = useState<string>("");
  const [diffViewModifiedContent, setDiffViewModifiedContent] = useState<string | undefined>(undefined);
  const [toast, setToast] = useState<string | null>(null);
  // 历史命令相关状态
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyNavigating, setHistoryNavigating] = useState(false);
  const [savedPrompt, setSavedPrompt] = useState("");
  const [compacting, setCompacting] = useState(false);
  const [drawer, setDrawer] = useState<DrawerPanel | null>(null);
  const [sessionsProjectId, setSessionsProjectId] = useState<string>();
  const [sessionHistoryLoading, setSessionHistoryLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateDownloadProgress | null>(null);
  const [downloadedUpdatePath, setDownloadedUpdatePath] = useState<string | null>(null);
  const [upToDateVersion, setUpToDateVersion] = useState<string | null>(null);
  const [piUpdating, setPiUpdating] = useState(false);
  const [piUpdateChecking, setPiUpdateChecking] = useState(false);
  const [piUpdateCheck, setPiUpdateCheck] = useState<PiUpdateCheckResult | null>(null);
  const [piUpdateResult, setPiUpdateResult] = useState<PiCliUpdateResult | null>(null);
  const [windowAlwaysOnTop, setWindowAlwaysOnTop] = useState(false);
  const [_debugOpen, _setDebugOpen] = useState(false);
  /** RPC 日志弹窗目标 agent */
  const [rpcLogAgentId, setRpcLogAgentId] = useState<string | null>(null);
  /** 是否自动滚动到最新消息 */
  const [autoScroll, setAutoScroll] = useState(true);
  /** 是否显示"移动到最新"按钮 */
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  /** 会话定位跳转到尚未加载的旧消息时，先扩展分页再在 effect 中滚动定位；此状态保存待跳转的消息 id。 */
  const [pendingJumpId, setPendingJumpId] = useState<string | null>(null);
  /** 加载更多历史消息前的滚动锚点（旧 scrollHeight + scrollTop），用于渲染后按顶部锚定恢复滚动位置。 */
  const loadMoreAnchorRef = useRef<{ height: number; top: number } | null>(null);

  const [settings, setSettings] = useState<AppSettings>({
    useNativeTitleBar: true,
    showNativeMenu: false,
    sendShortcut: "enter-send",
    theme: "system",
    lightBackground: "white",
    language: "system",
    piEnvironmentChecked: false,
    closeToTray: true,
    enableNotifications: true,
    showThinking: true,
    showDevTools: false,
    piProxyEnabled: false,
    piProxyUrl: "http://127.0.0.1:7890",
    piProxyBypass: "localhost,127.0.0.1,::1",
    desktopProxyEnabled: false,
    desktopProxyUrl: "http://127.0.0.1:7890",
    desktopProxyBypass: "localhost,127.0.0.1,::1",
    customPiPath: "",
    rpcTimeout: 600_000,
    linkOpenMode: "external",
    maxEditorFileSizeMB: 5,
    externalEditors: createDefaultExternalEditorSettings(),
  });
  const [settingsNotice, setSettingsNotice] = useState("");
  const [piProxyNotice, setPiProxyNotice] = useState("");
  const [piProxyNoticeTone, setPiProxyNoticeTone] = useState<
    "info" | "success" | "error"
  >("info");
  const [piStatus, setPiStatus] = useState<PiInstallStatus | null>(null);
  const [piProxyChecking, setPiProxyChecking] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo>({
    version: "-",
    releasesUrl: "https://github.com/ayuayue/pi-desktop/releases",
  });
  const [piChecking, setPiChecking] = useState(false);
  const resolvedLocale = resolveLocale(settings.language);
  setI18nLocale(resolvedLocale);
  // 手动输入 pi 路径相关状态
  const [customPiPath, setCustomPiPath] = useState("");
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [customPathResult, setCustomPathResult] =
    useState<PiInstallStatus | null>(null);
  const [environmentDialog, setEnvironmentDialog] = useState(false);
  const DEFAULT_LIST_WIDTH = 250;
  const [listWidth, setListWidth] = useState(DEFAULT_LIST_WIDTH);
  const [drawerWidth, setDrawerWidth] = useState(270);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_MIN_HEIGHT);
  const [composerOffsetHeight, setComposerOffsetHeight] = useState(0);
  const [composerAutoHeight, setComposerAutoHeight] =
    useState(COMPOSER_MIN_HEIGHT);
  const [terminalDockStateByAgent, setTerminalDockStateByAgent] =
    useState<TerminalDockStateByAgent>({});
  const [terminalHeightByAgent, setTerminalHeightByAgent] = useState<
    Record<string, number>
  >({});
  const [listCollapsed, setListCollapsed] = useState(false);
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);
  const [drawerPinnedByAgent, setDrawerPinnedByAgent] = useState<
    Record<string, DrawerPanel>
  >({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const chatPaneRef = useRef<HTMLElement | null>(null);
  const fileActionsRef = useRef<HTMLDivElement | null>(null);
  const starterProjectMenuRef = useRef<HTMLDivElement | null>(null);
  const composerAccessRef = useRef<HTMLDivElement | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement | null>(null);
  const chatHeaderRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);
  const timelineRef = useRef<HTMLElement | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLDivElement | null>(null);
  // RichInput 受控重渲染后,光标应恢复到的纯文本偏移(供建议选中/清除后恢复选区)。
  const pendingComposerCaretRef = useRef<number | null>(null);
  const pendingAgentsRef = useRef<AgentTab[]>([]);
  const projectDragPreventClickRef = useRef(false);

  const activeProject = projects.find(
    (project) => project.id === activeProjectId,
  );
  const sessionsProject = projects.find(
    (project) => project.id === sessionsProjectId,
  );
  const displayAgents = useMemo(() => {
    const realIds = new Set(agents.map((agent) => agent.id));
    return [
      ...agents,
      ...pendingAgents.filter(
        (agent) =>
          !realIds.has(agent.id) &&
          !agents.some((realAgent) =>
            isReplacementForPendingAgent(realAgent, agent),
          ),
      ),
    ];
  }, [agents, pendingAgents]);
  // displayAgents 的 ref，供只挂载一次的 IPC 监听器读取最新 Agent 列表，避免闭包陈旧
  const displayAgentsRef = useRef(displayAgents);
  displayAgentsRef.current = displayAgents;
  const activeAgent = displayAgents.find((agent) => agent.id === activeAgentId);
  const composerDraftId = activeAgentId ?? NEW_SESSION_DRAFT_ID;
  const prompt = promptByAgent[composerDraftId] ?? "";
  const attachedImages = attachedImagesByAgent[composerDraftId] ?? [];

  function setPrompt(value: string | ((current: string) => string)) {
    const targetAgentId = activeAgentIdRef.current ?? NEW_SESSION_DRAFT_ID;
    setPromptByAgent((current) => {
      const previous = current[targetAgentId] ?? "";
      const nextValue = typeof value === "function" ? value(previous) : value;
      if (!nextValue) {
        const next = { ...current };
        delete next[targetAgentId];
        return next;
      }
      return {
        ...current,
        [targetAgentId]: nextValue,
      };
    });
  }

  function setAttachedImages(
    value: ImageContent[] | ((current: ImageContent[]) => ImageContent[]),
  ) {
    const targetAgentId = activeAgentId ?? NEW_SESSION_DRAFT_ID;
    setAttachedImagesByAgent((current) => {
      const previous = current[targetAgentId] ?? [];
      const nextValue = typeof value === "function" ? value(previous) : value;
      if (nextValue.length === 0) {
        const next = { ...current };
        delete next[targetAgentId];
        return next;
      }
      return {
        ...current,
        [targetAgentId]: nextValue,
      };
    });
  }
  const terminalDockState = activeAgentId
    ? terminalDockStateByAgent[activeAgentId]
    : undefined;
  // 终端打开/折叠状态按 agent 隔离,避免切换项目/agent 后丢失当前终端 UI 状态。
  const terminalOpen = Boolean(terminalDockState?.open);
  const terminalCollapsed = Boolean(terminalDockState?.collapsed);
  const drawerPinnedPanel = activeAgentId
    ? drawerPinnedByAgent[activeAgentId]
    : undefined;
  const drawerPinned = Boolean(drawerPinnedPanel);
  const activeMessages = activeAgentId
    ? (messagesByAgent[activeAgentId] ?? [])
    : [];
  const activeRuntimeState = activeAgentId
    ? runtimeStateByAgent[activeAgentId]
    : undefined;
  const chatProject = projects.find(isChatProject);
  const normalProjects = projects.filter((project) => !isChatProject(project));
  const starterSelectedProject =
    projects.find((project) => project.id === starterProjectId) ??
    activeProject ??
    chatProject ??
    projects[0];
  const starterSelectedProjectId = starterSelectedProject?.id;
  const starterProjectLabel = starterSelectedProject
    ? isChatProject(starterSelectedProject)
      ? t("app.starterNoProject")
      : displayProjectDirectoryName(starterSelectedProject)
    : t("app.starterSelectProject");
  const starterProjectQuery = starterProjectSearch.trim().toLowerCase();
  const filteredStarterProjects = starterProjectQuery
    ? normalProjects.filter((project) =>
        `${displayProjectDirectoryName(project)} ${project.path}`
          .toLowerCase()
          .includes(starterProjectQuery),
      )
    : normalProjects;

  // 消息分页:超过 100 条消息时启用,大幅减少输入卡顿
  // 首屏 100 条,每次加载 100 条,一页一页懒加载
  const {
    visibleMessages: paginatedMessages,
    hasMore: hasMoreMessages,
    loadMore: loadMoreMessages,
    loadUntilIncluded: loadMessagesUntilIncluded,
    isLoading: isLoadingMoreMessages,
  } = useMessagePagination({
    messages: activeMessages,
    initialPageSize: 100, // 首屏 100 条
    pageSize: 100,        // 每次加载 100 条
    enabled: activeMessages.length > 100, // 超过 100 条才启用
  });

  const renderedMessages = useMemo(
    () => groupToolMessages(paginatedMessages),
    [paginatedMessages],
  );
  const isAwaitingAssistant = Boolean(
    activeAgent &&
    (activeAgent.status === "running" || activeRuntimeState?.isStreaming) &&
    activeMessages.at(-1)?.role !== "assistant",
  );
  /** 正在流式追加的最后一条 assistant 消息的 id（agent 处于运行/流式状态时才有值）。
   *  用于让对应 AssistantText 走轻量渲染路径，避免每个 token 都对不断增长的全量正文
   *  反复运行 KaTeX 数学解析导致渲染主线程卡死；回答结束后切回完整渲染。 */
  const streamingMessageId = useMemo(() => {
    if (!activeAgent || activeAgent.status !== "running") return undefined;
    if (!(activeRuntimeState?.isStreaming)) return undefined;
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      const m = activeMessages[i];
      if (m.role === "user") break;
      // 跳过纯 thinking / 工具消息，定位最后一条有实际正文的 assistant 消息
      if (m.role === "assistant" && (m.text || "").trim()) return m.id;
    }
    return undefined;
  }, [activeAgent, activeRuntimeState, activeMessages]);

  /** 当前活跃 agent 的实时思考文本 */
  const activeThinking = activeAgentId
    ? (streamingThinking[activeAgentId] ?? "")
    : "";
  const activeTerminalHeight = activeAgentId
    ? (terminalHeightByAgent[activeAgentId] ?? COMPOSER_DEFAULT_TERMINAL_HEIGHT)
    : COMPOSER_DEFAULT_TERMINAL_HEIGHT;
  const visibleTerminalHeight = terminalOpen
    ? terminalCollapsed
      ? 34
      : activeTerminalHeight
    : 0;
  const resolvedComposerHeight = Math.max(composerHeight, composerAutoHeight);
  const composerMode = prompt.startsWith("!!")
    ? "silent-shell"
    : prompt.startsWith("!")
      ? "shell"
      : null;
  const composerStatusText =
    composerMode === "silent-shell"
      ? t("app.composerSilentStatus")
      : composerMode === "shell"
        ? t("app.composerShellStatus")
        : drawer === "files"
          ? t("app.composerFilesStatus")
          : drawer === "sessions"
            ? t("app.composerSessionStatus", {
                name: sessionsProject?.name ?? t("common.project"),
              })
            : (activeAgent?.sessionPath ?? "");
  const contextPercentRaw = activeRuntimeState?.contextPercent;
  const contextPercent =
    typeof contextPercentRaw === "number" && Number.isFinite(contextPercentRaw)
      ? Math.max(0, Math.min(100, contextPercentRaw))
      : 0;
  const contextRingStyle = {
    "--context-percent": `${contextPercent}%`,
  } as React.CSSProperties;
  const contextTitle =
    contextPercentRaw != null
      ? t("app.composerContextTitle", {
          percent: contextPercentRaw.toFixed(1),
          window: formatRuntimeCompact(activeRuntimeState?.contextWindow),
        })
      : t("app.composerContextUnavailable");
  const cacheText =
    activeRuntimeState?.cacheTotal != null
      ? t("app.composerCacheValue", {
          value: formatRuntimeCompact(activeRuntimeState.cacheTotal),
        })
      : t("app.composerCacheEmpty");
  const composerAccessLabel =
    composerAccessMode === "full"
      ? t("app.composerAccessFull")
      : composerAccessMode === "auto"
        ? t("app.composerAccessAuto")
        : t("app.composerAccessAsk");

  useEffect(() => {
    if (!drawerPinnedPanel) return;
    if (drawer !== drawerPinnedPanel) setDrawer(drawerPinnedPanel);
    if (drawerCollapsed) setDrawerCollapsed(false);
  }, [drawer, drawerCollapsed, drawerPinnedPanel]);

  useEffect(() => {
    document.documentElement.lang = resolvedLocale;
  }, [resolvedLocale]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolvedTheme =
        settings.theme === "system"
          ? media?.matches
            ? "dark"
            : "light"
          : settings.theme;
      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.dataset.lightBackground = settings.lightBackground;
    };
    applyTheme();
    if (settings.theme !== "system" || !media) return;
    media.addEventListener?.("change", applyTheme);
    return () => media.removeEventListener?.("change", applyTheme);
  }, [settings.theme, settings.lightBackground]);

  /** 当前会话中 agent 修改过的文件(从 tool 消息 meta 中提取) */
  // 优化:只在消息数量变化时才重新计算,减少不必要的遍历
  const modifiedFiles = useMemo(() => {
    const byPath = new Map<string, SessionModifiedFile>();
    for (const msg of activeMessages) {
      if (msg.role !== "tool") continue;
      const toolName: string | undefined = msg.meta?.toolName as
        | string
        | undefined;
      const args: any = msg.meta?.args;
      const status: string = String(msg.meta?.status ?? "done");
      // 只收集文件写入/编辑类的工具调用，作为右侧 Files 与会话结束摘要的统一数据源。
      if (!toolName || !/write|edit|create|patch/i.test(toolName)) continue;
      const filePath = getToolFilePath(args);
      if (!filePath) continue;
      const previous = byPath.get(filePath);
      // 同一路径再次被修改时移动到 Map 末尾，右侧修改清单才能按"最新修改"展示。
      if (previous) byPath.delete(filePath);
      // 从消息 meta 中提取工具执行前的文件原始内容，用于差异编辑器的对比基准。
      const originalContent = msg.meta?.originalContent as string | undefined;
      byPath.set(filePath, {
        path: filePath,
        toolName,
        status: status === "running" ? "running" : (previous?.status ?? status),
        changedLines:
          (previous?.changedLines ?? 0) +
          getToolChangedLineCount(toolName, args),
        // 同一路径多次修改时保留首次记录的 originalContent，历史会话恢复时优先使用
        originalContent: previous?.originalContent ?? originalContent ?? "",
        content: getToolNewContent(toolName, args, originalContent) ?? previous?.content,
      });
    }
    return Array.from(byPath.values());
  }, [activeMessages.length, activeAgentId]);
  // 优化:轮廓项计算仅在消息数量变化时触发,减少不必要的重计算
  const outlineItems = useMemo(
    () => buildOutline(activeMessages),
    [activeMessages.length, activeAgentId],
  );
  const flatFiles = useMemo(() => flattenFiles(files), [files]);
  // 优化:建议项计算仅在必要时触发,避免每次输入都重计算导致卡顿
  // 只有当建议框打开时才计算,关闭时返回空数组
  // 以光标位置为锚检测触发器,使文字中间也能唤出 @ 文件 / / 命令菜单。
  const suggestionItems = useMemo(
    () =>
      suggestionsOpen
        ? buildSuggestionItems(prompt, composerCursor, commands, flatFiles)
        : [],
    [suggestionsOpen, prompt, composerCursor, commands, flatFiles],
  );

  /** 菜单光标锚定位置（屏幕坐标），仅在 suggestionsOpen 时计算。 */
  const suggestionAnchorStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!suggestionsOpen) return undefined;
    const root = composerTextareaRef.current;
    if (!root) return undefined;
    const coords = getRichInputCaretCoords(root, composerCursor);
    if (!coords) return undefined;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const menuW = Math.min(520, vw - 120);
    const menuH = 380;
    const gap = 8;

    // 水平：光标左对齐，超出则右贴边
    let left = coords.left;
    if (left + menuW > vw - 16) left = Math.max(16, vw - menuW - 16);

    // 垂直：优先光标下方，空间不够则上方
    const belowTop = coords.top + gap;
    const aboveBottom = coords.top - gap;
    if (belowTop + menuH <= vh - 16) {
      return { top: belowTop, left, bottom: "auto", transform: "none" };
    }
    if (aboveBottom - menuH >= 0) {
      return { top: "auto", bottom: vh - aboveBottom, left, transform: "none" };
    }
    return { top: "auto", bottom: 16, left, transform: "none" };
  }, [suggestionsOpen, composerCursor]);
  const visibleAgents = useMemo(
    () =>
      displayAgents.filter((agent) =>
        matches(agent.title + agent.cwd + (agent.sessionId ?? ""), search),
      ),
    [displayAgents, search],
  );
  const filteredAgents = visibleAgents;
  const filteredProjects = useMemo(
    () =>
      projects.filter((project) => {
        const projectSessions = sessionsByProject[project.id] ?? [];
        return (
          matches(project.name + project.path, search) ||
          displayAgents.some(
            (agent) =>
              agent.projectId === project.id &&
              matches(
                agent.title + agent.cwd + (agent.sessionId ?? ""),
                search,
              ),
          ) ||
          projectSessions.some((session) =>
            matches(
              `${session.name ?? ""}${session.preview}${session.filePath}`,
              search,
            ),
          )
        );
      }),
    [displayAgents, projects, search, sessionsByProject],
  );
  const projectIdsKey = useMemo(
    () => projects.map((project) => project.id).join("\n"),
    [projects],
  );
  const canReorderProjects = search.trim().length === 0;

  useEffect(() => {
    window.setTimeout(() => void refreshProjects(), 0);
    window.setTimeout(() => void api.agents.list().then(setAgents), 0);
    void api.editors.list().then(setExternalEditors).catch(() => setExternalEditors([]));
    void api.app
      .info()
      .then(setAppInfo)
      .catch(() => undefined);
    void api.settings.get().then((next) => {
      setSettings(next);
      setCustomPiPath(next.customPiPath ?? "");
      if (!Object.values(next.externalEditors).some((editor) => editor.command)) {
        void api.editors
          .redetect()
          .then((updated) => {
            setSettings(updated);
            return api.editors.list();
          })
          .then(setExternalEditors)
          .catch(() => undefined);
      }
      if (!next.piEnvironmentChecked) {
        // 首次检测延后一帧启动,先让主界面完成绘制,避免 packaged app 打开时出现几秒白屏。
        window.setTimeout(() => void checkPiInstall("startup"), 300);
      }
      window.setTimeout(() => void checkPiCliUpdateOnStartup(), 1200);
    });

    // 加载历史命令
    try {
      const savedHistory = localStorage.getItem("pideck-command-history");
      if (savedHistory) {
        setCommandHistory(JSON.parse(savedHistory));
      }
    } catch (error) {
      console.error("Failed to load command history:", error);
    }

    const offProjects = api.projects.onChanged((next) => {
      setProjects(next);
      if (!activeProjectId && next.length > 0) setActiveProjectId(next[0].id);
    });
    const offState = api.agents.onState((nextAgents) => {
      const previousPendingAgents = pendingAgentsRef.current;
      const remainingPendingAgents = previousPendingAgents.filter(
        (pending) =>
          !nextAgents.some((agent) =>
            isReplacementForPendingAgent(agent, pending),
          ),
      );
      const pendingReplacementById = new Map(
        previousPendingAgents
          .map((pending) => {
            const replacement = nextAgents.find((agent) =>
              isReplacementForPendingAgent(agent, pending),
            );
            return replacement ? [pending.id, replacement.id] : undefined;
          })
          .filter((entry): entry is [string, string] => Boolean(entry)),
      );
      if (remainingPendingAgents.length !== previousPendingAgents.length) {
        pendingAgentsRef.current = remainingPendingAgents;
        setPendingAgents(remainingPendingAgents);
      }
      setAgents(nextAgents);
      setActiveAgentId((current) => {
        if (!current) return undefined;
        if (nextAgents.some((agent) => agent.id === current)) return current;
        const pendingAgent = previousPendingAgents.find(
          (agent) => agent.id === current,
        );
        const replacement = pendingAgent
          ? nextAgents.find((agent) =>
              isReplacementForPendingAgent(agent, pendingAgent),
            )
          : undefined;
        if (replacement) return replacement.id;
        return pendingAgent ? current : undefined;
      });
      const activeIds = new Set(nextAgents.map((agent) => agent.id));
      const draftIds = new Set([
        ...nextAgents.map((agent) => agent.id),
        ...remainingPendingAgents.map((agent) => agent.id),
      ]);
      setTerminalDockStateByAgent((current) =>
        pruneTerminalDockState(current, activeIds),
      );
      setTerminalHeightByAgent((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([agentId]) => activeIds.has(agentId)),
        ),
      );
      setDrawerPinnedByAgent((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([agentId]) => activeIds.has(agentId)),
        ),
      );
      setPromptByAgent((current) =>
        migrateAgentRecord(current, pendingReplacementById, draftIds),
      );
      setAttachedImagesByAgent((current) =>
        migrateAgentRecord(current, pendingReplacementById, draftIds),
      );
    });
    // 优化:历史会话加载时消息更新频繁,只在消息真正变化时更新 state,避免不必要的重渲染导致输入卡顿
    const offMessages = api.agents.onMessages((payload) =>
      setMessagesByAgent((current) => {
        const prevMessages = current[payload.agentId];
        // 消息数量相同且引用相同时跳过更新,减少输入框重渲染
        if (
          prevMessages?.length === payload.messages.length &&
          prevMessages === payload.messages
        ) {
          return current;
        }
        return {
          ...current,
          [payload.agentId]: payload.messages,
        };
      }),
    );
    const offLog = api.agents.onLog((payload) =>
      setLogs((current) => {
        // 优化:只在超过200条时才slice,减少不必要的数组操作
        const newLog = `[${payload.agentId.slice(0, 8)}] ${payload.text}`;
        if (current.length < 200) {
          return [...current, newLog];
        }
        return [...current.slice(-199), newLog];
      }),
    );
    const offSettings = api.settings.onApplyWindow(() =>
      setSettingsNotice(t("settings.restartNotice")),
    );
    const offUpdateProgress = api.app.onUpdateProgress((progress) => {
      setUpdateProgress(progress);
      if (progress.state === "completed") {
        setUpdateDownloading(false);
        setDownloadedUpdatePath(progress.filePath ?? null);
      } else if (progress.state === "failed") {
        setUpdateDownloading(false);
        setUpdateError(progress.error ?? t("update.downloadFailed"));
      }
    });
    // 监听后端主动推送的 runtimeState 更新(如 agent_end 时重置 isStreaming),
    // 确保前端 isAgentBusy 判断基于最新状态,排队 flush 能正常触发。
    const offRuntimeState = api.agents.onRuntimeState((payload) =>
      setRuntimeStateByAgent((current) => ({
        ...current,
        [payload.agentId]: payload.state,
      })),
    );
    // 监听流式思考内容更新,用于在 agent 响应前展示推理过程
    const offThinking = api.agents.onThinking((payload: ThinkingUpdate) =>
      setStreamingThinking((current) => ({
        ...current,
        [payload.agentId]: payload.thinking,
      })),
    );
    // 监听 RPC 日志,保留最近 2000 条用于调试;message_update 高频事件很多,
    // 200 条很容易在一次长响应中被刷掉,但仍设置上限避免 renderer 内存无限增长。
    const offRpcLog = api.agents.onRpcLog((payload) =>
      setRpcLogs((current) => {
        // 优化:避免频繁创建新数组,只在超过上限时才slice
        const newLog = {
          id: crypto.randomUUID(),
          agentId: payload.agentId,
          direction: payload.direction,
          summary: payload.summary,
          data: payload.data,
          time: Date.now(),
        };
        if (current.length < 2000) {
          return [...current, newLog];
        }
        return [...current.slice(-1999), newLog];
      }),
    );

    return () => {
      offProjects();
      offState();
      offMessages();
      offLog();
      offSettings();
      offUpdateProgress();
      offRuntimeState();
      offThinking();
      offRpcLog();
    };
  }, []);

  // 桌面宠物点击跳转：主进程通知激活某 Agent，切到对应 project + agent tab
  useEffect(() => {
    const projectIds = new Set(projects.map((project) => project.id));
    setSessionsByProject((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([projectId]) =>
          projectIds.has(projectId),
        ),
      ),
    );
    setVisibleProjectChildCountByProject((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([projectId]) =>
          projectIds.has(projectId),
        ),
      ),
    );
    setSessionLoadingByProject((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([projectId]) =>
          projectIds.has(projectId),
        ),
      ),
    );
    // 启动时只加载 chat 项目的会话,其他项目延迟到展开时加载
    for (const project of projects) {
      if (project.kind === "chat") {
        void refreshProjectSessions(project.id).catch(() => undefined);
      }
    }
  }, [projectIdsKey]);

  useEffect(() => {
    if (activeAgentId && !isPendingAgentId(activeAgentId))
      void refreshRuntimeState(activeAgentId);
  }, [activeAgentId]);

  useEffect(() => {
    const activeIds = new Set(displayAgents.map((agent) => agent.id));
    setTerminalDockStateByAgent((current) =>
      pruneTerminalDockState(current, activeIds),
    );
  }, [displayAgents]);

  function getComposerMaxHeight() {
    const chatPane = chatPaneRef.current;
    const header = chatHeaderRef.current;
    const composer = composerRef.current;
    const box = composerBoxRef.current;
    if (!chatPane || !header || !composer || !box) {
      const reservedTerminalHeight = visibleTerminalHeight;
      return Math.max(
        180,
        window.innerHeight -
          78 -
          COMPOSER_MIN_TIMELINE_HEIGHT -
          52 -
          reservedTerminalHeight,
      );
    }

    const reservedTerminalHeight = visibleTerminalHeight;
    const composerChrome = Math.max(
      0,
      composer.offsetHeight - box.offsetHeight,
    );
    // 输入框最大高度取决于聊天区域还剩多少可用空间,而不是固定视口比例;
    // 否则窗口变窄后软换行变多,最小窗口下会比内容需要的高度更早触顶。
    return Math.max(
      180,
      chatPane.clientHeight -
        header.offsetHeight -
        COMPOSER_MIN_TIMELINE_HEIGHT -
        reservedTerminalHeight -
        composerChrome,
    );
  }

  function clampComposerHeight(height: number) {
    const maxHeight = getComposerMaxHeight();
    return Math.min(maxHeight, Math.max(COMPOSER_MIN_HEIGHT, height));
  }

  function ensureComposerTailVisible() {
    const editor = composerTextareaRef.current;
    if (!editor || document.activeElement !== editor) return;
    // RichInput 用纯文本偏移表示光标;光标在末尾时同步滚动到底,行为与原 textarea 一致。
    const len = editor.textContent?.length ?? 0;
    const atEnd = getCaretOffsetOf(editor) >= len;
    if (!atEnd) return;
    requestAnimationFrame(() => {
      const current = composerTextareaRef.current;
      if (!current) return;
      current.scrollTop = current.scrollHeight;
    });
  }

  function syncComposerAutoHeight() {
    const box = composerBoxRef.current;
    const editor = composerTextareaRef.current;
    if (!box || !editor) return;

    // 宽度变化会改变软换行位置,编辑区的 scrollHeight 才是当前内容真实需要的高度。
    // 这里减去 chrome 高度(顶部留白/工具条/底部状态条),把问题修在布局源头而不是靠用户手动拖。
    const chromeHeight = box.offsetHeight - editor.clientHeight;
    const nextHeight = clampComposerHeight(
      editor.scrollHeight + chromeHeight,
    );
    setComposerAutoHeight((current) =>
      Math.abs(current - nextHeight) <= 1 ? current : nextHeight,
    );
    ensureComposerTailVisible();
  }

  function scrollToBottom() {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
    setAutoScroll(true);
    setShowScrollToBottom(false);
  }

  // 给定位命中的消息元素加一个短暂的高亮动画，方便用户在长会话中快速识别跳转落点。
  function highlightMessageElement(el: HTMLElement) {
    el.classList.remove("message-jump-highlight");
    // 强制 reflow 以便重复跳转同一条消息时仍能重新触发动画。
    void el.offsetWidth;
    el.classList.add("message-jump-highlight");
    window.setTimeout(() => el.classList.remove("message-jump-highlight"), 2000);
  }

  // 点击“加载更多历史消息”：先记录当前滚动锚点，再触发分页加载，
  // 渲染后的 effect 会根据新增高度补偿 scrollTop，保持视图稳定。
  function handleLoadMoreMessages() {
    const timeline = timelineRef.current;
    if (timeline) {
      loadMoreAnchorRef.current = {
        height: timeline.scrollHeight,
        top: timeline.scrollTop,
      };
    }
    loadMoreMessages();
  }

  // 会话定位跳转：若目标消息已在当前分页内则直接滚动定位；
  // 否则先扩展分页窗口把它包含进来，交给 pendingJumpId effect 在渲染后定位。
  function handleOutlineJump(id: string) {
    const el = document.querySelector(
      `[data-message-id="${CSS.escape(id)}"]`,
    ) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      highlightMessageElement(el);
      return;
    }
    const index = activeMessages.findIndex((m) => m.id === id);
    if (index < 0) return;
    loadMessagesUntilIncluded(index);
    setPendingJumpId(id);
  }

  useEffect(() => {
    let frame = 0;
    const scheduleSync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setComposerHeight((current) => clampComposerHeight(current));
        syncComposerAutoHeight();
        setComposerOffsetHeight(composerRef.current?.offsetHeight ?? 0);
      });
    };

    const box = composerBoxRef.current;
    const footer = composerRef.current;
    const observer =
      (box || footer) &&
      new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        scheduleSync();
      });
    if (box) observer?.observe(box);
    if (footer) observer?.observe(footer);

    window.addEventListener("resize", scheduleSync);
    scheduleSync();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleSync);
      observer?.disconnect();
    };
  }, [activeAgentId]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setComposerHeight((current) => clampComposerHeight(current));
      syncComposerAutoHeight();
      setComposerOffsetHeight(composerRef.current?.offsetHeight ?? 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    prompt,
    activeAgentId,
    listCollapsed,
    drawerCollapsed,
    drawer,
    terminalOpen,
    visibleTerminalHeight,
  ]);

  useEffect(() => {
    if (activeProjectId && activeAgentId)
      setActiveAgentByProject((current) => ({
        ...current,
        [activeProjectId]: activeAgentId,
      }));
  }, [activeProjectId, activeAgentId]);

  useEffect(() => {
    if (activeAgentId && !isPendingAgentId(activeAgentId))
      void api.agents
        .commands(activeAgentId)
        // goal 模式这版先不公开入口；保留底层实现,等待官方 plan/goal 能力稳定后再决定是否恢复。
        .then((cmds) => setCommands(cmds))
        .catch(() => setCommands([]));
    else setCommands([]);
  }, [activeAgentId]);

  useEffect(() => {
    setSelectedSuggestionIndex(0);
  }, [suggestionItems.length]);

  // 持久化历史命令
  useEffect(() => {
    if (commandHistory.length > 0) {
      try {
        localStorage.setItem("pideck-command-history", JSON.stringify(commandHistory));
      } catch (error) {
        console.error("Failed to save command history:", error);
      }
    }
  }, [commandHistory]);

  // 监听用户滚动,判断是否需要显示"移动到最新"按钮
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = timeline;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;

      if (isAtBottom) {
        setAutoScroll(true);
        setShowScrollToBottom(false);
      } else {
        setAutoScroll(false);
        setShowScrollToBottom(true);
      }
    };

    // 初始化时检查一次
    handleScroll();

    timeline.addEventListener("scroll", handleScroll);
    return () => timeline.removeEventListener("scroll", handleScroll);
  }, [activeAgentId]);

  // 用 ResizeObserver 监控消息列表内容的 DOM 高度变化，自动滚动到底部。
  // 流式回答时最后一条 assistant 消息原地增长但 messages.length 不变，
  // 依赖 length 的 effect 不会及时触发；通过 ResizeObserver 准确感知容器扩张。
  // autoScroll 在依赖中确保开关变化时重建 observer（同时触发一次初始滚动）。
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const messageList = timeline.querySelector(".message-list");
    if (!messageList) return;

    const scrollIfNeeded = () => {
      if (!autoScroll) return;
      timeline.scrollTo({ top: timeline.scrollHeight, behavior: "instant" });
    };
    // 重建 observer 时先主动滚一次，处理 autoScroll 从 false→true 但列表高度未变的场景。
    scrollIfNeeded();

    const resizeObserver = new ResizeObserver(scrollIfNeeded);
    resizeObserver.observe(messageList);

    return () => resizeObserver.disconnect();
  }, [activeAgentId, autoScroll]);

  // 加载更多历史消息后，按顶部锁定的方式恢复滚动位置。
  // 历史消息会插入到 .message-list 顶部，若不补偿新增高度，浏览器保持原 scrollTop 会导致视图跳动，
  // 用户会感觉输入框/内容错位。这里把新增高度增量加回 scrollTop，让当前看到的消息留在原位。
  // 使用 useLayoutEffect 在浏览器绘制前同步补偿，避免用户看到中间跳动的一帧。
  useLayoutEffect(() => {
    const anchor = loadMoreAnchorRef.current;
    if (!anchor) return;
    const el = timelineRef.current;
    if (!el) return;
    const delta = el.scrollHeight - anchor.height;
    if (delta !== 0) el.scrollTop = anchor.top + delta;
    loadMoreAnchorRef.current = null;
  }, [paginatedMessages.length]);

  // 会话定位跳转到尚未加载的消息时，先通过 loadMessagesUntilIncluded 扩展分页窗口；
  // 该消息被渲染进 DOM 后，在此 effect 中真正滚动定位并短暂高亮，提示用户落点。
  useEffect(() => {
    if (!pendingJumpId) return;
    const el = document.querySelector(
      `[data-message-id="${CSS.escape(pendingJumpId)}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    highlightMessageElement(el);
    setPendingJumpId(null);
  }, [pendingJumpId, paginatedMessages.length, renderedMessages]);

  // 追踪 agent 会话开始/结束时间,计算会话时长
  // 点击外部区域自动关闭会话组合下拉
  useEffect(() => {
    if (!fileActionsOpen) return;
    void api.editors.list().then(setExternalEditors).catch(() => setExternalEditors([]));
    const handler = (event: MouseEvent) => {
      if (fileActionsRef.current && !fileActionsRef.current.contains(event.target as Node)) {
        setFileActionsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [fileActionsOpen]);

  useEffect(() => {
    if (!composerAccessMenuOpen) return;
    const handler = (event: MouseEvent) => {
      if (
        composerAccessRef.current &&
        !composerAccessRef.current.contains(event.target as Node)
      ) {
        setComposerAccessMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [composerAccessMenuOpen]);

  useEffect(() => {
    if (!starterProjectMenuOpen) return;
    const handler = (event: MouseEvent) => {
      if (
        starterProjectMenuRef.current &&
        !starterProjectMenuRef.current.contains(event.target as Node)
      ) {
        setStarterProjectMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [starterProjectMenuOpen]);

  useEffect(() => {
    for (const agent of displayAgents) {
      if (agent.id !== activeAgentId) continue;
      const previousStatus = agentStatusByAgentRef.current[agent.id];
      if (agent.status === "running") {
        if (previousStatus !== "running") {
          // Files 面板展示会话总览;聊天流只展示本轮回答新增触达的文件。
          // 基线记录累计行数而不是仅记录路径:同一个文件在后续回答再次被编辑时也要显示。
          turnFileBaselineByAgentRef.current[agent.id] = new Map(
            modifiedFiles.map((file) => [file.path, file]),
          );
          finalizedTurnByAgentRef.current[agent.id] = null;
        }
      } else if (agent.status === "idle") {
        if (modifiedFiles.length > 0) {
          // 会话级摘要仍保留给右侧 Files 面板作为总览,但不再渲染到聊天底部。
          setSessionFileSummaryByAgent((current) => ({
            ...current,
            [agent.id]: modifiedFiles,
          }));
        }

        const lastAssistantMessage = [...(messagesByAgent[agent.id] ?? [])]
          .reverse()
          .find((message) => message.role === "assistant");
        const baseline =
          turnFileBaselineByAgentRef.current[agent.id] ??
          new Map<string, SessionModifiedFile>();
        const turnModifiedFiles = modifiedFiles
          .map<SessionModifiedFile | null>((file) => {
            const baselineFile = baseline.get(file.path);
            const changedLines = Math.max(
              0,
              (file.changedLines ?? 0) - (baselineFile?.changedLines ?? 0),
            );
            return changedLines > 0 || !baselineFile
              ? { ...file, changedLines }
              : null;
          })
          .filter((file): file is SessionModifiedFile => Boolean(file));

        if (
          lastAssistantMessage &&
          turnModifiedFiles.length > 0 &&
          finalizedTurnByAgentRef.current[agent.id] !== lastAssistantMessage.id
        ) {
          finalizedTurnByAgentRef.current[agent.id] = lastAssistantMessage.id;
          setTurnFileSummaryByMessage((current) => ({
            ...current,
            [lastAssistantMessage.id]: turnModifiedFiles,
          }));
        }
      }
      agentStatusByAgentRef.current[agent.id] = agent.status;
    }
  }, [displayAgents, activeAgentId, modifiedFiles, messagesByAgent]);

  // 检测 goal_complete tool call → 标记 goal 完成
  useEffect(() => {
    if (goalStatusRef.current !== "active") return;
    const goalAgentMessages = activeAgentId ? messagesByAgent[activeAgentId] : undefined;
    if (!goalAgentMessages) return;
    for (let i = goalAgentMessages.length - 1; i >= 0; i--) {
      const message = goalAgentMessages[i];
      if (message.role === "tool" && message.meta?.toolName === "goal_complete") {
        goalStatusRef.current = "complete";
        goalContinuationPendingRef.current = false;
        setGoalStatus("complete");
        setGoalCompletedAt(Date.now());
        break;
      }
    }
  }, [messagesByAgent, activeAgentId]);

  // 监听用户发送消息的编辑事件,将消息填入输入框
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ text: string }>).detail;
      if (detail?.text) {
        setPrompt(detail.text);
        // 自动聚焦到输入框
        requestAnimationFrame(() => {
          composerTextareaRef.current?.focus();
        });
      }
    };
    window.addEventListener("user-message-edit", handler);
    return () => window.removeEventListener("user-message-edit", handler);
  }, []);

  useEffect(() => {
    if (!activeProjectId) {
      setFiles([]);
      setSessions([]);
      return;
    }

    // 切换项目时,如果该项目未加载过会话,则加载
    const activeProject = projects.find((p) => p.id === activeProjectId);
    const hasLoadedSessions = hasProjectSessionsLoaded(activeProjectId);
    const isLoadingNow = sessionLoadingByProject[activeProjectId];

    if (activeProject && !activeProject.kind && !hasLoadedSessions && !isLoadingNow) {
      void refreshProjectSessions(activeProjectId).catch(() => undefined);
    }

    const currentAgentBelongsToProject =
      activeAgentId &&
      displayAgents.some(
        (agent) =>
          agent.id === activeAgentId && agent.projectId === activeProjectId,
      );
    // Project/category rows only expand the child list; do not auto-open a remembered
    // session after the click intentionally cleared activeAgentId.
    if (activeAgentId && !currentAgentBelongsToProject) {
      const rememberedAgent = activeAgentByProject[activeProjectId];
      const fallbackAgent = displayAgents.find(
        (agent) => agent.projectId === activeProjectId,
      )?.id;
      setActiveAgentId(
        rememberedAgent &&
          displayAgents.some((agent) => agent.id === rememberedAgent)
          ? rememberedAgent
          : fallbackAgent,
      );
    }

    setExpandedDirs(new Set());
    void api.files
      .list(activeProjectId)
      .then(setFiles)
      .catch((error) => setLogs((current) => [...current, String(error)]));
  }, [activeProjectId, displayAgents.length]);

  useEffect(() => {
    if (!activeProjectId) return;
    let stopped = false;
    const refreshGitInfo = async () => {
      try {
        // 轮询分支信息
        // 分支可能在外部终端/IDE 中切换,轮询只在状态真的变化时更新,避免不必要重渲染。
        // 同时刷新 Git 工作区变更文件列表（对比 HEAD）
        const changed = await api.git.changedFiles(activeProjectId);
        if (!stopped) setGitChangedFiles(changed);
      } catch {
        if (!stopped) {
          setGitChangedFiles([]);
        }
      }
    };
    const timer = window.setInterval(refreshGitInfo, 4000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeProjectId]);

  async function checkPiInstall(source: "startup" | "manual" = "manual") {
    setSettingsOpen(false);
    setPiChecking(true);
    setEnvironmentDialog(true);
    try {
      const next = await api.pi.check();
      setPiStatus(next);
      if (next.installed && source === "startup") {
        // 首次启动检测通过后落盘,后续启动不再阻塞/打扰;用户仍可在设置里手动重新检测。
        const saved = await api.settings.update({ piEnvironmentChecked: true });
        setSettings(saved);
        window.setTimeout(() => setEnvironmentDialog(false), 3000);
      }
      if (next.installed && source === "manual")
        window.setTimeout(() => setEnvironmentDialog(false), 3000);
    } finally {
      setPiChecking(false);
    }
  }

  async function checkPiInstallInline() {
    setPiChecking(true);
    setCustomPathResult(null);
    try {
      const next = await api.pi.check();
      setPiStatus(next);
      if (next.installed) {
        const saved = await api.settings.update({ piEnvironmentChecked: true });
        setSettings(saved);
        setSettingsNotice(
          t("app.piCheckPassed", {
            value: next.command ?? next.version ?? "pi",
          }),
        );
      } else {
        setSettingsNotice(
          t("app.piCheckFailed", {
            error: next.error ?? t("settings.piMissing"),
          }),
        );
      }
    } finally {
      setPiChecking(false);
    }
  }

  /**
   * 校验用户手动输入的 pi 路径。
   * 主进程执行 command --version 验证后,通过则自动保存到 settings.customPiPath,
   * 之后新建/重启 agent 时 PiProcess 会优先使用自定义路径。
   */
  async function validateCustomPiPath(
    options: { closeDialogOnSuccess?: boolean } = {},
  ) {
    const path = customPiPath.trim();
    if (!path) return;
    setCustomPathValidating(true);
    setCustomPathResult(null);
    try {
      const result = await api.pi.checkCustom(path);
      setCustomPathResult(result);
      if (result.installed) {
        // 主进程会保存 PiLocator 归一化后的路径;这里重新读取,确保 UI 展示的是实际使用路径。
        const updated = await api.settings.get();
        setSettings(updated);
        setCustomPiPath(updated.customPiPath ?? result.command ?? path);
        setPiStatus(result);
        setSettingsNotice(
          t("app.piPathSaved", {
            path: result.command ?? updated.customPiPath ?? path,
          }),
        );
        if (options.closeDialogOnSuccess) {
          // 启动检测弹窗场景下保持原有成功后自动关闭体验;设置页内校验不关闭设置窗口。
          window.setTimeout(() => setEnvironmentDialog(false), 3000);
        }
      } else {
        setSettingsNotice(
          t("app.piPathValidateFailed", {
            error: result.error ?? t("environment.unableToRun"),
          }),
        );
      }
    } finally {
      setCustomPathValidating(false);
    }
  }

  async function clearCustomPiPath() {
    const updated = await api.settings.update({ customPiPath: "" });
    setSettings(updated);
    setCustomPiPath("");
    setCustomPathResult(null);
    setSettingsNotice(t("app.piPathCleared"));
    const status = await api.pi.check();
    setPiStatus(status);
  }

  function showToast(message: string, duration = 3500) {
    setToast(message);
    window.setTimeout(() => setToast(null), duration);
  }

  async function downloadAppUpdate() {
    const asset = updateInfo?.recommendedAsset;
    if (!asset) {
      await api.app.openExternal(updateInfo?.releaseUrl ?? appInfo.releasesUrl);
      return;
    }
    setUpdateDownloading(true);
    setDownloadedUpdatePath(null);
    setUpdateProgress({
      assetName: asset.name,
      receivedBytes: 0,
      totalBytes: asset.size,
      percent: 0,
      state: "downloading",
    });
    try {
      const result = await api.app.downloadUpdate(asset);
      setDownloadedUpdatePath(result.filePath);
      showToast(t("update.downloadCompleted"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUpdateError(message);
      showToast(t("update.downloadFailed"));
    } finally {
      setUpdateDownloading(false);
    }
  }

  async function installDownloadedAppUpdate() {
    if (!downloadedUpdatePath) return;
    await api.app.installUpdate(downloadedUpdatePath);
  }

  async function checkPiCliUpdateOnStartup() {
    try {
      const result = await api.pi.checkUpdate();
      setPiUpdateCheck(result);
      if (result.hasUpdate) {
        // 启动后后台提醒即可，不阻塞主界面；低版本 pi 可能缺少新版协议/工具能力。
        const message = t("settings.piUpdateStartupNotice");
        setSettingsNotice(message);
        showToast(message, 6500);
      }
    } catch {
      // 后台检查失败不打扰用户；设置页仍可手动检查并看到详细错误。
    }
  }

  async function checkPiCliUpdate() {
    setPiUpdateChecking(true);
    try {
      const result = await api.pi.checkUpdate();
      setPiUpdateCheck(result);
      setSettingsNotice(result.error ? t("settings.piUpdateFailed", { error: result.error }) : result.hasUpdate ? t("settings.piUpdateAvailable") : t("settings.piUpdateChecked"));
    } finally {
      setPiUpdateChecking(false);
    }
  }

  async function updatePiCli() {
    setPiUpdating(true);
    setPiUpdateResult(null);
    try {
      const result = await api.pi.update();
      setPiUpdateResult(result);
      await checkPiInstallInline();
      setPiUpdateCheck(await api.pi.checkUpdate());
      setSettingsNotice(result.updated ? t("settings.piUpdateDone") : t("settings.piUpdateChecked"));
    } catch (error) {
      setSettingsNotice(t("settings.piUpdateFailed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setPiUpdating(false);
    }
  }


  async function checkAppUpdate(source: "auto" | "manual" = "manual") {
    if (updateChecking) return;
    setUpdateChecking(true);
    try {
      const next = await api.app.checkUpdate();
      if (next.hasUpdate) {
        setUpdateInfo(next);
      } else if (source === "manual") {
        // 手动检查且无更新时,显示模态框提示
        setUpToDateVersion(next.currentVersion);
        setSettingsNotice(
          t("app.latestVersionNotice", { version: next.currentVersion }),
        );
      }
    } catch (error) {
      if (source === "manual") {
        const message = error instanceof Error ? error.message : String(error);
        setSettingsNotice(t("app.updateFailedNotice", { error: message }));
        setUpdateError(message);
        showToast(t("app.updateFailed"));
      }
    } finally {
      setUpdateChecking(false);
    }
  }

  async function refreshProjects() {
    const next = await api.projects.list();
    setProjects(next);
    if (!activeProjectId && next.length > 0) setActiveProjectId(next[0].id);
  }

  async function refreshSessions(projectId = activeProjectId) {
    const next = await api.sessions.list(projectId);
    setSessions([...next].sort((a, b) => b.updatedAt - a.updatedAt));
  }

  async function refreshProjectSessions(projectId: string) {
    setSessionLoadingByProject((current) => ({
      ...current,
      [projectId]: true,
    }));
    try {
      const next = await api.sessions.list(projectId);
      const sorted = [...next].sort((a, b) => b.updatedAt - a.updatedAt);
      setSessionsByProject((current) => ({
        ...current,
        [projectId]: sorted,
      }));
      setVisibleProjectChildCountByProject((current) => ({
        ...current,
        [projectId]: current[projectId] ?? SIDEBAR_PROJECT_CHILD_PAGE_SIZE,
      }));
      return sorted;
    } finally {
      setSessionLoadingByProject((current) => ({
        ...current,
        [projectId]: false,
      }));
    }
  }

  function hasProjectSessionsLoaded(projectId: string) {
    return Object.prototype.hasOwnProperty.call(sessionsByProject, projectId);
  }

  async function refreshFiles(projectId = activeProjectId) {
    if (!projectId) return;
    const next = await api.files.list(projectId);
    setFiles(next);
    showToast(t("app.filesRefreshed"), 1800);
  }

  async function refreshGitChangedFiles(projectId = activeProjectId) {
    if (!projectId) return;
    try {
      const next = await api.git.changedFiles(projectId);
      setGitChangedFiles(next);
    } catch {
      // 非 Git 项目或 git 未安装，静默置空
      setGitChangedFiles([]);
    }
  }

  function openFilePath(path: string) {
    // 绝对路径直接打开;相对路径按当前 agent cwd / 项目目录解析后交给系统默认应用。
    const resolvedPath = resolveFileLinkPath(path, activeAgent?.cwd ?? activeProject?.path);
    void api.files.open(resolvedPath).catch((error) => {
      showToast(t("app.openFileFailed", {
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }

  function viewFilePath(path: string) {
    setDiffViewMode("view");
    setDiffViewFile(path);
  }

  function diffFilePath(path: string, originalContent?: string, content?: string) {
    setDiffViewMode("diff");
    setDiffViewFile(path);
    // 会话卡片传入的是工具执行前缓存的原始内容，提交后 Git 工作区可能已清空，
    // 因此优先使用会话级快照；文件边栏不传该值时仍回退到当前会话累计修改记录。
    const modified = modifiedFiles.find((f) => f.path === path);
    setDiffViewOriginalContent(originalContent ?? modified?.originalContent ?? "");
    // 修改后内容优先使用调用侧传入的 content（历史会话摘要数据），
    // 其次使用当前会话的 modifiedFiles 缓存；两者皆无时 FileDiffViewer 会回退到读磁盘。
    setDiffViewModifiedContent(content ?? modified?.content ?? undefined);
  }

  async function refreshSessionHistory(projectId = sessionsProjectId) {
    if (!projectId) return;
    setSessionHistoryLoading(true);
    try {
      // 项目历史弹框内的刷新需要显式进入 loading 状态;否则刷新很快完成时用户会误以为按钮没有响应。
      await refreshSessions(projectId);
    } finally {
      setSessionHistoryLoading(false);
    }
  }

  async function openProjectSessions(project: Project) {
    setProjectMenu(null);
    setActiveProjectId(project.id);
    setSessionsProjectId(project.id);
    setSessions([]);
    setDrawer((current) => (current === "sessions" ? null : current));
    await refreshSessionHistory(project.id);
  }

  async function openHistorySession(session: SessionSummary) {
    const projectId = sessionsProjectId;
    if (!projectId) return;
    setSessionsProjectId(undefined);
    setSessions([]);
    await createAgent(
      projectId,
      session.filePath,
      session.name || t("common.untitled"),
    );
  }

  async function renameHistorySession(filePath: string, newName: string) {
    await api.sessions.rename(filePath, newName);
    if (sessionsProjectId) await refreshSessions(sessionsProjectId);
    if (sessionsProjectId) await refreshProjectSessions(sessionsProjectId);
  }

  async function copySession(
    filePath: string,
    projectId = sessionsProjectId ?? activeProjectId,
  ) {
    if (!projectId) return;
    const result = await api.sessions.copy(projectId, filePath);
    if (result.cancelled) {
      showToast(t("app.sessionCopyCancelled"));
      return;
    }
    showToast(t("app.sessionCopied"));
    await refreshSessions(projectId);
    await refreshProjectSessions(projectId);
  }

  async function exportHistorySession(session: SessionSummary) {
    const projectId = sessionsProjectId ?? activeProjectId;
    if (!projectId) return;
    const result = await api.sessions.exportHtml(projectId, session.filePath);
    showToast(t("app.exportedPath", { path: result.path }), 3500);
  }

  async function deleteHistorySession(session: SessionSummary) {
    await api.sessions.delete(session.filePath);
    showToast(t("app.sessionDeleted"), 2200);
    const projectId = sessionsProjectId ?? activeProjectId;
    await refreshSessions(projectId);
    if (projectId) await refreshProjectSessions(projectId);
  }

  async function cloneAgentSession(agentId: string) {
    setAgentActionLoading("copy");
    try {
      const result = await api.agents.cloneSession(agentId);
      if (result?.cancelled) {
        showToast(t("app.sessionCopyCancelled"));
        return;
      }
      showToast(t("app.currentSessionCopied"));
      await refreshRuntimeState(agentId);
      await refreshSessions(activeProjectId);
      if (activeProjectId) await refreshProjectSessions(activeProjectId);
    } finally {
      setAgentActionLoading(null);
      setAgentMenu(null);
    }
  }

  function openAgentRename(agent: AgentTab) {
    setAgentMenu(null);
    setAgentRenameTarget(agent);
    setSessionRenameTarget(null);
    setAgentRenameValue(agent.title);
  }

  function openSessionRename(projectId: string, session: SessionSummary) {
    setSessionMenu(null);
    setAgentRenameTarget(null);
    setSessionRenameTarget({ projectId, session });
    setAgentRenameValue(session.name || t("common.untitled"));
  }

  async function submitAgentRename() {
    if (!agentRenameTarget) return;
    const name = agentRenameValue.replace(/\s+/g, " ").trim();
    if (!name) {
      showToast(t("app.sessionNameRequired"), 2200);
      return;
    }
    setAgentRenaming(true);
    try {
      const tab = await api.agents.rename(agentRenameTarget.id, name);
      setAgents((current) =>
        current.map((agent) => (agent.id === tab.id ? tab : agent)),
      );
      setAgentRenameTarget(null);
      setSessionRenameTarget(null);
      setAgentRenameValue("");
      showToast(t("app.sessionRenamed"), 2200);
      await refreshProjectSessions(tab.projectId);
      if (sessionsProjectId === tab.projectId)
        await refreshSessions(tab.projectId);
    } catch (error) {
      showToast(
        t("app.sessionRenameFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    } finally {
      setAgentRenaming(false);
    }
  }

  async function submitSessionRename() {
    if (!sessionRenameTarget) return;
    const name = agentRenameValue.replace(/\s+/g, " ").trim();
    if (!name) {
      showToast(t("app.sessionNameRequired"), 2200);
      return;
    }
    setAgentRenaming(true);
    try {
      await api.sessions.rename(sessionRenameTarget.session.filePath, name);
      await refreshProjectSessions(sessionRenameTarget.projectId);
      if (sessionsProjectId === sessionRenameTarget.projectId) {
        await refreshSessions(sessionRenameTarget.projectId);
      }
      setSessionRenameTarget(null);
      setAgentRenameValue("");
      showToast(t("app.sessionRenamed"), 2200);
    } catch (error) {
      showToast(
        t("app.sessionRenameFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    } finally {
      setAgentRenaming(false);
    }
  }

  async function openSidebarSession(
    projectId: string,
    session: SessionSummary,
  ) {
    setSessionMenu(null);
    return createAgent(
      projectId,
      session.filePath,
      session.name || t("common.untitled"),
    );
  }

  async function copySidebarSession(
    projectId: string,
    session: SessionSummary,
  ) {
    setSessionActionLoading("copy");
    try {
      await copySession(session.filePath, projectId);
    } finally {
      setSessionActionLoading(null);
      setSessionMenu(null);
    }
  }

  async function exportSidebarSession(
    projectId: string,
    session: SessionSummary,
  ) {
    setSessionActionLoading("export");
    try {
      const result = await api.sessions.exportHtml(projectId, session.filePath);
      showToast(t("app.exportedPath", { path: result.path }), 3500);
    } finally {
      setSessionActionLoading(null);
      setSessionMenu(null);
    }
  }

      // 默认不自动勾选任何会话,避免用户未确认时批量覆盖已导入历史。
      // OpenCode 导入会覆盖同名目标副本，默认不勾选，避免误覆盖用户已经导入过的历史。
  async function reorderProjects(
    sourceProjectId: string,
    targetProjectId: string,
  ) {
    if (!canReorderProjects || sourceProjectId === targetProjectId) return;
    const sourceProject = projects.find(
      (project) => project.id === sourceProjectId,
    );
    const targetProject = projects.find(
      (project) => project.id === targetProjectId,
    );
    if (isChatProject(sourceProject) || isChatProject(targetProject)) return;
    const sourceIndex = projects.findIndex(
      (project) => project.id === sourceProjectId,
    );
    const targetIndex = projects.findIndex(
      (project) => project.id === targetProjectId,
    );
    if (sourceIndex === -1 || targetIndex === -1) return;

    const previousProjects = projects;
    const nextProjects = [...projects];
    const [movedProject] = nextProjects.splice(sourceIndex, 1);
    const targetIndexAfterRemoval = nextProjects.findIndex(
      (project) => project.id === targetProjectId,
    );
    const insertIndex =
      sourceIndex < targetIndex
        ? targetIndexAfterRemoval + 1
        : targetIndexAfterRemoval;
    nextProjects.splice(insertIndex, 0, movedProject);
    setProjects(nextProjects);

    try {
      const savedProjects = await api.projects.reorder(
        nextProjects.map((project) => project.id),
      );
      setProjects(savedProjects);
    } catch (error) {
      setProjects(previousProjects);
      showToast(
        t("app.projectSortFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    }
  }

  function handleProjectDragStart(
    event: React.DragEvent<HTMLButtonElement>,
    projectId: string,
  ) {
    if (!canReorderProjects) {
      event.preventDefault();
      return;
    }
    setDraggingProjectId(projectId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", projectId);
  }

  function handleProjectDragOver(
    event: React.DragEvent<HTMLButtonElement>,
    projectId: string,
  ) {
    if (!draggingProjectId || draggingProjectId === projectId) return;
    if (isChatProject(projects.find((project) => project.id === projectId)))
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverProjectId(projectId);
  }

  function handleProjectDragLeave(projectId: string) {
    setDragOverProjectId((current) =>
      current === projectId ? undefined : current,
    );
  }

  function finishProjectDrag() {
    setDraggingProjectId(undefined);
    setDragOverProjectId(undefined);
  }

  async function handleProjectDrop(
    event: React.DragEvent<HTMLButtonElement>,
    targetProjectId: string,
  ) {
    event.preventDefault();
    const sourceProjectId =
      event.dataTransfer.getData("text/plain") || draggingProjectId;
    finishProjectDrag();
    if (!sourceProjectId || sourceProjectId === targetProjectId) return;
    projectDragPreventClickRef.current = true;
    window.setTimeout(() => {
      projectDragPreventClickRef.current = false;
    }, 0);
    await reorderProjects(sourceProjectId, targetProjectId);
  }

  async function addProject() {
    const project = await api.projects.add();
    if (!project) return;
    await refreshProjects();
    setActiveProjectId(project.id);
    setActiveAgentId(undefined);
  }

  function openNewSessionStarter(projectId = activeProjectId) {
    setActiveAgentId(undefined);
    setDrawer(null);
    setStarterProjectId(projectId ?? chatProject?.id ?? projects[0]?.id);
    requestAnimationFrame(() => composerTextareaRef.current?.focus());
  }

  function selectStarterProject(projectId: string) {
    setStarterProjectId(projectId);
    setActiveProjectId(projectId);
    setStarterProjectMenuOpen(false);
    setStarterProjectSearch("");
    requestAnimationFrame(() => composerTextareaRef.current?.focus());
  }

  async function createBlankStarterProject() {
    setStarterProjectBusy(true);
    try {
      const project = await api.projects.createBlank();
      if (!project) return;
      await refreshProjects();
      selectStarterProject(project.id);
    } finally {
      setStarterProjectBusy(false);
    }
  }

  async function chooseExistingStarterProject() {
    setStarterProjectBusy(true);
    try {
      const project = await api.projects.add();
      if (!project) return;
      await refreshProjects();
      selectStarterProject(project.id);
    } finally {
      setStarterProjectBusy(false);
    }
  }

  function updateAfterProjectRemoved(
    removedProjectId: string,
    next: Project[],
  ) {
    setSessionsByProject((current) => {
      const updated = { ...current };
      delete updated[removedProjectId];
      return updated;
    });
    setVisibleProjectChildCountByProject((current) => {
      const updated = { ...current };
      delete updated[removedProjectId];
      return updated;
    });
    if (activeProjectId === removedProjectId) {
      setActiveProjectId(next[0]?.id);
      setActiveAgentId(undefined);
    }
    if (sessionsProjectId === removedProjectId) {
      setSessionsProjectId(undefined);
      if (drawer === "sessions") setDrawer(null);
    }
  }

  async function createAgent(
    projectId = activeProjectId,
    sessionPath?: string,
    title?: string,
  ): Promise<AgentTab | undefined> {
    if (!projectId) return;
    const project = projects.find((item) => item.id === projectId);
    if (!project) return;
    const existing = sessionPath
      ? [...displayAgents, ...pendingAgentsRef.current].find(
          (agent) =>
            agent.projectId === projectId &&
            isSameSessionPath(agent.sessionPath, sessionPath),
        )
      : undefined;
    if (existing) {
      setActiveProjectId(existing.projectId);
      setActiveAgentId(existing.id);
      setDrawer(null);
      return existing;
    }
    const previousAgentId = activeAgentId;
    const pendingTab: AgentTab = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      projectId,
      cwd: project.path,
      title: title || `${project.name} agent`,
      status: "starting",
      sessionPath,
      createdAt: Date.now(),
    };
    pendingAgentsRef.current = [...pendingAgentsRef.current, pendingTab];
    setPendingAgents(pendingAgentsRef.current);
    setActiveProjectId(projectId);
    setActiveAgentId(pendingTab.id);
    setActiveAgentByProject((current) => ({
      ...current,
      [projectId]: pendingTab.id,
    }));
    // 立即关闭抽屉,避免等待 agent 加载期间列表仍然显示
    setDrawer(null);
    try {
      const tab = await api.agents.create({ projectId, sessionPath, title });
      pendingAgentsRef.current = pendingAgentsRef.current.filter(
        (agent) => agent.id !== pendingTab.id,
      );
      setPendingAgents(pendingAgentsRef.current);
      setActiveAgentId((current) =>
        current === pendingTab.id ? tab.id : current,
      );
      setActiveAgentByProject((current) =>
        current[projectId] === pendingTab.id
          ? {
              ...current,
              [projectId]: tab.id,
            }
          : current,
      );
      setPromptByAgent((current) => {
        const draft = current[pendingTab.id];
        if (draft == null) return current;
        const next = { ...current, [tab.id]: draft };
        delete next[pendingTab.id];
        return next;
      });
      setAttachedImagesByAgent((current) => {
        const draft = current[pendingTab.id];
        if (draft == null) return current;
        const next = { ...current, [tab.id]: draft };
        delete next[pendingTab.id];
        return next;
      });
      // 全新创建的会话需要刷新历史列表以显示新文件；从已有历史会话打开的 agent 跳过刷新，避免文件 mtime 被不必要地读/写导致排序提前
      if (!sessionPath) {
        void refreshProjectSessions(projectId).catch(() => undefined);
      }
      void refreshRuntimeState(tab.id);
      return tab;
    } catch (e) {
      pendingAgentsRef.current = pendingAgentsRef.current.filter(
        (agent) => agent.id !== pendingTab.id,
      );
      setPendingAgents(pendingAgentsRef.current);
      setActiveAgentId((current) =>
        current === pendingTab.id ? previousAgentId : current,
      );
      setActiveAgentByProject((current) => {
        if (current[projectId] !== pendingTab.id) return current;
        const next = { ...current };
        if (previousAgentId) next[projectId] = previousAgentId;
        else delete next[projectId];
        return next;
      });
      // 创建失败时由 main process 上报错误,前端仅回退乐观占位,避免停留在不存在的 agent。
      return undefined;
    }
  }

  async function refreshRuntimeState(agentId = activeAgentId) {
    if (!agentId || isPendingAgentId(agentId)) return;
    const state = await api.agents.runtimeState(agentId).catch(() => undefined);
    if (state)
      setRuntimeStateByAgent((current) => ({ ...current, [agentId]: state }));
  }

  async function openModelPicker() {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    const models = await api.agents.availableModels(activeAgentId);
    setAvailableModels(models);
    setModelPickerOpen(true);
  }

  async function selectModel(model: AvailableModel) {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    const state = await api.agents.setModel(
      activeAgentId,
      model.provider,
      model.id,
    );
    setRuntimeStateByAgent((current) => ({
      ...current,
      [activeAgentId]: state,
    }));
    setModelPickerOpen(false);
  }

  async function cycleThinking() {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    const state = await api.agents.cycleThinking(activeAgentId);
    setRuntimeStateByAgent((current) => ({
      ...current,
      [activeAgentId]: state,
    }));
  }

  async function selectThinking(level: string) {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    try {
      // 使用 setThinking 明确落到用户选择的档位,避免 cycle 模式需要反复点击才能到目标级别。
      const state = await api.agents.setThinking(activeAgentId, level);
      setRuntimeStateByAgent((current) => ({
        ...current,
        [activeAgentId]: state,
      }));
      setThinkingPickerOpen(false);
      // pi runtime 会按模型能力 clamp thinking level;对比实际状态,避免用户误以为已运行在不支持的档位。
      if (state.thinkingLevel && state.thinkingLevel !== level) {
        showToast(
          t("app.thinkingUnsupported", {
            level,
            fallback: state.thinkingLevel,
          }),
        );
      }
    } catch (error) {
      showToast(
        t("app.thinkingSwitchFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async function compactAgent(compactPrompt?: string) {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    setCompacting(true);
    try {
      const state = await api.agents.compact(activeAgentId, compactPrompt);
      setRuntimeStateByAgent((current) => ({
        ...current,
        [activeAgentId]: state,
      }));
    } finally {
      setCompacting(false);
    }
  }

  async function closeAgent(agentId: string) {
    if (isPendingAgentId(agentId)) return;
    await api.agents.stop(agentId);
  }

  async function abortAgent(agentId = activeAgentId) {
    if (!agentId || isPendingAgentId(agentId)) return;
    await api.agents.abort(agentId);
    void refreshRuntimeState(agentId);
  }

  async function exportAgentHtml(agentId: string) {
    if (isPendingAgentId(agentId)) return;
    setAgentActionLoading("export");
    try {
      const result = await api.agents.exportHtml(agentId);
      showToast(t("app.exportedPath", { path: result.path }), 3500);
    } finally {
      setAgentActionLoading(null);
      setAgentMenu(null);
    }
  }

  function setTerminalOpenForAgent(agentId: string, open: boolean) {
    setTerminalDockStateByAgent((current) =>
      setTerminalDockOpen(current, agentId, open),
    );
  }

  function setTerminalCollapsedForAgent(agentId: string, collapsed: boolean) {
    setTerminalDockStateByAgent((current) =>
      setTerminalDockCollapsed(current, agentId, collapsed),
    );
  }

  function handleComposerKeyDown(
    event: React.KeyboardEvent<HTMLDivElement>,
  ) {
    if (suggestionsOpen && suggestionItems.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedSuggestionIndex((index) =>
          Math.min(index + 1, suggestionItems.length - 1),
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedSuggestionIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        // IME 确认时也会触发 Enter(keyCode=229 或 isComposing),不放行到建议选中。
        if ((event.nativeEvent as KeyboardEvent).isComposing || event.keyCode === 229) return;
        event.preventDefault();
        const selected =
          suggestionItems[
            Math.min(selectedSuggestionIndex, suggestionItems.length - 1)
          ];
        if (selected) {
          // 以光标为锚替换触发符..光标这一段,并在下一帧恢复光标到插入项之后。
          const el = event.currentTarget;
          const cursor = getCaretOffsetOf(el);
          const result = applySuggestion(prompt, cursor, selected.value);
          // RichInput 的受控同步会基于 value 重渲染并恢复光标,这里同步状态即可。
          setPrompt(result.text);
          setComposerCursor(result.cursor);
          pendingComposerCaretRef.current = result.cursor;
          setSuggestionsOpen(false);
          requestAnimationFrame(() => {
            composerTextareaRef.current?.focus();
          });
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        const el = event.currentTarget;
        const cursor = getCaretOffsetOf(el);
        const result = clearSuggestionTrigger(prompt, cursor);
        setPrompt(result.text);
        setComposerCursor(result.cursor);
        pendingComposerCaretRef.current = result.cursor;
        setSuggestionsOpen(false);
        requestAnimationFrame(() => {
          composerTextareaRef.current?.focus();
        });
        return;
      }
    }

    // 历史命令导航:只在光标位于第一行时生效
    const editor = event.currentTarget;
    const cursorPos = getCaretOffsetOf(editor);
    const textBeforeCursor = prompt.substring(0, cursorPos);
    const isFirstLine = !textBeforeCursor.includes('\n');
    const textAfterCursor = prompt.substring(cursorPos);
    const isLastLine = !textAfterCursor.includes('\n');

    if (event.key === "ArrowUp" && isFirstLine && commandHistory.length > 0) {
      event.preventDefault();

      // 首次导航时保存当前输入
      if (!historyNavigating) {
        setSavedPrompt(prompt);
        setHistoryNavigating(true);
        const newIndex = 0;
        setHistoryIndex(newIndex);
        setPrompt(commandHistory[newIndex]);
      } else {
        // 继续向上导航
        const newIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
        if (newIndex !== historyIndex) {
          setHistoryIndex(newIndex);
          setPrompt(commandHistory[newIndex]);
        }
      }
      return;
    }

    if (event.key === "ArrowDown" && isLastLine && historyNavigating) {
      event.preventDefault();

      if (historyIndex > 0) {
        // 向下导航
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setPrompt(commandHistory[newIndex]);
      } else {
        // 回到最初输入的内容
        setHistoryIndex(-1);
        setHistoryNavigating(false);
        setPrompt(savedPrompt);
        setSavedPrompt("");
      }
      return;
    }

    if (event.key === "Escape") {
      const el = event.currentTarget;
      const cursor = getCaretOffsetOf(el);
      const result = clearSuggestionTrigger(prompt, cursor);
      setPrompt(result.text);
      setComposerCursor(result.cursor);
      setSuggestionsOpen(false);
      // 如果正在历史导航,ESC 退出并恢复原始输入
      if (historyNavigating) {
        setPrompt(savedPrompt);
        setHistoryIndex(-1);
        setHistoryNavigating(false);
        setSavedPrompt("");
      }
    }
    const enterIntent = getComposerEnterIntent(event, settings.sendShortcut);
    if (enterIntent === "send") {
      event.preventDefault();
      void sendPrompt();
    } else if (enterIntent === "newline") {
      // RichInput 内部会在 Enter 未被上层 preventDefault 时手动插入 \n。
      return;
    }
  }

  /** 判断 agent 是否处于忙碌状态(正在处理消息或流式输出中) */
  const isAgentStarting = activeAgent?.status === "starting";
  const composerDisabled = isAgentStarting;
  const isAgentBusy = Boolean(
    activeAgent &&
    (activeAgent.status === "running" || activeRuntimeState?.isStreaming),
  );

  // 切换 agent 时不能沿用上一会话的 busy 边沿,否则旧 agent 结束可能误触发新 agent 的 goal 续接。
  useEffect(() => {
    prevIsAgentBusyRef.current = false;
    goalContinuationPendingRef.current = false;
    goalLastResponseSignatureRef.current = "";
  }, [activeAgentId]);

  // 自动续接：busy → idle 时，如果 goal 仍 active 则自动发送续接
  useEffect(() => {
    const busy = isAgentBusy;
    const wasBusy = prevIsAgentBusyRef.current;
    prevIsAgentBusyRef.current = busy;
    if (wasBusy && !busy && goalStatusRef.current === "active" && activeAgentId) {
      const text = goalTextRef.current;
      // 直接扫描消息确认是否有 goal_complete（防范 effect 时序问题）
      const goalMsgs = activeAgentId ? messagesByAgent[activeAgentId] : undefined;
      if (goalMsgs?.some((m) => m.role === "tool" && m.meta?.toolName === "goal_complete")) {
        goalStatusRef.current = "complete";
        setGoalStatus("complete");
        setGoalCompletedAt(Date.now());
        return;
      }

      const latestResponseSignature =
        goalMsgs
          ?.filter((message) => message.role === "assistant" || message.role === "tool")
          .slice(-1)
          .map((message) => `${message.role}:${message.id}:${message.timestamp}`)[0] ?? "";

      // 如果上一次自动续接后没有产生新的 assistant/tool 消息,说明只是状态抖动或发送失败重入,
      // 继续 followUp 只会堆叠同一目标,因此暂停交给用户检查而不是无限循环。
      if (
        goalIterationRef.current > 0 &&
        goalLastResponseSignatureRef.current === latestResponseSignature
      ) {
        goalStatusRef.current = "paused";
        goalContinuationPendingRef.current = false;
        setGoalStatus("paused");
        showToast("🎯 Goal paused: no new agent response after auto continuation.", 4000);
        return;
      }

      const iteration = goalIterationRef.current + 1;

      // 达到最大续接次数时暂停,保留未完成状态,避免模型未调用 goal_complete 时无限自动续接。
      if (iteration > GOAL_MAX_CONTINUATIONS) {
        goalStatusRef.current = "paused";
        goalContinuationPendingRef.current = false;
        setGoalStatus("paused");
        showToast(`🎯 Goal paused after ${GOAL_MAX_CONTINUATIONS} auto continuations.`, 4000);
        return;
      }

      if (!goalContinuationPendingRef.current && text) {
        goalIterationRef.current = iteration;
        goalContinuationPendingRef.current = true;
        goalLastResponseSignatureRef.current = latestResponseSignature;
        const continuationMsg = `[goal 自动续接 #${iteration}]
当前目标仍未完成，请继续工作:
<goal_objective>
${text}
</goal_objective>

继续完成该目标。不要停止在分析、计划、TODO 或部分修改上。彻底完成后调用 goal_complete。`;
        api.agents.prompt({
          agentId: activeAgentId,
          message: continuationMsg,
          streamingBehavior: "followUp",
        }).catch(() => {
          goalContinuationPendingRef.current = false;
        });
      }
    }
    if (busy) {
      goalContinuationPendingRef.current = false;
    }
  }, [isAgentBusy, activeAgentId, api.agents, messagesByAgent]);

  async function sendPrompt() {
    if (
      isAgentStarting ||
      (!activeAgentId && !starterSelectedProjectId) ||
      (!prompt.trim() && attachedImages.length === 0)
    )
      return;
    const message = prompt;
    const images = attachedImages.length > 0 ? attachedImages : undefined;

    const trimmedMessage = message.trim();

    // ── /goal 命令处理 ──
    if (trimmedMessage.startsWith("/goal")) {
      if (!activeAgentId) {
        showToast(t("app.starterGoalNeedsAgent"), 2200);
        return;
      }
      handleGoalCommand(trimmedMessage);
      setPrompt("");
      return;
    }

    // ── /compact 命令处理 ──
    if (/^\/compact(?:\s|$)/.test(trimmedMessage)) {
      if (!activeAgentId) {
        showToast(t("app.starterCompactNeedsAgent"), 2200);
        return;
      }
      const compactPrompt = trimmedMessage.replace(/^\/compact\s*/, "").trim();
      // /compact 是桌面端内置控制命令，必须走 RPC compact 通道；否则会被当作普通消息发送给 agent。
      setPrompt("");
      setSuggestionsOpen(false);
      await compactAgent(compactPrompt || undefined);
      return;
    }

    // 保存到历史记录(只保存非空的文本命令)
    if (message.trim() && !message.startsWith("!")) {
      setCommandHistory((prev) => {
        // 避免重复保存相同的命令
        const filtered = prev.filter(cmd => cmd !== message.trim());
        // 保留最近 50 条
        const newHistory = [message.trim(), ...filtered].slice(0, 50);
        return newHistory;
      });
    }

    // 重置历史导航状态
    setHistoryIndex(-1);
    setHistoryNavigating(false);
    setSavedPrompt("");

    // 发送前先保留快照,再立即清空 composer;运行中发送会走官方 steer 队列,
    // 由 pi runtime 保证在当前工具调用结束后、下一次 LLM 调用前注入。
    // 不论之前是否滚动回看，发新消息都强制自动滚到底，确保能看到 agent 的回答。
    setAutoScroll(true);
    const scrollTimeline = timelineRef.current;
    if (scrollTimeline) scrollTimeline.scrollTo({ top: scrollTimeline.scrollHeight, behavior: "instant" });
    setPrompt("");
    setAttachedImages([]);
    setSuggestionsOpen(false);
    setSendBehaviorMenuOpen(false);
    let targetAgentId = activeAgentId;
    if (!targetAgentId) {
      // 无会话启动器的首条消息需要先创建真实 agent，再提交同一份快照；
      // 创建失败时恢复草稿，避免用户输入在项目选择/启动异常时丢失。
      const tab = await createAgent(starterSelectedProjectId);
      if (!tab) {
        setPromptByAgent((current) => ({
          ...current,
          [NEW_SESSION_DRAFT_ID]: message,
        }));
        if (images?.length) {
          setAttachedImagesByAgent((current) => ({
            ...current,
            [NEW_SESSION_DRAFT_ID]: images,
          }));
        }
        return;
      }
      targetAgentId = tab.id;
    }
    await submitPromptSnapshot(targetAgentId, message, images);
  }

  async function sendPromptAsFollowUp() {
    if (
      isAgentStarting ||
      !activeAgentId ||
      (!prompt.trim() && attachedImages.length === 0)
    )
      return;
    const message = prompt;
    const images = attachedImages.length > 0 ? attachedImages : undefined;
    setAutoScroll(true);
    const scrollTimeline = timelineRef.current;
    if (scrollTimeline) scrollTimeline.scrollTo({ top: scrollTimeline.scrollHeight, behavior: "instant" });
    setPrompt("");
    setAttachedImages([]);
    setSuggestionsOpen(false);
    setSendBehaviorMenuOpen(false);
    await submitPromptSnapshot(activeAgentId, message, images, "followUp");
  }

  /** 处理 /goal 命令 */
  function handleGoalCommand(input: string) {
    const trimmed = input.replace(/^\/goal/, "").trim();
    const first = trimmed.split(/\s+/)[0];

    if (!trimmed || first === "status") {
      if (goalStatusRef.current === "none") {
        showToast(!activeAgentId ? t("goal.noGoal") : `Usage: /goal <objective>\nNo goal set.`, 3000);
      } else {
        const elapsed = goalStartedAtRef.current ? Math.floor((Date.now() - goalStartedAtRef.current) / 1000) : 0;
        const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`;
        const tokenHint = goalIterationRef.current > 0 ? ` (续接 ${goalIterationRef.current} 次)` : "";
        showToast(`🎯 ${goalStatusRef.current === "complete" ? "已完成" : "进行中"}: ${goalTextRef.current}\n耗时: ${elapsedStr} | 状态: ${goalStatusRef.current}${tokenHint}`, 4000);
      }
      return;
    }

    if (first === "clear" || first === "stop") {
      goalStatusRef.current = "none";
      goalTextRef.current = "";
      goalStartedAtRef.current = 0;
      goalIterationRef.current = 0;
      goalContinuationPendingRef.current = false;
      goalLastResponseSignatureRef.current = "";
      setGoalStatus("none");
      setGoalText("");
      setGoalStartedAt(0);
      setGoalCompletedAt(0);
      showToast("🎯 Goal cleared", 2000);
      return;
    }

    if (first === "pause") {
      if (goalStatusRef.current !== "active") {
        showToast("No active goal to pause.", 2000);
        return;
      }
      goalStatusRef.current = "paused";
      setGoalStatus("paused");
      goalContinuationPendingRef.current = false;
      showToast(`🎯 Goal paused: ${goalTextRef.current}`, 3000);
      return;
    }

    if (first === "resume") {
      if (goalStatusRef.current !== "paused") {
        showToast("No paused goal to resume.", 2000);
        return;
      }
      goalStatusRef.current = "active";
      setGoalStatus("active");
      goalContinuationPendingRef.current = false;
      goalLastResponseSignatureRef.current = "";
      void submitPromptSnapshot(activeAgentId!, `[goal 续接] 之前暂停的目标已恢复，请继续完成:
<goal_objective>
${goalTextRef.current}
</goal_objective>`, undefined, "followUp");
      showToast(`🎯 Goal resumed: ${goalTextRef.current}`, 3000);
      return;
    }

    // /goal <objective> — 启动新目标
    const objective = trimmed;
    const existing = goalStatusRef.current;
    if (existing === "active") {
      if (!window.confirm(`当前有进行中的目标:\n${goalTextRef.current}\n\n是否替换为新目标?`)) return;
    }

    goalTextRef.current = objective;
    goalStatusRef.current = "active";
    goalStartedAtRef.current = Date.now();
    goalIterationRef.current = 0;
    goalContinuationPendingRef.current = false;
    goalLastResponseSignatureRef.current = "";
    setGoalText(objective);
    setGoalStatus("active");
    setGoalStartedAt(Date.now());
    setGoalCompletedAt(0);

    // 将目标文本作为普通消息发送（不使用 followUp，避免显示错误的消息标签）
    void submitPromptSnapshot(activeAgentId!, objective);
    // 目标文本作为用户消息显示在对话中，goal 状态可通过 /goal status 查看
  }

  async function submitPromptSnapshot(
    agentId: string,
    message: string,
    images?: ImageContent[],
    streamingBehavior?: "steer" | "followUp",
  ) {
    // 这里接收快照参数,让 composer 发送和历史消息"重新发送"共享同一条路径。
    // Agent 忙碌时显式使用官方 streamingBehavior=steer:消息会进入 pi 的运行中队列,
    // 而不是留在 desktop 本地等整个 agent idle 后再发送。
    const behavior = streamingBehavior ?? (isAgentBusy ? "steer" : undefined);
    await api.agents.prompt({
      agentId,
      message,
      images,
      ...(behavior ? { streamingBehavior: behavior } : {}),
    });
  }

  function resendUserMessage(message: ChatMessage) {
    if (!activeAgentId || message.agentId !== activeAgentId) return;
    // "重新发送"按原消息快照再次提交,不修改输入框,图片也复用原始 base64 内容。
    void submitPromptSnapshot(activeAgentId, message.text, message.images);
  }

  /**
   * 处理图片文件,转为 pi RPC 可识别的 ImageContent。
   * 大图会压缩到最长边 2000px,避免 base64 过大导致 RPC 传输和模型上下文成本上升。
   */
  async function processImageFile(file: File): Promise<ImageContent | null> {
    const maxSize = 10 * 1024 * 1024; // 原始文件 10MB 限制,避免误粘超大图片卡住渲染进程
    if (file.size > maxSize) {
      showToast(t("app.imageTooLarge"), 3000);
      return null;
    }

    const validTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    if (!validTypes.includes(file.type)) {
      showToast(t("app.imageUnsupported"), 3000);
      return null;
    }

    // GIF 可能是动图,canvas 压缩会丢失动画;保留原始数据。
    if (file.type === "image/gif") return fileToImageContent(file);
    return resizeImageFile(file, 2000, 0.86).catch(() =>
      fileToImageContent(file),
    );
  }

  function fileToImageContent(file: File): Promise<ImageContent> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(dataUrlToImageContent(String(reader.result), file.type));
      reader.readAsDataURL(file);
    });
  }

  function dataUrlToImageContent(
    dataUrl: string,
    fallbackMimeType: string,
  ): ImageContent {
    const [meta, data = ""] = dataUrl.split(",");
    const mimeType = meta.match(/^data:(.*?);base64$/)?.[1] || fallbackMimeType;
    return { type: "image", data, mimeType };
  }

  function resizeImageFile(
    file: File,
    maxEdge: number,
    quality: number,
  ): Promise<ImageContent> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const image = new Image();
        image.onerror = reject;
        image.onload = () => {
          const scale = Math.min(
            1,
            maxEdge / Math.max(image.width, image.height),
          );
          const width = Math.max(1, Math.round(image.width * scale));
          const height = Math.max(1, Math.round(image.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
          // JPEG 更省 token/传输体积;透明 PNG/WebP 保持 PNG,避免截图透明区域变黑。
          const outputType =
            file.type === "image/png" ? "image/png" : "image/jpeg";
          resolve(
            dataUrlToImageContent(
              canvas.toDataURL(outputType, quality),
              outputType,
            ),
          );
        };
        image.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  /** 处理粘贴事件:从剪贴板提取图片 */
  async function handlePaste(event: React.ClipboardEvent) {
    const items = Array.from(event.clipboardData.items);
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const image = await processImageFile(file);
          if (image) {
            setAttachedImages((prev) => [...prev, image]);
          }
        }
        return;
      }
    }
  }

  /** 处理拖拽事件:支持拖入图片 */
  async function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        const image = await processImageFile(file);
        if (image) {
          setAttachedImages((prev) => [...prev, image]);
        }
      }
    }
  }

  async function handleImageFileInput(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const image = await processImageFile(file);
      if (image) {
        setAttachedImages((prev) => [...prev, image]);
      }
    }
    if (imageFileInputRef.current) {
      imageFileInputRef.current.value = "";
    }
  }

  function handleDragOver(event: React.DragEvent) {
    event.preventDefault();
  }

  /** 移除已附加的图片 */
  function removeImage(index: number) {
    setAttachedImages((prev) => prev.filter((_, i) => i !== index));
  }

  /** 清空所有附加图片 */
  function clearImages() {
    setAttachedImages([]);
  }

  async function updateSettings(patch: Partial<AppSettings>) {
    try {
      const next = await api.settings.update(patch);
      setSettings(next);
      let notice = t("app.settingsSaved");
      if (
        "piProxyEnabled" in patch ||
        "piProxyUrl" in patch ||
        "piProxyBypass" in patch
      ) {
        notice = next.piProxyEnabled
          ? t("app.shellProxySaved")
          : t("app.shellProxyDisabled");
        setPiProxyNoticeTone("info");
        setPiProxyNotice(next.piProxyEnabled ? t("app.shellProxySaved") : "");
      }
      if (
        "desktopProxyEnabled" in patch ||
        "desktopProxyUrl" in patch ||
        "desktopProxyBypass" in patch
      ) {
        notice = next.desktopProxyEnabled
          ? t("app.webProxySaved")
          : t("app.webProxyDisabled");
      }
      if ("sendShortcut" in patch) {
        notice = t("app.sendShortcutSaved");
      }
      if ("useNativeTitleBar" in patch) {
        notice = t("app.titleBarSaved");
      }
      setSettingsNotice(notice);
    } catch (error) {
      setSettings(await api.settings.get());
      setSettingsNotice(error instanceof Error ? error.message : String(error));
    } finally {
    }
  }

  async function testPiProxy() {
    setPiProxyChecking(true);
    setPiProxyNoticeTone("info");
    setPiProxyNotice(t("app.proxyChecking"));
    try {
      const result = await api.settings.testPiProxy();
      setPiProxyNoticeTone(result.success ? "success" : "error");
      setPiProxyNotice(
        result.success
          ? t("app.proxyAvailable", {
              message: result.message ?? t("app.proxyDefaultOk"),
              elapsed: result.elapsedMs,
            })
          : t("app.proxyCheckFailed", {
              error: result.error ?? t("app.proxyUnknownError"),
            }),
      );
    } catch (error) {
      setPiProxyNoticeTone("error");
      setPiProxyNotice(
        t("app.proxyCheckFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setPiProxyChecking(false);
    }
  }

  function openDrawer(panel: DrawerPanel) {
    if (drawerPinned && panel !== drawerPinnedPanel) return;
    if (panel === "sessions" && activeProjectId) {
      setSessionsProjectId(activeProjectId);
      void refreshSessions(activeProjectId);
    }
    setDrawer((current) => {
      if (current === panel) return drawerPinned ? current : null;
      return panel;
    });
  }

  function closeDrawer() {
    if (drawerPinned) return;
    setDrawer(null);
  }

  function collapseDrawer() {
    if (drawerPinned) return;
    setDrawerCollapsed(true);
  }

  function toggleDrawerPinned() {
    if (!activeAgentId || !drawer) return;
    setDrawerPinnedByAgent((current) => {
      const next = { ...current };
      if (next[activeAgentId]) delete next[activeAgentId];
      else next[activeAgentId] = drawer;
      return next;
    });
  }

  function toggleDirectory(path: string) {
    // 文件树默认折叠,只有用户显式展开目录才显示子项,避免大仓库一打开就产生视觉噪音。
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function startResize(target: "list" | "drawer", event: PointerEvent) {
    const startX = event.clientX;
    const startListWidth = listCollapsed ? 68 : listWidth;
    const startDrawerWidth = drawerCollapsed ? 0 : drawerWidth;
    let frame = 0;

    function onMove(moveEvent: globalThis.PointerEvent) {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const delta = moveEvent.clientX - startX;
        if (target === "list") {
          const next = Math.min(440, Math.max(160, startListWidth + delta));
          setListCollapsed(next <= 170);
          setListWidth(next);
        } else {
          const minDrawerWidth = drawerPinned ? 220 : 180;
          const next = Math.min(
            560,
            Math.max(minDrawerWidth, startDrawerWidth - delta),
          );
          setDrawerCollapsed(!drawerPinned && next <= 190);
          setDrawerWidth(next);
        }
      });
    }

    function onUp() {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing");
      document.body.classList.remove("is-list-resizing");
    }

    document.body.classList.add("is-resizing");
    if (target === "list") document.body.classList.add("is-list-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startComposerResize(event: PointerEvent) {
    const startY = event.clientY;
    const startHeight = resolvedComposerHeight;
    let frame = 0;

    function onMove(moveEvent: globalThis.PointerEvent) {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const maxHeight = getComposerMaxHeight();
        // 拖动的是输入区顶部边线,鼠标向上意味着输入区变高;限制最大高度避免挤压会话阅读区域。
        // 实际高度由手动高度和自动内容高度共同决定;拖到最大后自动高度也会变大,
        // 因此手动缩小时必须同步覆盖 autoHeight,否则 Math.max 会继续把输入框顶在最大高度。
        const next = Math.min(
          maxHeight,
          Math.max(
            COMPOSER_MIN_HEIGHT,
            startHeight + startY - moveEvent.clientY,
          ),
        );
        setComposerHeight(next);
        setComposerAutoHeight(next);
      });
    }

    function onUp() {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-composer-resizing");
    }

    document.body.classList.add("is-composer-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function toggleListCollapsed() {
    const nextCollapsed = !listCollapsed;
    if (!nextCollapsed) setListWidth(DEFAULT_LIST_WIDTH);
    if (nextCollapsed) (document.activeElement as HTMLElement | null)?.blur();
    setListCollapsed(nextCollapsed);
  }

  return (
    <div
      className={[
        "wechat-shell",
        "codex-shell",
        drawer ? "drawer-open" : "",
        !activeAgent || activeMessages.length === 0 ? "conversation-empty" : "",
        listCollapsed ? "list-collapsed" : "",
        drawerCollapsed ? "drawer-collapsed" : "",
        settings.useNativeTitleBar ? "" : "custom-titlebar-enabled",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        {
          "--list-width": `${listWidth}px`,
          "--list-track": `${listCollapsed ? 0 : listWidth}px`,
          "--list-expanded-width": `${listWidth}px`,
          "--drawer-width": `${drawerWidth}px`,
          "--drawer-track": `${drawer && !drawerCollapsed ? drawerWidth : 0}px`,
        } as React.CSSProperties
      }
    >
      {!settings.useNativeTitleBar && (
        <div className="window-drag-layer" aria-hidden="true" />
      )}
      {!settings.useNativeTitleBar && (
        <div className="window-sidebar-controls">
          <button
            type="button"
            className="window-sidebar-toggle"
            aria-label={listCollapsed ? t("app.expandList") : t("app.collapseList")}
            title={listCollapsed ? t("app.expandList") : t("app.collapseList")}
            onClick={toggleListCollapsed}
          >
            {listCollapsed ? (
              <PanelLeftOpen size={16} strokeWidth={1.9} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={16} strokeWidth={1.9} aria-hidden="true" />
            )}
          </button>
          <div className="titlebar-brand" aria-label={t("app.brand")}>
            <img src={appIconUrl} alt="" aria-hidden="true" />
            <span>{t("app.brand")}</span>
          </div>
        </div>
      )}
      {!settings.useNativeTitleBar && (
        <div className="window-controls" aria-label={t("app.windowControls")}>
          <button
            type="button"
            className={`window-control pin${windowAlwaysOnTop ? " active" : ""}`}
            aria-label={
              windowAlwaysOnTop ? t("app.windowUnpin") : t("app.windowPin")
            }
            title={
              windowAlwaysOnTop ? t("app.windowUnpin") : t("app.windowPin")
            }
            onClick={async () => {
              const next = await api.app.toggleAlwaysOnTopWindow();
              setWindowAlwaysOnTop(next);
            }}
          >
            <Pin size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control"
            aria-label={t("app.windowMinimize")}
            title={t("app.windowMinimize")}
            onClick={() => api.app.minimizeWindow()}
          >
            <Minus size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control"
            aria-label={t("app.windowToggleMaximize")}
            title={t("app.windowToggleMaximize")}
            onClick={() => api.app.toggleMaximizeWindow()}
          >
            <Square size={13} strokeWidth={2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control close"
            aria-label={t("app.windowClose")}
            title={t("app.windowClose")}
            onClick={() => api.app.closeWindow()}
          >
            <X size={16} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      )}
      <aside
        className={`chat-list-pane${search.trim() ? " sidebar-searching" : ""}`}
      >
        <nav className="sidebar-primary-nav" aria-label={t("app.sidebarPrimaryNav")}>
          <button
            className="sidebar-nav-item"
            disabled={isAgentStarting}
            onClick={() => openNewSessionStarter()}
          >
            <Plus size={16} />
            <span>{t("app.newSession")}</span>
          </button>
          <button
            className="sidebar-nav-item"
            onClick={() => {
              if (listCollapsed) setListCollapsed(false);
              requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
          >
            <Search size={16} />
            <span>{t("app.search")}</span>
          </button>
          {!isLanWeb && (
            <>
              <button
                className="sidebar-nav-item"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings size={16} />
                <span>{t("settings.title")}</span>
              </button>
            </>
          )}
        </nav>
        <div className="search-row">
          <div className="search-box">
            <span className="search-icon">
              <Search size={14} />
            </span>
            <input
              ref={searchInputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("app.search")}
            />
          </div>
          <button className="round-add" onClick={addProject}>
            <Plus size={18} />
          </button>
        </div>

        <div className="sidebar-section-label">{t("app.sidebarProjects")}</div>
        <div className="conversation-list">
          {filteredProjects.map((project) => {
            const projectIsChat = isChatProject(project);
            const projectDirectoryName = projectIsChat
              ? t("app.chatProject")
              : displayProjectDirectoryName(project);
            const canDragProject = canReorderProjects && !projectIsChat;
            const projectAgents = filteredAgents.filter(
              (agent) => agent.projectId === project.id,
            );
            const projectSearch = search.trim();
            const projectSessions = projectSearch
              ? (sessionsByProject[project.id] ?? []).filter((session) =>
                  matches(
                    `${session.name ?? ""}${session.preview}${session.filePath}`,
                    projectSearch,
                  ),
                )
              : (sessionsByProject[project.id] ?? []);
            const visibleChildCount =
              visibleProjectChildCountByProject[project.id] ??
              SIDEBAR_PROJECT_CHILD_PAGE_SIZE;
            const projectDisplay = getProjectAgentSessionDisplay({
              agents: projectAgents,
              sessions: projectSessions,
              visibleChildCount,
            });
            const projectSessionsLoading = Boolean(
              sessionLoadingByProject[project.id],
            );
            const hasProjectChildren =
              projectDisplay.children.length > 0 || projectSessionsLoading;
            const isCollapsed = collapsedProjects.has(project.id);
            const isDraggingProject = draggingProjectId === project.id;
            const isProjectDropTarget = dragOverProjectId === project.id;
            const projectRowClass = [
              project.id === activeProjectId && !activeAgentId
                ? "conversation active"
                : "conversation",
              canDragProject ? "project-draggable" : "",
              projectIsChat ? "chat-project" : "",
              isDraggingProject ? "dragging" : "",
              isProjectDropTarget ? "drag-over" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={project.id}
                className={`project-group${projectIsChat ? " chat-project-group" : ""}`}
              >
                <button
                  className={projectRowClass}
                  draggable={canDragProject}
                  onDragStart={(event) =>
                    handleProjectDragStart(event, project.id)
                  }
                  onDragOver={(event) =>
                    handleProjectDragOver(event, project.id)
                  }
                  onDragLeave={() => handleProjectDragLeave(project.id)}
                  onDrop={(event) => void handleProjectDrop(event, project.id)}
                  onDragEnd={finishProjectDrag}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (projectIsChat) return;
                    setProjectMenu({
                      x: event.clientX,
                      y: event.clientY,
                      project,
                    });
                  }}
                  onClick={() => {
                    if (projectDragPreventClickRef.current) return;
                    // 项目首次点击时历史会话可能还未加载,仍要先选中并展开 loading 状态。
                    setActiveProjectId(project.id);
                    setActiveAgentId(undefined);
                    const projectSessionsLoaded = hasProjectSessionsLoaded(project.id);
                    const wasCollapsed = collapsedProjects.has(project.id);
                    const willBeExpanded = wasCollapsed || !projectSessionsLoaded;

                    if (hasProjectChildren || !projectSessionsLoaded) {
                      setCollapsedProjects((prev) => {
                        const next = new Set(prev);
                        if (next.has(project.id)) next.delete(project.id);
                        else if (hasProjectChildren) next.add(project.id);
                        else next.delete(project.id);
                        return next;
                      });
                    }

                    if (willBeExpanded && !projectIsChat) {
                      if (!projectSessionsLoaded) {
                        void refreshProjectSessions(project.id).catch(() => undefined);
                      }
                    }

                  }}
                >
                  <span
                    className={`project-fold${isCollapsed ? " folded" : ""}${hasProjectChildren ? " has-agents" : ""}`}
                    title={
                      isCollapsed
                        ? t("app.projectExpand")
                        : t("app.projectCollapse")
                    }
                  >
                    <Play size={12} />
                  </span>
                  <ProjectAvatar
                    name={projectDirectoryName}
                    kind={projectIsChat ? "chat" : "project"}
                  />
                  <div className="conversation-body">
                    <div className="conversation-title">
                      <strong title={project.path}>
                        {projectDirectoryName}
                      </strong>
                    </div>
                    {projectIsChat && (
                      <p className="chat-project-guide">
                        {t("app.projectChatGuide")}
                      </p>
                    )}
                  </div>
                  <span className="project-row-actions">
                    <span
                      className="project-info"
                      title={
                        projectIsChat
                          ? t("app.projectChatInfo")
                          : t("app.projectInfo")
                      }
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Info size={14} />
                    </span>
                    {!projectIsChat && (
                      <span
                        className="project-action project-delete"
                        title={t("app.projectRemoveTitle")}
                        onClick={async (event) => {
                          event.stopPropagation();
                          const next = await api.projects.remove(project.id);
                          setProjects(next);
                          updateAfterProjectRemoved(project.id, next);
                        }}
                      >
                        <Trash2 size={14} />
                      </span>
                    )}
                  </span>
                </button>
                {!isCollapsed &&
                  projectDisplay.visibleChildren.map((child) => {
                    if (child.type === "agent") {
                      const agent = child.agent;
                      const isActiveAgent = agent.id === activeAgentId;
                      return (
                        <button
                          key={child.key}
                          className={
                            isActiveAgent
                              ? "conversation agent-row active"
                              : "conversation agent-row"
                          }
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setAgentMenu({
                              x: event.clientX,
                              y: event.clientY,
                              agent,
                            });
                          }}
                          onClick={() => {
                            setActiveProjectId(project.id);
                            setActiveAgentId(agent.id);
                          }}
                        >
                          <span className="agent-node-marker" aria-hidden="true" />
                          <div className="conversation-body">
                            <div className="conversation-title">
                              <strong>{agent.title}</strong>
                              {agent.status && (
                                <span className={`agent-status-indicator status-${agent.status}`}>
                                  {agent.status === 'running' && '●'}
                                  {agent.status === 'idle' && '○'}
                                  {agent.status === 'starting' && '◐'}
                                  {' '}
                                  {t(`app.status${agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}` as any) || agent.status}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    }

                    const session = child.session;
                    return (
                      <button
                        key={child.key}
                        className="conversation agent-row session-row"
                        title={session.filePath}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setSessionMenu({
                            x: event.clientX,
                            y: event.clientY,
                            projectId: project.id,
                            session,
                          });
                        }}
                        onClick={() =>
                          void openSidebarSession(project.id, session)
                        }
                      >
                        <span
                          className="session-node-marker"
                          aria-hidden="true"
                        />
                        <div className="conversation-body">
                          <div className="conversation-title">
                            <strong>
                              {session.name || t("common.untitled")}
                            </strong>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                {!isCollapsed && projectSessionsLoading && (
                  <div className="project-session-loading">
                    {t("app.projectSessionsLoading")}
                  </div>
                )}
                {!isCollapsed && projectDisplay.hiddenChildCount > 0 && (
                  <button
                    className="session-more-row"
                    onClick={() => {
                      setVisibleProjectChildCountByProject((current) => ({
                        ...current,
                        [project.id]:
                          (current[project.id] ?? SIDEBAR_PROJECT_CHILD_PAGE_SIZE) +
                          SIDEBAR_PROJECT_CHILD_PAGE_SIZE,
                      }));
                    }}
                  >
                    <span className="agent-more-branch" />
                    <span>
                      {t("app.projectShowMoreChildren", {
                        count: projectDisplay.hiddenChildCount,
                      })}
                    </span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {!isLanWeb && (
          <div className="toolbar-actions sidebar-bottom-actions">
            <div className="sidebar-bottom-primary-actions">
              <button
                className="icon-button settings-icon"
                title={t("settings.title")}
                onClick={() => setSettingsOpen(true)}
              >
                <Settings size={17} />
              </button>
              <button
                className="icon-button homepage-icon"
                title={t("app.homepage")}
                onClick={() => api.app.openExternal("https://pi.dev/packages")}
              >
                <Globe size={17} />
              </button>
            </div>
          </div>
        )}
      </aside>

      <div
        className="splitter splitter-left"
        onPointerDown={(event) => startResize("list", event)}
      />

      <main ref={chatPaneRef} className="chat-pane">
        <header ref={chatHeaderRef} className="chat-header">
          <div className="chat-title-block">
            <div className="chat-title-row">
              <strong
                title={activeAgent?.title ?? activeProject?.name ?? t("app.brand")}
              >
                {activeAgent?.title ??
                  (isChatProject(activeProject)
                    ? t("app.chatProject")
                    : activeProject?.name) ??
                  t("app.brand")}
              </strong>
              {activeAgent && (
                <span className="chat-path" title={activeProject?.path ?? activeAgent.cwd}>
                  {displayPath(activeProject?.path ?? activeAgent.cwd)}
                </span>
              )}
            </div>
            <div className="chat-subtitle-row">
              {activeAgent?.status && (
                <span className={`agent-status-badge status-${activeAgent.status}`}>
                  {activeAgent.status === 'running' && '●'}
                  {activeAgent.status === 'idle' && '○'}
                  {activeAgent.status === 'starting' && '◐'}
                  {' '}
                  {t(`app.status${activeAgent.status.charAt(0).toUpperCase() + activeAgent.status.slice(1)}` as any) || activeAgent.status}
                </span>
              )}
          </div>
          </div>
          <div
            className={`chat-header-actions${activeAgent?.status === "starting" ? " loading" : ""}`}
          >
            <>
              <div className="header-action-group panel-group">
                {!isLanWeb && (
                  <>
                    <div className="file-action-combo" ref={fileActionsRef}>
                      <button
                        className={drawer === "files" ? "active file-action-trigger" : "file-action-trigger"}
                        disabled={isAgentStarting}
                        onClick={() => setFileActionsOpen((open) => !open)}
                        title={t("app.openProjectInEditor")}
                      >
                        <FolderOpen size={16} />
                        <span className={`session-combo-chevron${fileActionsOpen ? " open" : ""}`}>
                          <ChevronDown size={12} />
                        </span>
                      </button>
                      {fileActionsOpen && (
                        <div className="file-action-menu">
                          <button
                            className="show-files-action"
                            title={t("app.showInSidebar")}
                            onClick={() => {
                              setDrawerCollapsed(false);
                              openDrawer("files");
                              setFileActionsOpen(false);
                            }}
                          >
                            <span>{t("app.showInSidebar")}</span>
                          </button>
                          {externalEditors.map((editor) => (
                            <button
                              key={editor.id}
                              className="external-editor-action"
                              disabled={!(activeAgent?.cwd || (activeProject && !isChatProject(activeProject) ? activeProject.path : undefined))}
                              title={editor.name}
                              onClick={() => {
                                const projectPath = activeAgent?.cwd || (activeProject && !isChatProject(activeProject) ? activeProject.path : undefined);
                                if (!projectPath) return;
                                setFileActionsOpen(false);
                                void api.editors.openProject(editor, projectPath).catch((error) => {
                                  showToast(
                                    t("app.openEditorFailed", {
                                      error: error instanceof Error ? error.message : String(error),
                                    }),
                                    3000,
                                  );
                                });
                              }}
                            >
                              <span className={`editor-logo ${editor.id}`}>
                                {getEditorLogoUrl(editor.id) ? (
                                  <img src={getEditorLogoUrl(editor.id)} alt="" />
                                ) : (
                                  editor.id.slice(0, 2).toUpperCase()
                                )}
                              </span>
                              <span>{editor.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      className="agent-stop-action"
                      disabled={
                        !activeAgentId ||
                        isPendingAgentId(activeAgentId)
                      }
                      onClick={() => {
                        if (!activeAgentId) return;
                        void closeAgent(activeAgentId);
                      }}
                      title={t("app.stop")}
                    >
                      <Square size={13} />
                    </button>
                    <button
                      className={terminalOpen ? "active" : ""}
                      disabled={!activeAgentId || isAgentStarting}
                      onClick={() => {
                        if (!activeAgentId) return;
                        setTerminalOpenForAgent(activeAgentId, !terminalOpen);
                      }}
                      title={t("app.openTerminalTitle")}
                    >
                      <TerminalIcon size={16} />
                    </button>
                  </>
                )}
              </div>
            </>
          </div>
        </header>

        <section className="message-timeline" ref={timelineRef}>
          {hasMoreMessages && activeAgent && activeAgent.status !== "starting" && (
            <div className="message-history-loader">
              <button
                onClick={handleLoadMoreMessages}
                disabled={isLoadingMoreMessages}
              >
                {isLoadingMoreMessages
                  ? t("app.historyLoadMoreLoading")
                  : t("app.historyLoadMore", {
                      count: activeMessages.length - paginatedMessages.length,
                    })
                }
              </button>
            </div>
          )}

          {activeAgent?.status === "starting" && (
            <div className="agent-starting-overlay" role="status" aria-live="polite">
              <div className="agent-starting-card">
                <div className="agent-starting-mark" aria-hidden="true">
                  {Array.from(t("app.brand")).map((letter, index) => (
                    <span
                      key={`${letter}-${index}`}
                      style={{ "--agent-letter-index": index } as CSSProperties}
                    >
                      {letter}
                    </span>
                  ))}
                </div>
                <div className="agent-starting-pulse" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <span className="agent-starting-text">{t("app.agentStarting")}</span>
              </div>
            </div>
          )}
          {!activeAgent && (
            <div className="codex-empty-prompt-title">
              {t("app.emptyAgentPrompt", {
                name: starterProjectLabel,
              })}
            </div>
          )}
          {activeAgent && activeMessages.length === 0 && (
            <div className="codex-empty-prompt-title">
              {t("app.emptyAgentPrompt", {
                name:
                  isChatProject(activeProject)
                    ? t("app.chatProject")
                    : activeProject?.name ?? activeAgent.title,
              })}
            </div>
          )}
          {activeAgent && (
            <div className="message-list">
              {renderedMessages.map((item) =>
                item.kind === "agent-run" ? (
                  <TurnRow
                    key={item.id}
                    run={item}
                    onPreviewImage={setPreviewImage}
                    onOpenExternal={(url) => api.app.openExternal(url)}
                    onOpenFile={openFilePath}
                    onDiffFile={diffFilePath}
                    onResendUserMessage={resendUserMessage}
                    showThinking={settings.showThinking}
                    isStreaming={Boolean(streamingMessageId) && item.id.endsWith(streamingMessageId ?? "")}
                    fileSummariesByMessage={turnFileSummaryByMessage}
                  />
                ) : item.kind === "tool-group" ? (
                  <ToolGroupCard key={item.id} group={item} />
                ) : item.kind === "thinking-group" ? (
                  <ThinkingBlock
                    key={item.id}
                    text={item.text}
                    endedAt={item.endedAt}
                    showThinking={settings.showThinking}
                  />
                ) : item.message.role === "user" ? (
                  <UserBubble
                    key={item.message.id}
                    message={item.message}
                    onPreviewImage={setPreviewImage}
                    onOpenFile={openFilePath}
                    onResendUserMessage={resendUserMessage}
                  />
                ) : (
                  <Fragment key={item.message.id}>
                    <AssistantText
                      text={item.message.text}
                      images={item.message.images}
                      onPreviewImage={setPreviewImage}
                      onOpenExternal={(url) => api.app.openExternal(url)}
                      onOpenFile={openFilePath}
                      isStreaming={item.message.id === streamingMessageId}
                    />
                    {turnFileSummaryByMessage[item.message.id]?.length > 0 && (
                      <SessionFileSummary
                        files={turnFileSummaryByMessage[item.message.id]}
                        onOpenFile={openFilePath}
                        onDiffFile={diffFilePath}
                      />
                    )}
                  </Fragment>
                ),
              )}
              {isAwaitingAssistant && (
                <ThinkingIndicator
                  thinking={activeThinking}
                  showThinking={settings.showThinking}
                />
              )}
            </div>
          )}

        </section>

          {showScrollToBottom && (
            <button
              className="scroll-to-bottom-btn"
              // 按钮脱离滚动容器后，由 composer 实际高度决定 bottom，避免输入框增高或图片预览时遮挡。
              style={{ bottom: Math.max(24, composerOffsetHeight + visibleTerminalHeight + 18) }}
              onClick={scrollToBottom}
              title={t("app.scrollToBottom")}
            >
              <ChevronDown size={18} />
            </button>
          )}

        {outlineItems.length > 1 && (
          <ConversationOutline
            items={outlineItems}
            onJump={handleOutlineJump}
          />
        )}

        {(activeAgent || !activeAgentId) && (
        <footer ref={composerRef} className="composer">
          {/* 图片预览作为输入框上方的附件栏,避免占用 textarea 的可输入区域。 */}
          {attachedImages.length > 0 && (
            <div className="image-preview-area">
              {attachedImages.map((img, index) => (
                <div key={index} className="image-preview-item">
                  <img
                    src={`data:${img.mimeType};base64,${img.data}`}
                    alt={t("app.imageAlt", { index: index + 1 })}
                    onClick={() => setPreviewImage(img)}
                    style={{ cursor: "pointer" }}
                  />
                  <button
                    className="image-remove-btn"
                    onClick={() => removeImage(index)}
                    title={t("app.imageRemove")}
                  >
                    <X size={12} strokeWidth={2.4} />
                  </button>
                </div>
              ))}
              <button
                className="image-clear-btn"
                onClick={clearImages}
                title={t("app.clearImagesTitle")}
              >
                {t("app.clearImages")}
              </button>
            </div>
          )}
          <div
            ref={composerBoxRef}
            className={`composer-box ${
              prompt.startsWith("!!")
                ? "shell-silent-mode"
                : prompt.startsWith("!")
                  ? "shell-mode"
                  : ""
            }`}
            style={{ height: resolvedComposerHeight }}
          >
            <div
              className="composer-resize-handle"
              title={t("app.resizeComposer")}
              onPointerDown={startComposerResize}
            />
            <input
              ref={imageFileInputRef}
              className="composer-file-input"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              onChange={(event) => void handleImageFileInput(event.currentTarget.files)}
            />
            <RichInput
              ref={composerTextareaRef}
              value={prompt}
              className={
                prompt.startsWith("!!")
                  ? "bang-bang"
                  : prompt.startsWith("!")
                    ? "bang"
                    : ""
              }
              disabled={composerDisabled}
              caretRef={pendingComposerCaretRef}
              placeholder={
                isAgentStarting
                  ? t("app.agentStartingPlaceholder")
                  : !activeAgent
                    ? t("app.composerEnterPlaceholder")
                    : prompt.startsWith("!!")
                      ? t("app.composerSilentPlaceholder")
                      : prompt.startsWith("!")
                        ? t("app.composerShellPlaceholder")
                        : settings.sendShortcut === "enter-send"
                          ? t("app.composerEnterPlaceholder")
                          : t("app.composerShortcutPlaceholder")
              }
              onFocus={() => {
                // 仅当光标处存在 @ / 触发器时才打开建议框,避免聚焦即弹空菜单。
                setSuggestionsOpen(detectTrigger(prompt, composerCursor) !== null);
              }}
              onChange={(newValue, cursor) => {
                setPrompt(newValue);
                setComposerCursor(cursor);
                setSuggestionsOpen(detectTrigger(newValue, cursor) !== null);
                // 如果正在历史导航,检测到用户手动编辑内容则退出历史模式
                if (historyNavigating) {
                  const currentHistoryCommand = commandHistory[historyIndex];
                  if (newValue !== currentHistoryCommand) {
                    setHistoryIndex(-1);
                    setHistoryNavigating(false);
                    setSavedPrompt("");
                  }
                }
              }}
              onCursorChange={(cursor) => {
                setComposerCursor(cursor);
              }}
              onKeyDown={handleComposerKeyDown}
              onPaste={handlePaste}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onBlur={() => {
                setSuggestionsOpen(false);
              }}
              onChipClick={(chip: RichInputChip) => {
                // 文件 chip：在系统默认应用中打开对应文件
                if (chip.kind === "file") {
                  const path = chip.raw.slice(1); // 去掉 @ 前缀
                  openFilePath(path);
                }
                // skill chip 点击暂不处理，后续可扩展跳转 skill 详情
              }}
            />
            {suggestionsOpen && !composerDisabled && (
              <PromptSuggestions
                prompt={prompt}
                items={suggestionItems}
                selectedIndex={selectedSuggestionIndex}
                anchorStyle={suggestionAnchorStyle}
                onSelectedIndexChange={setSelectedSuggestionIndex}
                onClose={() => {
                  const el = composerTextareaRef.current;
                  const cursor = el ? getCaretOffsetOf(el) : composerCursor;
                  const result = clearSuggestionTrigger(prompt, cursor);
                  setPrompt(result.text);
                  setComposerCursor(result.cursor);
                  pendingComposerCaretRef.current = result.cursor;
                  setSuggestionsOpen(false);
                  requestAnimationFrame(() => {
                    composerTextareaRef.current?.focus();
                  });
                }}
                onPick={(value) => {
                  const el = composerTextareaRef.current;
                  const cursor = el ? getCaretOffsetOf(el) : composerCursor;
                  const result = applySuggestion(prompt, cursor, value);
                  setPrompt(result.text);
                  setComposerCursor(result.cursor);
                  pendingComposerCaretRef.current = result.cursor;
                  setSuggestionsOpen(false);
                  requestAnimationFrame(() => {
                    composerTextareaRef.current?.focus();
                  });
                }}
              />
            )}
            <div className="composer-footer composer-control-strip">
              <div className="composer-control-left">
                <button
                  className="composer-icon-action"
                  disabled={composerDisabled}
                  title={t("app.composerAttachImage")}
                  onClick={() => imageFileInputRef.current?.click()}
                >
                  <Paperclip size={16} />
                </button>
                <button
                  className="composer-pill-action composer-model-action"
                  disabled={isAgentBusy || composerDisabled || !activeAgent}
                  title={t("app.modelPickerTitle")}
                  onClick={openModelPicker}
                >
                  <Sparkles size={14} />
                  <span>
                    {activeRuntimeState?.modelName ??
                      activeRuntimeState?.modelId ??
                      t("app.model")}
                  </span>
                </button>
                <button
                  className="composer-pill-action"
                  disabled={isAgentBusy || composerDisabled || !activeAgent}
                  title={t("app.thinkingPickerTitle")}
                  onClick={() => setThinkingPickerOpen(true)}
                >
                  <Brain size={14} />
                  <span>{activeRuntimeState?.thinkingLevel ?? t("app.think")}</span>
                </button>
                <div className="composer-access-control" ref={composerAccessRef}>
                  <button
                    className="composer-pill-action"
                    disabled={composerDisabled}
                    title={t("app.composerAccessTitle")}
                    onClick={() => setComposerAccessMenuOpen((open) => !open)}
                  >
                    <ShieldCheck size={14} />
                    <span>{composerAccessLabel}</span>
                  </button>
                  {composerAccessMenuOpen && (
                    <div className="composer-access-menu">
                      <strong>{t("app.composerAccessTitle")}</strong>
                      <span>{t("app.composerAccessHint")}</span>
                      <button
                        className={composerAccessMode === "ask" ? "active" : ""}
                        onClick={() => {
                          setComposerAccessMode("ask");
                          setComposerAccessMenuOpen(false);
                        }}
                      >
                        {t("app.composerAccessAsk")}
                      </button>
                      <button
                        className={composerAccessMode === "auto" ? "active" : ""}
                        onClick={() => {
                          setComposerAccessMode("auto");
                          setComposerAccessMenuOpen(false);
                        }}
                      >
                        {t("app.composerAccessAuto")}
                      </button>
                      <button
                        className={composerAccessMode === "full" ? "active" : ""}
                        onClick={() => {
                          setComposerAccessMode("full");
                          setComposerAccessMenuOpen(false);
                        }}
                      >
                        {t("app.composerAccessFull")}
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="composer-control-right">
                <span className={composerMode ? "composer-mode-status" : "composer-status-compact"}>
                  {composerMode ? composerStatusText : cacheText}
                </span>
                <button
                  className="composer-context-ring"
                  style={contextRingStyle}
                  disabled={
                    contextPercentRaw == null ||
                    activeRuntimeState?.isCompacting ||
                    compacting ||
                    !!activeRuntimeState?.isStreaming
                  }
                  title={
                    contextPercentRaw != null && contextPercent > 30
                      ? t("app.contextCompactTitle", {
                          percent: contextPercentRaw.toFixed(1),
                        })
                      : contextTitle
                  }
                  onClick={() => {
                    if (contextPercent > 30) void compactAgent();
                  }}
                >
                  <Gauge size={14} />
                  <span>{Math.round(contextPercent)}</span>
                </button>
                {activeAgent?.status === "running" && (
                  <button className="stop-send" onClick={() => abortAgent()}>
                    {t("app.stop")}
                  </button>
                )}
                <div className="send-button-group">
                  <button
                    disabled={
                      isAgentStarting ||
                      (!activeAgentId && !starterSelectedProjectId) ||
                      (!prompt.trim() && attachedImages.length === 0)
                    }
                    className={`send-primary-icon${
                      isAgentBusy && (prompt.trim() || attachedImages.length > 0)
                        ? " queue-send"
                        : ""
                    }`}
                    title={
                      isAgentBusy && (prompt.trim() || attachedImages.length > 0)
                        ? t("app.composerAttach")
                        : t("app.send")
                    }
                    onClick={sendPrompt}
                  >
                    <ArrowUp size={17} />
                  </button>
                  {isAgentBusy &&
                    (prompt.trim() || attachedImages.length > 0) && (
                      <div className="send-behavior-menu-wrap">
                        <button
                          className="send-behavior-toggle"
                          title={t("app.sendBehaviorTitle")}
                          onClick={() => setSendBehaviorMenuOpen((open) => !open)}
                        >
                          <ChevronDown size={14} />
                        </button>
                        {sendBehaviorMenuOpen && (
                          <div className="send-behavior-menu">
                            <button onClick={sendPrompt}>
                              <strong>{t("app.sendSteerTitle")}</strong>
                              <span>{t("app.sendSteerDesc")}</span>
                            </button>
                            <button onClick={sendPromptAsFollowUp}>
                              <strong>{t("app.sendFollowUpTitle")}</strong>
                              <span>{t("app.sendFollowUpDesc")}</span>
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                </div>
              </div>
            </div>
          </div>
          {!activeAgent && (
            <div className="starter-project-picker" ref={starterProjectMenuRef}>
              <button
                className={`starter-project-trigger${starterProjectMenuOpen ? " open" : ""}`}
                type="button"
                disabled={starterProjectBusy}
                onClick={() => setStarterProjectMenuOpen((open) => !open)}
              >
                {starterSelectedProject && isChatProject(starterSelectedProject) ? (
                  <MessageCircle size={14} />
                ) : (
                  <Folder size={14} />
                )}
                <span>{starterProjectLabel}</span>
                <ChevronDown size={12} />
              </button>
              {starterProjectMenuOpen && (
                <div className="starter-project-menu">
                  <div className="starter-project-search">
                    <Search size={13} />
                    <input
                      value={starterProjectSearch}
                      onChange={(event) => setStarterProjectSearch(event.target.value)}
                      placeholder={t("app.starterSearchProjects")}
                    />
                  </div>
                  <div className="starter-project-list">
                    {filteredStarterProjects.length > 0 ? (
                      filteredStarterProjects.map((project) => {
                        const selected = project.id === starterSelectedProjectId;
                        return (
                          <button
                            key={project.id}
                            className={selected ? "selected" : ""}
                            type="button"
                            onClick={() => selectStarterProject(project.id)}
                          >
                            <Folder size={14} />
                            <span title={project.path}>{displayProjectDirectoryName(project)}</span>
                            {selected && <Check size={14} />}
                          </button>
                        );
                      })
                    ) : (
                      <div className="starter-project-empty">
                        {t("app.starterNoProjectMatches")}
                      </div>
                    )}
                  </div>
                  <div className="starter-project-actions">
                    <button
                      type="button"
                      disabled={starterProjectBusy}
                      onClick={() => void createBlankStarterProject()}
                    >
                      <FolderPlus size={14} />
                      <span>{t("app.starterCreateBlankProject")}</span>
                    </button>
                    <button
                      type="button"
                      disabled={starterProjectBusy}
                      onClick={() => void chooseExistingStarterProject()}
                    >
                      <FolderOpen size={14} />
                      <span>{t("app.starterUseExistingFolder")}</span>
                    </button>
                    {chatProject && (
                      <button
                        type="button"
                        className={chatProject.id === starterSelectedProjectId ? "selected" : ""}
                        onClick={() => selectStarterProject(chatProject.id)}
                      >
                        <MessageCircle size={14} />
                        <span>{t("app.starterNoProject")}</span>
                        {chatProject.id === starterSelectedProjectId && <Check size={14} />}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </footer>
        )}

        {!isLanWeb && terminalOpen && activeAgentId
          && !settingsOpen
          && !environmentDialog && (
          <TerminalDock
            agentId={activeAgentId}
            collapsed={terminalCollapsed}
            height={terminalHeightByAgent[activeAgentId] ?? COMPOSER_DEFAULT_TERMINAL_HEIGHT}
            terminal={api.terminal}
            onCollapsedChange={(collapsed) =>
              setTerminalCollapsedForAgent(activeAgentId, collapsed)
            }
            onHeightChange={(height) =>
              setTerminalHeightByAgent((current) => ({
                ...current,
                [activeAgentId]: height,
              }))
            }
            onClose={() => setTerminalOpenForAgent(activeAgentId, false)}
          />
        )}
      </main>

      {drawer && !drawerCollapsed && (
        <div
          className="splitter splitter-right"
          onPointerDown={(event) => startResize("drawer", event)}
        />
      )}
      {drawer && (
        <aside
          className={`detail-drawer${drawerCollapsed ? " collapsed" : ""}`}
          aria-hidden={drawerCollapsed}
        >
          <LazyWrapper
            className="drawer-content-frame"
            enabled={true}
            threshold={0}
            rootMargin="50px"
            placeholder={
              <div className="drawer-loading-placeholder">
                {t("common.loading")}
              </div>
            }
          >
            <DrawerContent
              panel={drawer}
              project={drawer === "sessions" ? sessionsProject : undefined}
              files={files}
              sessions={sessions}
              gitChangedFiles={gitChangedFiles}
              expandedDirs={expandedDirs}
              onToggleDirectory={toggleDirectory}
              pinned={drawerPinned}
              onTogglePin={toggleDrawerPinned}
              onCollapse={collapseDrawer}
              onClose={closeDrawer}
              onFileContextMenu={(node, x, y) => setFileMenu({ node, x, y })}
              onRefreshFiles={() => {
                refreshFiles(activeProjectId);
                refreshGitChangedFiles(activeProjectId);
              }}
              onRefreshSessions={() =>
                refreshSessions(sessionsProjectId ?? activeProjectId)
              }
              onOpenSession={(session) =>
                createAgent(
                  sessionsProjectId ?? activeProjectId,
                  session.filePath,
                  session.name || t("common.untitled"),
                )
              }
              onRenameSession={async (filePath, newName) => {
                await api.sessions.rename(filePath, newName);
                await refreshSessions(sessionsProjectId ?? activeProjectId);
              }}
              onCopySession={(session) =>
                copySession(
                  session.filePath,
                  sessionsProjectId ?? activeProjectId,
                )
              }
              onExportSession={exportHistorySession}
              onDeleteSession={deleteHistorySession}
              onDiffFile={diffFilePath}
              onViewFile={viewFilePath}
              onOpenFile={openFilePath}
            />
          </LazyWrapper>
        </aside>
      )}
      {drawer && drawerCollapsed && (
        <button
          className="drawer-restore"
          title={t("drawer.expandPanel")}
          onClick={() => setDrawerCollapsed(false)}
        >
          <ChevronLeft size={16} />
        </button>
      )}
      {fileMenu && (
        <FileContextMenu
          menu={fileMenu}
          onClose={() => setFileMenu(null)}
          onOpen={() => {
            void api.files.open(fileMenu.node.path);
            setFileMenu(null);
          }}
          onReveal={() => {
            void api.files.showInFolder(fileMenu.node.path);
            setFileMenu(null);
          }}
          onAttach={() => {
            setPrompt(
              (current) =>
                `${current}${current.endsWith(" ") || current.length === 0 ? "" : " "}@${fileMenu.node.relativePath} `,
            );
            setFileMenu(null);
          }}
          onCopyPath={() => {
            void navigator.clipboard.writeText(fileMenu.node.path);
            setFileMenu(null);
          }}
          onRename={() => {
            const node = fileMenu.node;
            setRenamingFile({ path: node.path, name: node.name });
            setRenamingFileInput(node.name);
            setFileMenu(null);
          }}
          onDelete={() => {
            const node = fileMenu.node;
            setFileMenu(null);
            setConfirmDialog({
              title: node.type === "directory" ? t("drawer.deleteFolderTitle") : t("drawer.deleteFileTitle"),
              message: node.type === "directory"
                ? t("drawer.deleteFolderConfirm", { name: node.name })
                : t("drawer.deleteFileConfirm", { name: node.name }),
              danger: true,
              confirmLabel: t("common.delete"),
              onConfirm: async () => {
                setConfirmDialog(null);
                try {
                  await api.files.delete(node.path, true);
                  void refreshFiles();
                } catch (e) {
                  console.error("[File] 删除失败:", e);
                }
              },
            });
          }}
        />
      )}
      {projectMenu && (
        <ProjectContextMenu
          menu={projectMenu}
          onClose={() => setProjectMenu(null)}
          onRevealProject={() => {
            void api.files.showInFolder(projectMenu.project.path);
            setProjectMenu(null);
          }}
          onRemoveProject={async () => {
            const project = projectMenu.project;
            setProjectMenu(null);
            const next = await api.projects.remove(project.id);
            setProjects(next);
            updateAfterProjectRemoved(project.id, next);
          }}
        />
      )}
      {agentMenu && (
        <AgentContextMenu
          menu={agentMenu}
          actionLoading={agentActionLoading}
          onClose={() => {
            if (!agentActionLoading) setAgentMenu(null);
          }}
          onRename={() => openAgentRename(agentMenu.agent)}
          onExport={() => {
            void exportAgentHtml(agentMenu.agent.id);
          }}
          onCopySession={() => {
            void cloneAgentSession(agentMenu.agent.id);
          }}
          onShowLogs={() => {
            setRpcLogAgentId(agentMenu.agent.id);
            setAgentMenu(null);
          }}
          onCloseAgent={() => {
            void closeAgent(agentMenu.agent.id);
            setAgentMenu(null);
          }}
        />
      )}
      {sessionMenu && (
        <SessionContextMenu
          menu={sessionMenu}
          actionLoading={sessionActionLoading}
          onClose={() => {
            if (!sessionActionLoading) setSessionMenu(null);
          }}
          onRename={() =>
            openSessionRename(sessionMenu.projectId, sessionMenu.session)
          }
          onExport={() => {
            void exportSidebarSession(
              sessionMenu.projectId,
              sessionMenu.session,
            );
          }}
          onCopySession={() => {
            void copySidebarSession(sessionMenu.projectId, sessionMenu.session);
          }}
          onShowLogs={() => {
            void openSidebarSession(
              sessionMenu.projectId,
              sessionMenu.session,
            ).then((tab) => {
              if (tab) setRpcLogAgentId(tab.id);
            });
          }}
          onDeleteSession={() => {
            const session = sessionMenu.session;
            setSessionMenu(null);
            void deleteHistorySession(session);
          }}
        />
      )}
      {(agentRenameTarget || sessionRenameTarget) && (
        <div
          className="modal-backdrop rename-dialog-backdrop"
          onClick={() => {
            if (!agentRenaming) {
              setAgentRenameTarget(null);
              setSessionRenameTarget(null);
            }
          }}
        >
          <form
            className="rename-dialog"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              if (agentRenameTarget) void submitAgentRename();
              else void submitSessionRename();
            }}
          >
            <div className="rename-dialog-header">
              <strong>{t("app.renameSessionTitle")}</strong>
              <button
                type="button"
                disabled={agentRenaming}
                onClick={() => {
                  setAgentRenameTarget(null);
                  setSessionRenameTarget(null);
                }}
              >
                <X size={15} />
              </button>
            </div>
            <input
              autoFocus
              value={agentRenameValue}
              onChange={(event) => setAgentRenameValue(event.target.value)}
              placeholder={t("app.renameSessionPlaceholder")}
              disabled={agentRenaming}
            />
            <div className="rename-dialog-actions">
              <button
                type="button"
                disabled={agentRenaming}
                onClick={() => {
                  setAgentRenameTarget(null);
                  setSessionRenameTarget(null);
                }}
              >
                {t("common.cancel")}
              </button>
              <button type="submit" disabled={agentRenaming}>
                {agentRenaming ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </form>
        </div>
      )}
      {/* RPC 日志弹窗 */}
      {rpcLogAgentId && (
        <RpcLogModal
          logs={rpcLogs.filter((l) => l.agentId === rpcLogAgentId)}
          onClose={() => setRpcLogAgentId(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
      {environmentDialog && (
        <EnvironmentDialog
          status={piStatus}
          checking={piChecking}
          onClose={() => {
            setEnvironmentDialog(false);
            setCustomPathResult(null);
          }}
          onRecheck={() => {
            setCustomPathResult(null);
            checkPiInstall("manual");
          }}
          onOpenInstallDocs={() =>
            api.app.openExternal(
              "https://pi.dev/docs/latest/quickstart#install",
            )
          }
          customPath={customPiPath}
          customPathValidating={customPathValidating}
          customPathResult={customPathResult}
          onCustomPathChange={(path) => {
            setCustomPiPath(path);
            setCustomPathResult(null);
          }}
          onValidateCustomPath={() =>
            validateCustomPiPath({ closeDialogOnSuccess: true })
          }
        />
      )}
      {modelPickerOpen && (
        <ModelPicker
          models={availableModels}
          current={{
            provider: activeRuntimeState?.provider,
            modelId: activeRuntimeState?.modelId,
            modelName: activeRuntimeState?.modelName,
          }}
          onClose={() => setModelPickerOpen(false)}
          onPick={selectModel}
        />
      )}
      {thinkingPickerOpen && (
        <ThinkingPicker
          current={activeRuntimeState?.thinkingLevel}
          onClose={() => setThinkingPickerOpen(false)}
          onPick={selectThinking}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          notice={settingsNotice}
          piStatus={piStatus}
          piChecking={piChecking}
          piProxyChecking={piProxyChecking}
          piProxyNotice={piProxyNotice}
          piProxyNoticeTone={piProxyNoticeTone}
          appInfo={appInfo}
          customPiPath={customPiPath}
          customPathValidating={customPathValidating}
          customPathResult={customPathResult}
          updateChecking={updateChecking}
          piUpdating={piUpdating}
          piUpdateChecking={piUpdateChecking}
          piUpdateCheck={piUpdateCheck}
          piUpdateResult={piUpdateResult}
          onCustomPathChange={(path) => {
            setCustomPiPath(path);
            setCustomPathResult(null);
          }}
          onValidateCustomPath={() => validateCustomPiPath()}
          onClearCustomPath={clearCustomPiPath}
          onCheckPi={checkPiInstallInline}
          onTestPiProxy={() => testPiProxy()}
          onCheckUpdate={() => checkAppUpdate("manual")}
          onCheckPiUpdate={checkPiCliUpdate}
          onUpdatePi={updatePiCli}
          onToggleDevTools={async () => {
            const opened = await api.app.toggleDevTools();
            setSettingsNotice(
              opened ? t("app.devToolsOpened") : t("app.devToolsClosed"),
            );
          }}
          onRestartApp={() => api.app.restart()}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsNotice("");
          }}
          onChange={updateSettings}
          renderConfigPanel={(group) => (
            <ConfigSettingsPanel
              group={group}
              api={api}
              onSaved={() => {
                // 配置保存后不自动重启 agent；用户可在需要时手动重启当前会话。
              }}
            />
          )}
        />
      )}
      {updateInfo && (
        <UpdateModal
          info={updateInfo}
          checking={updateChecking}
          downloading={updateDownloading}
          progress={updateProgress}
          downloadedPath={downloadedUpdatePath}
          onClose={() => setUpdateInfo(null)}
          onOpenRelease={() => api.app.openExternal(updateInfo.releaseUrl)}
          onDownload={() => void downloadAppUpdate()}
          onInstall={() => void installDownloadedAppUpdate()}
          onBrowserDownload={() =>
            api.app.openExternal(
              updateInfo.recommendedAsset?.url ?? updateInfo.releaseUrl,
            )
          }
        />
      )}
      {updateError && (
        <UpdateErrorModal
          message={updateError}
          releasesUrl={appInfo.releasesUrl}
          onClose={() => setUpdateError(null)}
          onOpenRelease={() => api.app.openExternal(appInfo.releasesUrl)}
        />
      )}
      {upToDateVersion && (
        <UpToDateModal
          version={upToDateVersion}
          releasesUrl={appInfo.releasesUrl}
          onClose={() => setUpToDateVersion(null)}
          onOpenRelease={() => api.app.openExternal(appInfo.releasesUrl)}
        />
      )}
      {diffViewFile && (
        <FileDiffViewer
          filePath={diffViewFile}
          mode={diffViewMode}
          originalContent={diffViewMode === "diff" ? diffViewOriginalContent : undefined}
          modifiedContent={diffViewModifiedContent}
          onClose={() => { setDiffViewFile(null); setDiffViewMode("view"); }}
          readContent={(path) => api.files.readContent(path)}
          readOriginalContent={(path) => api.git.originalContent(path)}
          saveContent={(path, content) => api.files.writeContent(path, content)}
          theme={document.documentElement.dataset.theme === "dark" ? "dark" : "light"}
          maxFileSizeMB={settings.maxEditorFileSizeMB}
        />
      )}
      {previewImage && (
        <ImagePreviewModal
          image={previewImage}
          onClose={() => setPreviewImage(null)}
        />
      )}
      {sessionsProject && (
        <SessionHistoryModal
          project={sessionsProject}
          sessions={sessions}
          loading={sessionHistoryLoading}
          onClose={() => {
            setSessionsProjectId(undefined);
            setSessions([]);
          }}
          onRefresh={() => refreshSessionHistory(sessionsProject.id)}
          onOpen={openHistorySession}
          onRename={renameHistorySession}
          onCopy={(session) =>
            copySession(session.filePath, sessionsProject.id)
          }
          onExport={exportHistorySession}
          onDelete={deleteHistorySession}
        />
      )}
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          danger={confirmDialog.danger}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      {renamingFile && (
        <div className="config-modal-overlay" onClick={() => setRenamingFile(null)}>
          <div className="config-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <strong>{t("drawer.renameTitle")}</strong>
            <div style={{ margin: "12px 0" }}>
              <input
                type="text"
                value={renamingFileInput}
                onChange={(e) => setRenamingFileInput(e.target.value)}
                className="config-input"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const path = renamingFile.path;
                    const newName = renamingFileInput.trim();
                    if (newName && newName !== renamingFile.name) {
                      void api.files.rename(path, newName).then(() => {
                        void refreshFiles();
                        setRenamingFile(null);
                      }).catch((err) => console.error("[File] 重命名失败:", err));
                    } else {
                      setRenamingFile(null);
                    }
                  }
                  if (e.key === "Escape") setRenamingFile(null);
                }}
              />
            </div>
            <div className="config-modal-actions">
              <button className="config-btn" onClick={() => setRenamingFile(null)}>
                {t("common.cancel")}
              </button>
              <button
                className="config-btn primary"
                onClick={() => {
                  const path = renamingFile.path;
                  const newName = renamingFileInput.trim();
                  if (newName && newName !== renamingFile.name) {
                    void api.files.rename(path, newName).then(() => {
                      void refreshFiles();
                      setRenamingFile(null);
                    }).catch((err) => console.error("[File] 重命名失败:", err));
                  } else {
                    setRenamingFile(null);
                  }
                }}
              >
                {t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

  // 从用户描述中提取简短摘要作为 issue 标题的一部分
  // 反馈报告刻意只展示脱敏路径和运行时版本,避免把用户 home 目录、API key 或会话内容默认发出去。
function formatUpdateBytes(bytes?: number) {
  if (!bytes || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

function UpdateModal(props: {
  info: AppUpdateInfo;
  checking: boolean;
  downloading: boolean;
  progress: AppUpdateDownloadProgress | null;
  downloadedPath: string | null;
  onClose: () => void;
  onDownload: () => void;
  onInstall: () => void;
  onBrowserDownload: () => void;
  onOpenRelease: () => void;
}) {
  const progressPercent = props.progress?.percent ?? 0;
  return (
    <div className="modal-backdrop update-backdrop">
      <section className="update-modal">
        <div className="modal-header">
          <strong>
            {t("update.availableTitle", { version: props.info.latestVersion })}
          </strong>
          <CloseIconButton label={t("common.close")} onClick={props.onClose} />
        </div>
        <div className="update-body">
          <p className="update-version-line">
            {t("update.currentLatest", {
              current: props.info.currentVersion,
              latest: props.info.latestVersion,
            })}
          </p>
          {props.info.recommendedAsset && (
            <p className="update-asset-line">
              {t("update.recommendedAsset", {
                name: props.info.recommendedAsset.name,
              })}
            </p>
          )}
          {props.progress && (
            <div className="update-download-progress">
              <div className="update-progress-header">
                <span>{props.progress.assetName}</span>
                <span>{progressPercent ? `${progressPercent.toFixed(1)}%` : t("update.downloading")}</span>
              </div>
              <div className="update-progress-track">
                <div
                  className="update-progress-bar"
                  style={{ width: `${Math.max(0, Math.min(100, progressPercent))}%` }}
                />
              </div>
              <div className="update-progress-meta">
                <span>
                  {formatUpdateBytes(props.progress.receivedBytes)} / {formatUpdateBytes(props.progress.totalBytes)}
                </span>
                <span>
                  {props.progress.bytesPerSecond
                    ? `${formatUpdateBytes(props.progress.bytesPerSecond)}/s`
                    : ""}
                </span>
              </div>
              {props.downloadedPath && (
                <div className="update-downloaded-path">{props.downloadedPath}</div>
              )}
            </div>
          )}
          <div className="update-notes markdown-body">
            {/* GitHub Release notes 通常是 Markdown;这里复用聊天渲染链路支持标题、列表、链接和代码块。 */}
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {props.info.releaseNotes.trim() || t("update.noReleaseNotes")}
            </ReactMarkdown>
          </div>
        </div>
        <div className="update-actions">
          <button onClick={props.onOpenRelease}>
            {t("update.openRelease")}
          </button>
          <button onClick={props.onBrowserDownload}>
            {t("update.browserDownload")}
          </button>
          {props.downloadedPath ? (
            <button className="primary" onClick={props.onInstall}>
              {t("update.installDownloaded")}
            </button>
          ) : (
            <button
              className="primary"
              disabled={props.checking || props.downloading || !props.info.recommendedAsset}
              onClick={props.onDownload}
            >
              {props.downloading ? t("update.downloading") : t("update.downloadInApp")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function UpdateErrorModal(props: {
  message: string;
  releasesUrl: string;
  onClose: () => void;
  onOpenRelease: () => void;
}) {
  return (
    <div className="modal-backdrop update-backdrop">
      <section className="update-modal update-error-modal">
        <div className="modal-header">
          <strong>{t("update.checkFailedTitle")}</strong>
          <CloseIconButton label={t("common.close")} onClick={props.onClose} />
        </div>
        <div className="update-body">
          <p className="update-version-line">
            {t("update.checkFailedDescription")}
          </p>
          <div className="update-error-detail">
            {t("update.errorInfo", { message: props.message })}
          </div>
          <p className="update-asset-line">
            {t("update.manualReleaseHint")}
            <br />
            <span>{props.releasesUrl}</span>
          </p>
        </div>
        <div className="update-actions">
          <button onClick={props.onClose}>{t("common.close")}</button>
          <button className="primary" onClick={props.onOpenRelease}>
            {t("update.openReleasePage")}
          </button>
        </div>
      </section>
    </div>
  );
}

function UpToDateModal(props: {
  version: string;
  releasesUrl: string;
  onClose: () => void;
  onOpenRelease: () => void;
}) {
  return (
    <div className="modal-backdrop update-backdrop">
      <section className="update-modal update-uptodate-modal">
        <div className="modal-header">
          <strong>{t("update.upToDateTitle")}</strong>
          <CloseIconButton label={t("common.close")} onClick={props.onClose} />
        </div>
        <div className="update-body">
          <p className="update-version-line">
            {t("update.upToDateMessage", { version: props.version })}
          </p>
        </div>
        <div className="update-actions">
          <button onClick={props.onClose}>{t("common.close")}</button>
          <button onClick={props.onOpenRelease}>
            {t("update.openReleasePage")}
          </button>
        </div>
      </section>
    </div>
  );
}
