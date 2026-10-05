import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pencil,
  Pin,
  PinOff,
  Eye,
  Folder,
  FolderOpen,
  GitFork,
  Copy,
  AppWindow,
  ArrowUpRight,
  Archive,
  Trash2,
  Clock,
  Settings as SettingsIcon,
  X,
  ClipboardPaste,
  TextSelect,
  SquareCode,
} from 'lucide-react';
import TitleBar, { type MenuAction } from './components/TitleBar';
import Sidebar, { Rail, type ViewId } from './components/Sidebar';
import ChatView, { EmptyState } from './components/ChatView';
import Composer, { type ComposerSettings } from './components/Composer';
import RightPanel, { type TabKind } from './components/RightPanel';
import Settings, { type ThemePref } from './components/Settings';
import McpPage from './components/pages/McpPage';
import SkillsPage from './components/pages/SkillsPage';
import ProvidersPage from './components/pages/ProvidersPage';
import ManagementPage from './components/pages/ManagementPage';
import { ContextMenu, type CtxItem } from './components/ContextMenu';
import { startDrag } from './components/Resizer';
import { ProjectDialog, ConfirmDialog, ScheduleDialog } from './components/Dialogs';
import {
  deletePiSession,
  ensurePiSession,
  isDesktopRuntime,
  listenPiRpc,
  readPiConfig,
  readPiSession,
  requestPiRpc,
  scanPiSessions,
  sendPiRpc,
  stopPiRpc,
  stopPiSession,
  writePiConfig,
} from './lib/piRpc';
import { projectPiEntries, titleFromIndexEntry, type PiEntry } from './lib/piSession';
import { applyPiEvent, createTurnState, displayContent, type PiTurnState } from './lib/piEventReducer';
import { isExtensionUiRequest, isDialogMethod, type ExtensionUiRequest } from './lib/piRpc';
import { isSecurityConfirm, parseTodoWidgetLines, todoItemsFromSessionEntries, TODO_WIDGET_KEY, type TodoWidgetItem } from './lib/extensionUi';
import { DialogRequestCard, SecurityConfirmCard } from './components/ApprovalCards';
import { TodoStrip } from './components/TodoStrip';
import { fileTarget, workspace, type PanelTarget, type Review } from './lib/workspace';
import { shellApi, adminErrorMessage } from './lib/piAdmin';
import {
  BUILTIN_COMMANDS,
  buildCommandMap,
  fetchPiCommands,
  parseSlashCommand,
  type SlashCommand,
} from './lib/slashCommands';
import type { UsageSnapshot } from './components/ContextUsage';
import {
  efforts,
  buildModelOptions,
  pickReply,
  uid,
  type Thread,
  type Project,
  type Provider,
  type Message,
  type Attachment,
  type ComposerDraft,
  type PendingSend,
} from './data';
import { attachmentFromPath, attachmentPromptBlock, ensureAttachmentPaths, forPersistence } from './lib/attachments';

interface NavState {
  view: ViewId;
  threadId: string | null;
}

type Dialog =
  | null
  | { kind: 'project'; editId?: string }
  | { kind: 'confirm'; title: string; desc: string; label: string; onConfirm: () => void }
  | { kind: 'schedule'; threadId: string };

const SIDEBAR_MIN = 190; // 小于此宽度直接隐藏
const SIDEBAR_MAX = 420;
const RIGHT_MIN = 300;
const CHAT_MIN = 380; // 普通模式下聊天区最小宽度
const COVER_AT = 260; // 聊天区被压缩到小于该宽度时，右侧面板切换为「覆盖」模式

const toMarkdown = (t: Thread) =>
  `# ${t.title}\n\n` + t.messages.map((m) => `**${m.role === 'user' ? '用户' : '助手'}**\n\n${m.content}`).join('\n\n---\n\n');

/* ---------- 持久化：threads / projects 落在 localStorage ---------- */
const STORE_KEY = 'wepi-store-v1';

interface PersistedStore {
  projects: Project[];
  threads: Thread[];
  expanded: string[];
  /** 已移除的工作区（归一化路径）：阻止会话索引把它们重新导回来 */
  hiddenWorkspaces: string[];
}

/** 工作区路径归一化，用于跨平台比较 */
const normalizeWorkspace = (value: string) => value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();

function loadStore(): PersistedStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { projects: [], threads: [], expanded: [], hiddenWorkspaces: [] };
    const parsed = JSON.parse(raw) as Partial<PersistedStore>;
    // 恢复时清掉运行时标志（streaming/thinking 属于上次进程的瞬态）。
    const revive = (m: Message): Message => ({ ...m, streaming: false, thinking: false });
    const threads = (parsed.threads ?? []).map((t) => ({
      ...t,
      messages: (t.messages ?? []).map((m) => (m.role === 'assistant' ? revive(m) : m)),
    }));
    return {
      projects: parsed.projects ?? [],
      threads,
      expanded: parsed.expanded ?? [],
      hiddenWorkspaces: parsed.hiddenWorkspaces ?? [],
    };
  } catch {
    return { projects: [], threads: [], expanded: [], hiddenWorkspaces: [] };
  }
}

/* ---------- 草稿：输入框内容按会话保存，切换页面/会话/重启都不丢 ---------- */
const DRAFT_KEY = 'wepi-composer-drafts';
const EMPTY_DRAFT: ComposerDraft = { text: '', attachments: [] };

function loadDrafts(): Record<string, ComposerDraft> {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') as Record<string, ComposerDraft>;
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, {
      text: typeof value?.text === 'string' ? value.text : '',
      attachments: Array.isArray(value?.attachments) ? value.attachments : [],
    }]));
  } catch {
    return {};
  }
}

function usePersistedStore() {
  const [store, setStore] = useState<PersistedStore>(loadStore);
  const saveTimer = useRef<number>(0);
  const mutate = useCallback((updater: (prev: PersistedStore) => PersistedStore) => {
    setStore((s) => updater(s));
  }, []);
  const setProjects = useCallback((updater: Project[] | ((prev: Project[]) => Project[])) => {
    mutate((s) => ({ ...s, projects: typeof updater === 'function' ? updater(s.projects) : updater }));
  }, [mutate]);
  const setThreads = useCallback((updater: Thread[] | ((prev: Thread[]) => Thread[])) => {
    mutate((s) => ({ ...s, threads: typeof updater === 'function' ? updater(s.threads) : updater }));
  }, [mutate]);
  const setExpanded = useCallback((updater: string[] | ((prev: string[]) => string[])) => {
    mutate((s) => ({ ...s, expanded: typeof updater === 'function' ? updater(s.expanded) : updater }));
  }, [mutate]);
  // 防抖持久化：会话内容高频更新（流式 delta）时不逐次写盘。
  // 图片附件的 data URL 在落盘前剥离（配额极有限，失败还是静默的），保留 path 以便重新读取。
  const persist = useCallback((next: PersistedStore) => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        const lean: PersistedStore = {
          ...next,
          threads: next.threads.map((thread) => (
            thread.messages.some((m) => m.attachments?.length)
              ? { ...thread, messages: thread.messages.map((m) => (m.attachments?.length ? { ...m, attachments: forPersistence(m.attachments) } : m)) }
              : thread
          )),
        };
        localStorage.setItem(STORE_KEY, JSON.stringify(lean));
      } catch { /* 配额超限时静默失败 */ }
    }, 400);
  }, []);
  useEffect(() => { persist(store); }, [store, persist]);
  return { store, mutate, setProjects, setThreads, setExpanded };
}

export default function App() {
  const [themePref, setThemePref] = useState<ThemePref>(() => (localStorage.getItem('theme') as ThemePref) || 'dark');
  const [sysDark, setSysDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const { store, mutate, setProjects, setThreads, setExpanded } = usePersistedStore();
  const projects = store.projects;
  const threads = store.threads;
  const expanded = store.expanded;
  const [providers, setProviders] = useState<Provider[]>([]);
  const [nav, setNav] = useState<NavState>({ view: 'home', threadId: null });
  const [back, setBack] = useState<NavState[]>([]);
  const [fwd, setFwd] = useState<NavState[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; from: 'sidebar' | 'header' } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarW, setSidebarW] = useState(248);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightW, setRightW] = useState(366);
  const [rightCover, setRightCover] = useState(false);
  const [openKind, setOpenKind] = useState<{ kind: TabKind; n: number; reviewId?: string } | null>(null);
  const [panelTarget, setPanelTarget] = useState<PanelTarget | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerSettings>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('composer-settings') ?? 'null') as Partial<ComposerSettings> | null;
      return {
        model: saved?.model && saved.model !== 'openai:gpt-5' ? saved.model : '',
        effort: saved?.effort && efforts.includes(saved.effort) ? saved.effort : 'high',
        access: saved?.access ?? 'full',
      };
    } catch {
      return { model: '', effort: 'high', access: 'full' };
    }
  });
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>(loadDrafts);
  /** 原生拖拽悬停中：桌面端窗口级拖拽不产生 DOM 事件，需要自己的落区提示 */
  const [dropActive, setDropActive] = useState(false);
  const [piModels, setPiModels] = useState<{ id: string; name: string; provider: string }[]>([]);
  const [piEfforts, setPiEfforts] = useState<readonly (typeof efforts)[number][]>(efforts);
  const [usage, setUsage] = useState<UsageSnapshot>({ contextPercent: 0, contextTokens: 0, contextWindow: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCost: 0 });
  const [piConfigReady, setPiConfigReady] = useState(false);
  /** 系统打开能力（VS Code 是否可用等）；桌面启动时探测一次 */
  const [shellCapabilities, setShellCapabilities] = useState({ vscode: false });
  /** 斜杠命令目录：内置 + 当前会话 RPC 进程上报（get_commands） */
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(BUILTIN_COMMANDS);
  const slashCommandsLoaded = useRef(false);

  const timers = useRef<Record<string, number[]>>({});
  const toastTimer = useRef<number>(0);
  const mainRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const navRef = useRef(nav);
  navRef.current = nav;
  const lastHome = useRef<string | null>(null);
  /** 正在进行的回合：按 RPC 会话键索引，支持多会话并行运行 */
  const piRuns = useRef(new Map<string, { threadId: string; messageId: string; rpcKey: string; turnId: string; cwd?: string | null; state: PiTurnState }>());
  const piModelsConfig = useRef<Record<string, Record<string, unknown>>>({});
  /** 会话打开请求的代际号，防止旧请求覆盖新导航 */
  const openGeneration = useRef(0);
  /**
   * 任务进行中排队待发消息（按会话键分组）：默认等当前回合结束自动发送。
   * 事件回调用 ref 读最新值，避免闭包过期。
   */
  const [pendingSends, setPendingSends] = useState<Record<string, PendingSend[]>>({});
  const pendingRef = useRef(pendingSends);
  pendingRef.current = pendingSends;

  /* ---------- Extension UI：待响应对话请求 + todo widget（按会话键） ---------- */
  /** 每个会话至多一张待响应卡：扩展的 dialog 方法在 pi 侧阻塞等待。 */
  const [uiRequests, setUiRequests] = useState<Record<string, ExtensionUiRequest>>({});
  const [todoBySession, setTodoBySession] = useState<Record<string, TodoWidgetItem[]>>({});
  /** 历史会话（无活 runtime）的 todo 兜底：按 threadId 索引。 */
  const [todoByThread, setTodoByThread] = useState<Record<string, TodoWidgetItem[]>>({});

  /** 按 id 精确移除待响应卡：只清这张请求，不影响后来顶替登记的新请求。 */
  const clearUiRequest = useCallback((sessionKey: string, requestId: string) => {
    setUiRequests((current) => {
      const existing = current[sessionKey];
      if (!existing || existing.id !== requestId) return current;
      const next = { ...current };
      delete next[sessionKey];
      return next;
    });
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const h = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  useEffect(() => localStorage.setItem('theme', themePref), [themePref]);
  useEffect(() => localStorage.setItem('composer-settings', JSON.stringify(composer)), [composer]);
  // 探测系统打开能力：VS Code 未安装时禁用对应菜单项而不是点击报错。
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    shellApi.capabilities()
      .then((caps) => setShellCapabilities({ vscode: !!caps.vscodeAvailable }))
      .catch(() => setShellCapabilities({ vscode: false }));
  }, []);
  useEffect(() => {
    if (!isDesktopRuntime()) { setPiConfigReady(true); return; }
    void readPiConfig().then((snapshot) => {
      if (!snapshot) return;
      const entries = Object.entries(snapshot.models.providers ?? {});
      piModelsConfig.current = Object.fromEntries(entries.map(([id, value]) => [id, value as unknown as Record<string, unknown>]));
      const nextProviders: Provider[] = entries.map(([id, value]) => {
        const name = id;
        const lower = id.toLowerCase();
        const kind: Provider['kind'] = lower.includes('anthropic') ? 'anthropic' : lower.includes('google') || lower.includes('gemini') ? 'google' : lower.includes('deepseek') ? 'deepseek' : lower.includes('ollama') ? 'ollama' : lower.includes('openai') ? 'openai' : 'custom';
        return { id, name, kind, baseUrl: value.baseUrl ?? '', api: value.api, headers: value.headers, compat: value.compat, apiKey: value.apiKey ?? snapshot.auth[id]?.key ?? '', enabled: true, models: (value.models ?? []).map((model) => model.id), modelDetails: Object.fromEntries((value.models ?? []).map((model) => [model.id, model])) };
      });
      setProviders(nextProviders);
      const settingsModel = typeof snapshot.settings.defaultProvider === 'string' && typeof snapshot.settings.defaultModel === 'string' ? `${snapshot.settings.defaultProvider}:${snapshot.settings.defaultModel}` : '';
      setComposer((current) => ({ ...current, model: settingsModel || current.model, effort: typeof snapshot.settings.defaultThinkingLevel === 'string' && (efforts as readonly string[]).includes(snapshot.settings.defaultThinkingLevel) ? snapshot.settings.defaultThinkingLevel as typeof efforts[number] : current.effort }));
      setPiConfigReady(true);
    }).catch((error: unknown) => {
      setToast(error instanceof Error ? `读取 Pi 配置失败：${error.message}` : '读取 Pi 配置失败');
      // 配置读取失败时禁止写回空 providers，避免覆盖 Pi 原有的 models.json。
      setPiConfigReady(false);
    });
  }, []);

  /* ---------- Pi 会话索引合并：会话按 cwd 归入对应工作区项目 ---------- */
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    const normalizePath = normalizeWorkspace;
    const baseName = (value: string) => value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value;
    const merge = () => {
      void scanPiSessions().then((sessions) => {
        if (cancelled || sessions.length === 0) return;
        mutate((prev) => {
          const projects = [...prev.projects];
          const byPath = new Map(projects.map((p) => [normalizePath(p.path), p]));
          const hidden = new Set(prev.hiddenWorkspaces);
          const threads = [...prev.threads];
          let changed = false;
          for (const entry of sessions) {
            // Pi 会话天然绑定工作区（cwd）——为其建立/复用对应项目，
            // 使侧边栏呈现「项目 › 会话」的结构，而不是全部堆在「最近」。
            // cwd 只取会话文件首行的权威值；目录名解码是有损的，不作为来源。
            const cwd = entry.cwd ?? null;
            // 已被用户移除的工作区不再导入，否则「移除」会被下一轮扫描撤销。
            if (cwd && hidden.has(normalizePath(cwd))) continue;
            let projectId: string | null = null;
            if (cwd) {
              const key = normalizePath(cwd);
              let project = byPath.get(key);
              if (!project) {
                project = { id: `workspace:${key}`, name: baseName(cwd), path: cwd, branch: '' };
                projects.push(project);
                byPath.set(key, project);
                changed = true;
              }
              projectId = project.id;
            }
            const index = threads.findIndex((t) => t.piSessionPath === entry.sessionPath);
            if (index === -1) {
              threads.push({
                id: `pisession:${entry.sessionId ?? entry.sessionPath}`,
                title: titleFromIndexEntry(entry),
                projectId,
                messages: [],
                piSessionPath: entry.sessionPath,
                piCwd: cwd,
                piFileSize: entry.fileSize,
              });
              changed = true;
              continue;
            }
            const existing = threads[index];
            const busy = existing.messages.some((m) => m.streaming || m.thinking);
            if (existing.projectId !== projectId) {
              threads[index] = { ...existing, projectId, piCwd: cwd };
              changed = true;
            } else if (!busy && existing.piFileSize !== undefined && existing.piFileSize !== entry.fileSize) {
              threads[index] = { ...existing, unread: true };
              changed = true;
            }
          }
          return changed ? { ...prev, projects, threads } : prev;
        });
      }).catch(() => { /* sessions 目录不可用时静默 */ });
    };
    merge();
    const interval = window.setInterval(merge, 15_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [mutate]);
  useEffect(() => {
    if (!isDesktopRuntime() || !piConfigReady) return;
    const models = {
      providers: Object.fromEntries(providers.map((provider) => {
        const previous = piModelsConfig.current[provider.id] ?? {};
        const previousModels = Array.isArray(previous.models) ? previous.models as Record<string, unknown>[] : [];
        const modelById = new Map(previousModels.map((model) => [String(model.id), model]));
        return [provider.id, { ...previous, baseUrl: provider.baseUrl, api: provider.api ?? previous.api ?? (provider.kind === 'anthropic' ? 'anthropic-messages' : 'openai-responses'), headers: provider.headers, compat: provider.compat, ...(provider.apiKey ? { apiKey: provider.apiKey } : {}), models: provider.models.map((id) => ({ ...(modelById.get(id) ?? {}), ...(provider.modelDetails?.[id] ?? {}), id, name: provider.modelDetails?.[id]?.name ?? modelById.get(id)?.name ?? id })) }];
      })),
    };
    piModelsConfig.current = models.providers as Record<string, Record<string, unknown>>;
    void writePiConfig('models.json', models).catch(() => {});
  }, [providers, piConfigReady]);
  useEffect(() => {
    if (!piConfigReady) return;
    setPiModels(providers.flatMap((provider) => provider.models.map((id) => ({ id, name: id, provider: provider.id }))));
  }, [providers, piConfigReady]);
  useEffect(() => {
    if (!rightOpen) {
      setOpenKind(null);
      setRightCover(false);
    }
  }, [rightOpen]);
  useEffect(() => {
    if (nav.view === 'home') lastHome.current = nav.threadId;
  }, [nav]);
  const theme = themePref === 'system' ? (sysDark ? 'dark' : 'light') : themePref;

  const showToast = useCallback((s: string) => {
    setToast(s);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1900);
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  /* ---------- 全局右键菜单：默认只有「全选」；输入框额外有「粘贴」 ---------- */
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (e.defaultPrevented) return; // 侧边栏等已自行处理
      e.preventDefault();
      const target = e.target as HTMLElement;
      const field = target.closest('textarea, input') as HTMLInputElement | HTMLTextAreaElement | null;
      const textual =
        !!field &&
        !field.readOnly &&
        !field.disabled &&
        (field.tagName === 'TEXTAREA' || ['text', 'search', 'password', 'url', 'email', 'tel', 'number', ''].includes(field.type));
      const items: CtxItem[] = [];
      if (textual && field) {
        items.push({
          label: '粘贴',
          icon: <ClipboardPaste size={15} />,
          shortcut: 'Ctrl+V',
          onClick: async () => {
            field.focus();
            try {
              const text = await navigator.clipboard.readText();
              document.execCommand('insertText', false, text);
            } catch {
              showToast('无法读取剪贴板，请使用 Ctrl+V 粘贴');
            }
          },
        });
      }
      items.push({
        label: '全选',
        icon: <TextSelect size={15} />,
        shortcut: 'Ctrl+A',
        onClick: () => {
          if (field) {
            field.focus();
            field.select();
          } else document.execCommand('selectAll');
        },
      });
      setMenu({ x: e.clientX, y: e.clientY, items });
    };
    window.addEventListener('contextmenu', h);
    return () => window.removeEventListener('contextmenu', h);
  }, [showToast]);

  /* ---------- 导航 ---------- */
  const go = (n: NavState) => {
    if (n.view === nav.view && n.threadId === nav.threadId) return;
    setBack((b) => [...b, nav]);
    setFwd([]);
    setNav(n);
  };
  const goBack = () => {
    if (!back.length) return;
    setFwd((f) => [nav, ...f]);
    setNav(back[back.length - 1]);
    setBack((b) => b.slice(0, -1));
  };
  const goForward = () => {
    if (!fwd.length) return;
    setBack((b) => [...b, nav]);
    setNav(fwd[0]);
    setFwd((f) => f.slice(1));
  };

  const activeThread =
    nav.view === 'home' && nav.threadId ? threads.find((t) => t.id === nav.threadId && !t.archived) ?? null : null;
  const project = projects.find((p) => p.id === (activeThread ? activeThread.projectId : selectedProject)) ?? null;
  const busy = !!activeThread?.messages.some((m) => m.streaming || m.thinking);
  const modelOptions = piModels.length ? piModels.map((model) => ({ id: `${model.provider}:${model.id}`, name: model.name || model.id, provider: model.provider })) : buildModelOptions(providers);

  /* ---------- 输入框草稿：按会话保存，导航离开再回来内容仍在 ---------- */
  const draftKey = activeThread?.id ?? 'new';
  const draft = drafts[draftKey] ?? EMPTY_DRAFT;
  const setDraft = useCallback((updater: ComposerDraft | ((prev: ComposerDraft) => ComposerDraft)) => {
    setDrafts((all) => {
      const current = all[draftKey] ?? EMPTY_DRAFT;
      const next = typeof updater === 'function' ? updater(current) : updater;
      return { ...all, [draftKey]: next };
    });
  }, [draftKey]);
  /** 事件订阅只注册一次，用 ref 读取「当前草稿键」避免闭包过期。 */
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const viewRef = useRef(nav.view);
  viewRef.current = nav.view;

  const appendToDraft = useCallback((list: Attachment[]) => {
    if (!list.length) return;
    const key = draftKeyRef.current;
    setDrafts((all) => {
      const current = all[key] ?? EMPTY_DRAFT;
      return { ...all, [key]: { ...current, attachments: [...current.attachments, ...list] } };
    });
  }, []);

  const clearDraft = useCallback((key: string) => {
    setDrafts((all) => {
      if (!(key in all)) return all;
      const next = { ...all };
      delete next[key];
      return next;
    });
  }, []);

  // 草稿落盘：图片 data URL 先剥离（配额有限），纯空草稿不写。
  useEffect(() => {
    const lean = Object.fromEntries(
      Object.entries(drafts)
        .filter(([, value]) => value.text.trim() || value.attachments.length)
        .map(([key, value]) => [key, { ...value, attachments: forPersistence(value.attachments) }]),
    );
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(lean));
    } catch { /* 配额超限时静默失败 */ }
  }, [drafts]);

  /**
   * 桌面端原生拖拽：WebView2 的 dragDropEnabled 默认开启，文件拖入不会产生 DOM 事件，
   * 只有窗口级 onDragDropEvent 能拿到真实绝对路径（浏览器端由 Composer 的 DOM 事件兜底）。
   */
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const off = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === 'enter' || payload.type === 'over') {
            if (viewRef.current === 'home') setDropActive(true);
            return;
          }
          if (payload.type === 'leave') {
            setDropActive(false);
            return;
          }
          if (payload.type !== 'drop') return;
          setDropActive(false);
          if (viewRef.current !== 'home') return;
          const paths = payload.paths ?? [];
          if (!paths.length) return;
          void Promise.all(paths.map(attachmentFromPath)).then(appendToDraft);
        });
        if (disposed) off();
        else unlisten = off;
      } catch { /* 旧运行时没有该 API：静默降级为不做原生拖拽 */ }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appendToDraft]);

  const navigate = (v: ViewId) => go({ view: v, threadId: v === 'home' ? lastHome.current : null });
  const newChat = () => go({ view: 'home', threadId: null });
  const newChatIn = (pid: string | null) => {
    setSelectedProject(pid);
    go({ view: 'home', threadId: null });
  };
  const openSettings = () => go({ view: 'settings', threadId: null });
  const openPanel = (kind: TabKind, reviewId?: string) => {
    setRightOpen(true);
    setPanelTarget(null);
    setOpenKind({ kind, n: Date.now(), reviewId });
  };
  const openChatLink = (href: string) => {
    const target = fileTarget(href);
    if (target) { setPanelTarget({ ...target, n: Date.now() }); setRightOpen(true); return; }
    window.open(href, '_blank', 'noopener,noreferrer');
  };
  const expand = (pid: string | null) => {
    if (pid) setExpanded((e) => (e.includes(pid) ? e : [...e, pid]));
  };

  /* ---------- 会话 / 项目操作 ---------- */
  const patchThread = (id: string, p: Partial<Thread>) => setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));

  /**
   * 打开会话：Pi 历史会话走**直接读 JSONL**（不启动任何进程）。
   * 之前为读历史而 `pi --mode rpc --session` 拉起 Node 进程，是点一下
   * 会话就卡顿数秒的根因；只有真正发消息时才会启动进程。
   */
  const openThread = (id: string) => {
    patchThread(id, { unread: false });
    go({ view: 'home', threadId: id });
    const thread = threads.find((t) => t.id === id);
    if (!isDesktopRuntime() || !thread?.piSessionPath) return;
    const busy = thread.messages.some((m) => m.streaming || m.thinking);
    if (busy) return;
    const generation = ++openGeneration.current;
    void readPiSession(thread.piSessionPath).then((entries) => {
      if (openGeneration.current !== generation) return;
      const messages = projectPiEntries(entries as unknown as PiEntry[]);
      // 历史会话的 todo 兜底：无活 runtime 时从 custom 快照条目重建。
      const todos = todoItemsFromSessionEntries(entries);
      if (todos.length) setTodoByThread((current) => ({ ...current, [id]: todos }));
      else setTodoByThread((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setThreads((ts) => ts.map((t) => (t.id === id && !t.messages.some((m) => m.streaming || m.thinking)
        ? { ...t, messages, piFileSize: undefined }
        : t)));
    }).catch((error: unknown) => {
      if (openGeneration.current !== generation) return;
      const message = error instanceof Error ? error.message : String(error);
      setThreads((ts) => ts.map((t) => (t.id === id && t.messages.length === 0 ? {
        ...t,
        messages: [{ id: uid(), role: 'assistant', content: `读取 Pi 会话文件失败：${message}\n\n${thread.piSessionPath}` }],
      } : t)));
    });
  };

  const copyText = (text: string, msg: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    showToast(msg);
  };

  const startRename = (id: string, from: 'sidebar' | 'header') => {
    if (from === 'sidebar') setSidebarOpen(true);
    setRenaming({ id, from });
  };

  const archiveThread = (id: string) => {
    patchThread(id, { archived: true });
    if (nav.threadId === id) newChat();
    showToast('已归档聊天（可在 设置 › 已归档任务 中恢复）');
  };

  const deleteThread = (id: string) => {
    const thread = threads.find((t) => t.id === id);
    setThreads((ts) => ts.filter((t) => t.id !== id));
    // 会话没了：排队消息一并丢弃（否则冲刷会对着不存在的 thread 开回合）。
    if ((pendingRef.current[id] ?? []).length) {
      pendingRef.current = { ...pendingRef.current, [id]: [] };
      setPendingSends((all) => ({ ...all, [id]: [] }));
    }
    if (nav.threadId === id) setNav({ view: 'home', threadId: null });
    if (!isDesktopRuntime() || !thread?.piSessionPath) {
      showToast('已永久删除聊天');
      return;
    }
    const sessionPath = thread.piSessionPath;
    const rpcKey = thread.rpcKey;
    void (async () => {
      // 必须先停掉仍在写这个会话文件的 Pi 进程，否则它会立刻把文件重新落盘。
      if (rpcKey) await stopPiSession(rpcKey);
      await deletePiSession(sessionPath);
      showToast('已删除对话及其 Pi 会话文件');
    })().catch((error: unknown) => {
      showToast(`删除 Pi 会话文件失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const confirmDelete = (t: Thread) =>
    setDialog({
      kind: 'confirm',
      title: '永久删除聊天？',
      desc: t.piSessionPath
        ? `「${t.title}」将被永久删除，同时会删除磁盘上的 Pi 会话文件（${t.piSessionPath}）。此操作无法撤销，如只想隐藏它，可以选择「归档」。`
        : `「${t.title}」将被永久删除，此操作无法撤销。如只想隐藏它，可以选择「归档」。`,
      label: '永久删除',
      onConfirm: () => deleteThread(t.id),
    });

  const moveThread = (id: string, pid: string | null) => {
    patchThread(id, { projectId: pid });
    expand(pid);
    showToast(pid ? `已移动到项目 ${projects.find((p) => p.id === pid)?.name}` : '已移出项目');
  };

  const forkThread = (id: string, kind = '本地') => {
    const src = threads.find((t) => t.id === id);
    if (!src) return;
    const nt: Thread = {
      ...src,
      id: uid(),
      title: `${src.title}（分叉）`,
      pinned: false,
      unread: false,
      messages: src.messages
        .filter((m) => !m.thinking)
        .map((m) => ({ ...m, id: uid(), streaming: false })),
    };
    setThreads((ts) => [nt, ...ts]);
    expand(nt.projectId);
    go({ view: 'home', threadId: nt.id });
    showToast(`已分叉到${kind}`);
  };

  const createProject = (name: string, path: string) => {
    const p: Project = { id: uid(), name, path, branch: 'main' };
    setProjects((ps) => [p, ...ps]);
    setSelectedProject(p.id);
    setExpanded((e) => [...e, p.id]);
    go({ view: 'home', threadId: null });
    showToast(`已创建项目 ${name}`);
  };

  /**
   * 移除项目 = 隐藏该工作区。
   * Pi 会话是磁盘上的独立文件，只要文件还在，会话索引下一轮就会把它重新
   * 导进来、并把项目重新建出来。因此这里记录一条隐藏规则（持久化），
   * 而不是仅仅从内存里删掉——这才是用户期望的「移除」。
   */
  const removeProject = (p: Project) => {
    const key = normalizeWorkspace(p.path);
    mutate((prev) => ({
      ...prev,
      projects: prev.projects.filter((x) => x.id !== p.id),
      threads: prev.threads.filter((t) => t.projectId !== p.id),
      hiddenWorkspaces: prev.hiddenWorkspaces.includes(key) ? prev.hiddenWorkspaces : [...prev.hiddenWorkspaces, key],
    }));
    if (selectedProject === p.id) setSelectedProject(null);
    showToast(`已移除项目 ${p.name}（Pi 会话文件保留在磁盘）`);
  };

  /** 取消隐藏：会话索引下一轮扫描会重新导入该工作区及其会话。 */
  const restoreWorkspace = (path: string) => {
    const key = normalizeWorkspace(path);
    mutate((prev) => ({ ...prev, hiddenWorkspaces: prev.hiddenWorkspaces.filter((x) => x !== key) }));
    showToast('已恢复工作区，稍后会自动重新载入其会话');
  };

  /** 「打开方式」子菜单：VS Code / 资源管理器，走系统命令真实打开。 */
  const openWithItems = (path?: string): CtxItem[] => {
    const items: CtxItem[] = [
      {
        label: 'VS Code',
        icon: <SquareCode size={14} />,
        disabled: !path || !shellCapabilities.vscode,
        onClick: () => {
          if (!path) return;
          shellApi.openInVscode(path).catch((error) => showToast(adminErrorMessage(error, '无法用 VS Code 打开')));
        },
      },
      {
        label: '文件资源管理器',
        icon: <FolderOpen size={14} />,
        disabled: !path,
        onClick: () => {
          if (!path) return;
          shellApi.showInExplorer(path).catch((error) => showToast(adminErrorMessage(error, '无法打开资源管理器')));
        },
      },
    ];
    return items;
  };

  const threadMenu = (t: Thread, kind: 'sidebar' | 'header'): CtxItem[] => {
    const proj = projects.find((p) => p.id === t.projectId);
    const copyItems: CtxItem[] = [
      { label: '复制会话 ID', onClick: () => copyText(t.id, '已复制会话 ID') },
      { label: '复制工作目录', disabled: !proj, onClick: () => copyText(proj!.path, '已复制工作目录') },
      { label: '复制为 Markdown', onClick: () => copyText(toMarkdown(t), '已复制为 Markdown') },
      { label: '复制深层链接', onClick: () => copyText(`wepi://threads/${t.id}`, '已复制深层链接') },
    ];
    const rename: CtxItem = { label: '重命名', icon: <Pencil size={15} />, shortcut: 'Alt+Ctrl+R', onClick: () => startRename(t.id, kind) };
    const pin: CtxItem = {
      label: t.pinned ? '取消置顶' : '置顶',
      icon: t.pinned ? <PinOff size={15} /> : <Pin size={15} />,
      shortcut: 'Alt+Ctrl+P',
      onClick: () => patchThread(t.id, { pinned: !t.pinned }),
    };
    const fork: CtxItem = {
      label: '分叉',
      icon: <GitFork size={15} />,
      submenu: [
        { label: '分叉到本地', onClick: () => forkThread(t.id, '本地') },
        { label: '分叉到新工作树', onClick: () => forkThread(t.id, '新工作树') },
      ],
    };
    const copy: CtxItem = { label: '复制', icon: <Copy size={15} />, submenu: copyItems };
    const win: CtxItem = { label: '在新窗口中打开', icon: <AppWindow size={15} />, onClick: () => showToast('已在新窗口中打开（演示）') };
    const openWith: CtxItem = { label: '打开方式', icon: <ArrowUpRight size={15} />, submenu: openWithItems(proj?.path) };
    const archive: CtxItem = { label: '归档', icon: <Archive size={15} />, shortcut: 'Ctrl+Shift+A', onClick: () => archiveThread(t.id) };
    const div: CtxItem = { divider: true };

    if (kind === 'header')
      return [
        rename,
        pin,
        div,
        fork,
        { label: '添加计划任务…', icon: <Clock size={15} />, onClick: () => setDialog({ kind: 'schedule', threadId: t.id }) },
        div,
        copy,
        div,
        win,
        openWith,
        div,
        archive,
      ];

    return [
      rename,
      pin,
      {
        label: '标记为未读',
        icon: <Eye size={15} />,
        shortcut: 'Ctrl+Shift+U',
        onClick: () => patchThread(t.id, { unread: true }),
      },
      {
        label: '项目',
        icon: <Folder size={15} />,
        submenu: [
          ...projects.map((p) => ({
            label: p.name,
            icon: <Folder size={14} />,
            checked: t.projectId === p.id,
            onClick: () => moveThread(t.id, p.id),
          })),
          { divider: true },
          { label: '不在项目中', icon: <X size={14} />, checked: !t.projectId, onClick: () => moveThread(t.id, null) },
        ],
      },
      div,
      fork,
      div,
      copy,
      div,
      win,
      openWith,
      div,
      archive,
      { label: '永久删除', icon: <Trash2 size={15} />, onClick: () => confirmDelete(t) },
    ];
  };

  const projectMenu = (p: Project): CtxItem[] => [
    {
      label: p.pinned ? '取消置顶' : '置顶',
      icon: p.pinned ? <PinOff size={15} /> : <Pin size={15} />,
      onClick: () => setProjects((ps) => ps.map((x) => (x.id === p.id ? { ...x, pinned: !x.pinned } : x))),
    },
    { label: '编辑', icon: <SettingsIcon size={15} />, onClick: () => setDialog({ kind: 'project', editId: p.id }) },
    { divider: true },
    { label: '在资源管理器中打开', icon: <FolderOpen size={15} />, onClick: () => showToast(`已在资源管理器中打开 ${p.path}`) },
    { divider: true },
    {
      label: '归档聊天',
      icon: <Archive size={15} />,
      onClick: () => {
        const ids = threads.filter((t) => t.projectId === p.id && !t.archived).map((t) => t.id);
        setThreads((ts) => ts.map((t) => (ids.includes(t.id) ? { ...t, archived: true } : t)));
        if (nav.threadId && ids.includes(nav.threadId)) newChat();
        showToast(ids.length ? `已归档 ${ids.length} 个聊天` : '该项目下没有可归档的聊天');
      },
    },
    { divider: true },
    {
      label: '移除项目',
      icon: <X size={15} />,
      onClick: () =>
        setDialog({
          kind: 'confirm',
          title: `移除项目「${p.name}」？`,
          desc: '只会从 WEPI 中移除该项目，不会删除本地文件夹。项目下的聊天会保留在「最近」中。',
          label: '移除项目',
          onConfirm: () => removeProject(p),
        }),
    },
  ];

  /* ---------- 斜杠命令 ---------- */
  /**
   * 输入框触发 `/` 时拉取 pi 的命令目录（扩展 / 提示词 / 技能）。
   * 每次应用运行只拉一次；命令集在进程生命周期内基本不变，重复拉取
   * 只会增加 RPC 往返。失败允许下次触发重试。
   */
  const loadSlashCommands = useCallback((rpcKey?: string) => {
    if (!isDesktopRuntime() || slashCommandsLoaded.current) return;
    const key = rpcKey && rpcKey !== 'default' ? rpcKey : undefined;
    // 没有 RPC 会话键时不拉（发给不存在进程的请求只会超时）。
    if (!key) return;
    slashCommandsLoaded.current = true;
    void fetchPiCommands(key).then((commands) => {
      if (commands.length) setSlashCommands([...BUILTIN_COMMANDS, ...commands]);
      else slashCommandsLoaded.current = false; // 允许下次重试
    });
  }, []);

  const commandMap = useMemo(() => buildCommandMap(slashCommands), [slashCommands]);

  /* ---------- 对话 ---------- */
  const updateMsg = (tid: string, mid: string, patch: (m: Message) => Partial<Message>) =>
    setThreads((ts) =>
      ts.map((t) => (t.id !== tid ? t : { ...t, messages: t.messages.map((m) => (m.id === mid ? { ...m, ...patch(m) } : m)) })),
    );

  const refreshPiCatalog = async (rpcKey?: string) => {
    try {
      const result = await requestPiRpc<{ models?: { id: string; name?: string; provider: string }[] }>({ type: 'get_available_models' }, 10_000, rpcKey);
      const models = (result.models ?? []).map((model) => ({ id: model.id, name: model.name ?? model.id, provider: model.provider }));
      if (models.length) {
        setPiModels(models);
        setComposer((current) => models.some((model) => `${model.provider}:${model.id}` === current.model) ? current : { ...current, model: `${models[0].provider}:${models[0].id}` });
      }
    } catch { /* Older Pi versions can omit this command; keep the static catalog. */ }
    try {
      const result = await requestPiRpc<{ model?: { id?: string; provider?: string }; thinkingLevel?: string; sessionFile?: string }>({ type: 'get_state' }, 10_000, rpcKey);
      if (result.model?.id && result.model.provider) setComposer((current) => ({ ...current, model: `${result.model!.provider}:${result.model!.id}` }));
      if (result.thinkingLevel && (efforts as readonly string[]).includes(result.thinkingLevel)) setComposer((current) => ({ ...current, effort: result.thinkingLevel as typeof efforts[number] }));
      if (result.sessionFile) {
        setThreads((ts) => ts.map((thread) => thread.rpcKey === rpcKey && !thread.piSessionPath ? { ...thread, piSessionPath: result.sessionFile ?? null } : thread));
      }
    } catch { /* State is optional during Pi startup. */ }
    try {
      const result = await requestPiRpc<{ levels?: string[]; thinkingLevels?: string[] }>({ type: 'get_available_thinking_levels' }, 10_000, rpcKey);
      const levels = result.levels ?? result.thinkingLevels ?? [];
      const supported = levels.filter((level): level is (typeof efforts)[number] => (efforts as readonly string[]).includes(level));
      if (supported.length) {
        setPiEfforts(supported);
        setComposer((current) => supported.includes(current.effort) ? current : { ...current, effort: supported[0] });
      }
    } catch { /* Older Pi versions do not expose thinking levels. */ }
    try {
      const result = await requestPiRpc<{ contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null }; tokens?: { input?: number; output?: number; cacheRead?: number }; cost?: number }>({ type: 'get_session_stats' }, 10_000, rpcKey);
      const context = result.contextUsage ?? {};
      const tokens = result.tokens ?? {};
      setUsage({ contextPercent: context.percent ?? 0, contextTokens: context.tokens ?? 0, contextWindow: context.contextWindow ?? 0, inputTokens: tokens.input ?? 0, outputTokens: tokens.output ?? 0, cacheReadTokens: tokens.cacheRead ?? 0, totalCost: result.cost ?? 0 });
    } catch { /* Stats are optional until the first completed turn. */ }
    // RPC 进程刚就绪——补拉一次斜杠命令目录（新会话首次发送后 / 菜单才有 pi 命令）。
    loadSlashCommands(rpcKey);
  };

  /* ---------- Pi RPC 事件 → 聊天区域渲染状态机 ---------- */
  useEffect(() => {
    let dispose: (() => void) | undefined;
    dispose = listenPiRpc({
      event: (record) => {
        // 按来源会话键路由：允许多个会话同时运行（切走再发消息不会串台）。
        const sessionKey = typeof record.__sessionKey === 'string' ? record.__sessionKey : undefined;
        // Extension UI 子协议：pi 扩展的对话/挂件请求，与回合状态机无关，
        // 必须在 run 判空之前处理（审批可能在回合间隙到达）。
        if (isExtensionUiRequest(record)) {
          const request = record as ExtensionUiRequest;
          const key = request.__sessionKey ?? sessionKey ?? 'default';
          if (request.method === 'setWidget' && request.widgetKey === TODO_WIDGET_KEY) {
            // todo 挂件：fire-and-forget，解析行快照更新会话 todo 状态。
            const items = parseTodoWidgetLines(request.widgetLines);
            setTodoBySession((current) => ({ ...current, [key]: items }));
          } else if (request.method === 'setWidget' && (!request.widgetLines || request.widgetLines.length === 0)) {
            // 清空挂件（widgetLines 为空 = 移除）：todo 条随之隐藏。
            if (request.widgetKey === TODO_WIDGET_KEY) {
              setTodoBySession((current) => {
                const next = { ...current };
                delete next[key];
                return next;
              });
            }
          } else if (isDialogMethod(request)) {
            // 对话方法：登记待响应卡（同会话新请求顶替旧卡；旧的按 cancelled 兜底）。
            setUiRequests((current) => ({ ...current, [key]: request }));
          }
          return;
        }
        const run = sessionKey ? piRuns.current.get(sessionKey) : undefined;
        if (!run) return;
        // 引导消息被 Pi 正式消费（user_message_start）：去掉「已插入」角标，
        // 它已是回合的一部分。按文本前缀匹配——附件提示块会拼在原文之后
        // （pilo 的 acknowledgeQueuedMessage 同款按文本对账）。
        if (record.type === 'user_message_start' && typeof record.text === 'string') {
          const ackText = record.text;
          setThreads((ts) => ts.map((thread) => (thread.id === run.threadId && thread.messages.some((m) => m.steered && ackText.startsWith(m.content))
            ? { ...thread, messages: thread.messages.map((m) => (m.steered && ackText.startsWith(m.content) ? { ...m, steered: undefined } : m)) }
            : thread)));
        }
        // 回合状态由纯函数归约器推进，事件处理不再直接改 ref。
        const next = applyPiEvent(run.state, record, Date.now());
        if (next !== run.state) {
          run.state = next;
          updateMsg(run.threadId, run.messageId, () => ({
            content: displayContent(next),
            blocks: next.blocks,
            streaming: next.streaming,
            ...(next.duration !== undefined ? { duration: next.duration } : {}),
          }));
        }
        if (record.type === 'agent_settled' && next.finished) {
          const turnId = run.turnId;
          const settledThreadId = run.threadId;
          const settledRpcKey = run.rpcKey;
          // 回合结束：残留的「已插入」角标一并清掉——引导消息这时必然
          // 已被 Pi 消费或随回合终止，保留角标只会误导。
          setThreads((ts) => ts.map((thread) => (thread.id === settledThreadId && thread.messages.some((m) => m.steered)
            ? { ...thread, messages: thread.messages.map((m) => (m.steered ? { ...m, steered: undefined } : m)) }
            : thread)));
          void workspace<Review & { id: string }>('turn_end', run.cwd ?? '', { id: turnId }).then((review) => {
            const edits = review.files.map((file) => ({ file: file.file, add: file.add, del: file.del }));
            setThreads((ts) => ts.map((thread) => thread.id === settledThreadId ? { ...thread, lastTurnId: review.id, messages: thread.messages.map((message) => message.id === run.messageId ? { ...message, edits: edits.length ? edits : undefined } : message) } : thread));
          }).catch(() => {});
          if (navRef.current.threadId !== settledThreadId || navRef.current.view !== 'home')
            setThreads((ts) => ts.map((thread) => thread.id === settledThreadId ? { ...thread, unread: true } : thread));
          piRuns.current.delete(settledRpcKey);
          void requestPiRpc<{ sessionFile?: string; contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null }; tokens?: { input?: number; output?: number; cacheRead?: number }; cost?: number }>({ type: 'get_session_stats' }, 10_000, settledRpcKey).then((stats) => {
            const context = stats.contextUsage ?? {};
            const tokens = stats.tokens ?? {};
            setUsage({ contextPercent: context.percent ?? 0, contextTokens: context.tokens ?? 0, contextWindow: context.contextWindow ?? 0, inputTokens: tokens.input ?? 0, outputTokens: tokens.output ?? 0, cacheReadTokens: tokens.cacheRead ?? 0, totalCost: stats.cost ?? 0 });
            if (stats.sessionFile) {
              setThreads((ts) => ts.map((thread) => (thread.id === settledThreadId && !thread.piSessionPath ? { ...thread, piSessionPath: stats.sessionFile } : thread)));
            }
          }).catch(() => {});
          // 回合自然结束：冲刷该会话的排队消息（FIFO，逐条作为新回合发送）。
          flushPending(settledThreadId);
        }
      },
      error: (message) => showToast(message),
      exit: (sessionKey) => {
        const run = sessionKey ? piRuns.current.get(sessionKey) : undefined;
        // 进程退出：待响应卡与 todo 挂件随会话清理（pi 侧阻塞已被进程终止解除）。
        if (sessionKey) {
          setUiRequests((current) => {
            const next = { ...current };
            delete next[sessionKey];
            return next;
          });
        }
        if (!run) return;
        piRuns.current.delete(run.rpcKey);
        updateMsg(run.threadId, run.messageId, (message) => ({
          streaming: false,
          content: message.content || 'Pi RPC 进程已退出，请检查 Pi 配置和错误日志。',
        }));
      },
    });
    return () => { dispose?.(); void stopPiRpc(); };
  }, [showToast]);

  const send = (text: string, attachments: Attachment[] = []) => {
    let tid = activeThread?.id;
    const sourceDraftKey = tid ?? 'new';
    /* 斜杠命令：桌面接管的命令不进会话、不发给模型。
     * 判定依赖命令目录（commandMap）：未加载目录时目录中不存在该名字，
     * 会按普通文本发送——与「未知命令原样发文本」的兜底一致。 */
    const parsed = parseSlashCommand(text, commandMap);
    if (parsed.kind === 'builtin' && parsed.name === 'new') {
      clearDraft(sourceDraftKey);
      newChat();
      return;
    }
    if (parsed.kind === 'builtin' && parsed.name === 'compact') {
      if (busy) { showToast('等待当前回合结束后再压缩'); return; }
      const rpcKey = activeThread?.rpcKey;
      if (!isDesktopRuntime()) { showToast('压缩仅桌面端可用'); return; }
      if (!tid || !rpcKey) { showToast('请先开始一段对话再压缩上下文'); return; }
      const cwd = activeThread?.piCwd ?? project?.path ?? null;
      const sessionPath = activeThread?.piSessionPath ?? null;
      clearDraft(sourceDraftKey);
      void (async () => {
        showToast('正在压缩上下文…');
        try {
          const handshake = await ensurePiSession({ sessionKey: rpcKey, cwd, sessionPath });
          if (handshake?.sessionFile && !activeThread?.piSessionPath) {
            setThreads((ts) => ts.map((t) => (t.id === tid ? { ...t, piSessionPath: handshake.sessionFile ?? null } : t)));
          }
          await requestPiRpc(
            parsed.rest ? { type: 'compact', customInstructions: parsed.rest } : { type: 'compact' },
            120_000,
            rpcKey,
          );
          showToast('上下文已压缩');
        } catch (error: unknown) {
          showToast(`压缩失败：${error instanceof Error ? error.message : String(error)}`);
        }
      })();
      return;
    }
    /* 任务进行中 → 排队：消息进悬浮栏，等当前回合结束自动发送。
     * 悬浮栏里可「引导」（立即插入当前回合）或「撤回」（放回输入框）。 */
    if (busy && tid) {
      addToQueue(tid, { id: uid(), text, attachments });
      clearDraft(sourceDraftKey);
      return;
    }
    // 空闲且已有会话：直接开回合。新会话先建 thread 再发。
    if (tid) {
      clearDraft(sourceDraftKey);
      runTurn(text, attachments, tid);
      return;
    }
    const newTid = uid();
    const newThreadCwd = projects.find((p) => p.id === selectedProject)?.path ?? null;
    const seed: Thread = {
      id: newTid,
      title: (text.split('\n')[0].trim() || attachments[0]?.name || '新会话').slice(0, 24),
      projectId: selectedProject,
      messages: [],
      piCwd: newThreadCwd,
    };
    go({ view: 'home', threadId: newTid });
    expand(selectedProject);
    clearDraft('new');
    runTurn(text, attachments, newTid, seed);
  };
  /**
   * 发起一个新回合（普通发送与排队冲刷共用）。
   * 乐观写入用户消息 + 助手占位，再走 RPC 启动/复用与模型同步流程。
   * `seed`：新会话首条消息时传入完整 Thread（state 里还没有它），
   * 追加消息时直接用，避免依赖尚未提交的 state。
   */
  const runTurn = (text: string, attachments: Attachment[], tid: string, seed?: Thread) => {
    const userMsg: Message = {
      id: uid(),
      role: 'user',
      content: text,
      attachments: attachments.length ? attachments : undefined,
    };
    const aid = uid();
    const placeholder: Message = { id: aid, role: 'assistant', content: '', blocks: [], streaming: true };
    setThreads((ts) => {
      if (seed && !ts.some((t) => t.id === seed.id)) {
        return [{ ...seed, messages: [userMsg, placeholder] }, ...ts];
      }
      const cur = ts.find((t) => t.id === tid);
      if (!cur) return ts;
      return [{ ...cur, messages: [...cur.messages, userMsg, placeholder] }, ...ts.filter((t) => t.id !== tid)];
    });
    if (isDesktopRuntime()) {
      const rpcThreadId = tid;
      const runStartedAt = Date.now();
      const current = seed ?? threads.find((t) => t.id === rpcThreadId);
      const rpcKey = current?.rpcKey ?? `rpc-${rpcThreadId}`;
      const workingDirectory = current?.piCwd ?? project?.path ?? null;
      const sessionPath = current?.piSessionPath ?? null;
      // Turn snapshot ids are local filenames; imported Pi session ids may contain
      // slashes or colons, so never use the thread id as the filename stem.
      const turnId = `turn-${Date.now().toString(36)}-${aid}`;
      void (async () => {
        if (workingDirectory) {
          await workspace('turn_begin', workingDirectory, { id: turnId });
          mutate((prev) => ({ ...prev, threads: prev.threads.map((thread) => thread.id === rpcThreadId ? { ...thread, lastTurnId: turnId } : thread) }));
        }
        // 每个会话独立 RPC 进程；绑定相同 cwd+session 时复用。
        // 握手式就绪：get_state 响应到达才算 RPC 循环可用（修复首条消息丢失）。
        const handshake = await ensurePiSession({ sessionKey: rpcKey, cwd: workingDirectory, sessionPath });
        mutate((prev) => ({
          ...prev,
          threads: prev.threads.map((t) => (t.id === rpcThreadId ? { ...t, rpcKey, piCwd: t.piCwd ?? workingDirectory, piSessionPath: t.piSessionPath ?? handshake?.sessionFile ?? null } : t)),
        }));
        piRuns.current.set(rpcKey, { threadId: rpcThreadId, messageId: aid, rpcKey, turnId, cwd: workingDirectory, state: createTurnState(runStartedAt) });
        // 模型与思考档位由 Pi 持有。仅当本地选择确实存在于 Pi 的可用目录中时才下发，
        // 否则沿用 Pi 自己的配置——避免陈旧/拼错的模型导致 "Model not found"。
        const catalog = await requestPiRpc<{ models?: { id: string; name?: string; provider: string }[] }>(
          { type: 'get_available_models' }, 10_000, rpcKey,
        ).catch(() => null);
        const models = catalog?.models ?? [];
        if (models.length) {
          setPiModels(models.map((m) => ({ id: m.id, name: m.name ?? m.id, provider: m.provider })));
        }
        try {
          const [provider, ...modelParts] = composer.model.split(':');
          const modelId = modelParts.join(':');
          if (provider && modelId && models.some((m) => m.provider === provider && m.id === modelId)) {
            await requestPiRpc({ type: 'set_model', provider, modelId }, 10_000, rpcKey);
          }
          const levels = await requestPiRpc<{ levels?: string[]; thinkingLevels?: string[] }>({ type: 'get_available_thinking_levels' }, 10_000, rpcKey);
          const supported = (levels.levels ?? levels.thinkingLevels ?? []).filter((level): level is (typeof efforts)[number] => (efforts as readonly string[]).includes(level));
          if (supported.length) {
            setPiEfforts(supported);
            await requestPiRpc({ type: 'set_thinking_level', level: supported.includes(composer.effort) ? composer.effort : supported[0] }, 10_000, rpcKey);
          }
        } catch {
          // 旧版 Pi 可能缺少其中某个命令，不影响本轮对话。
        }
        // 粘贴的图片没有磁盘来源，先落盘到临时目录再拼提示词——
        // 只有路径能让 Pi 真正读到图片；顺带把路径回写到消息里，重启后仍可查看。
        const ready = attachments.length ? await ensureAttachmentPaths(attachments) : [];
        if (ready.length && ready.some((att, i) => att.path !== attachments[i].path)) {
          setThreads((ts) => ts.map((t) => (t.id === rpcThreadId
            ? { ...t, messages: t.messages.map((m) => (m.id === userMsg.id ? { ...m, attachments: ready } : m)) }
            : t)));
        }
        // prompt 用 request 发送：Pi 接受后即返回，被拒绝时错误能落到调用方，
        // 而不是混进助手正文。
        await requestPiRpc({ type: 'prompt', message: text + attachmentPromptBlock(ready) }, 30_000, rpcKey);
        await refreshPiCatalog(rpcKey);
      })().catch((error: unknown) => {
        piRuns.current.delete(rpcKey);
        const message = error instanceof Error ? error.message : 'Pi RPC 启动失败';
        showToast(message);
        updateMsg(rpcThreadId, aid, () => ({ streaming: false, content: `发送失败：${message}`, blocks: [{ kind: 'text', id: `${aid}-err`, text: `发送失败：${message}` }] }));
      });
      return;
    }
    runDemoReply(tid, aid);
  };

  /* ---------- 排队消息：引导 / 撤回 / 回合结束冲刷 ---------- */

  /** runTurn 的最新引用：事件订阅 effect 的闭包里不能用过期渲染的版本。 */
  const runTurnRef = useRef(runTurn);
  runTurnRef.current = runTurn;

  /**
   * 引导：把排队消息立即插入当前回合（pi steer 语义）。
   * 从悬浮栏移除、写入会话并打「已插入」角标；失败回滚到排队栏。
   */
  const steerNow = (item: PendingSend) => {
    const tid = activeThread?.id;
    if (!tid || !isDesktopRuntime()) return;
    const thread = threads.find((t) => t.id === tid);
    const rpcKey = thread?.rpcKey;
    if (!rpcKey) { showToast('当前任务尚未就绪，请稍候'); return; }
    removeFromQueue(tid, item.id);
    const steerMsg: Message = {
      id: uid(),
      role: 'user',
      content: item.text,
      attachments: item.attachments.length ? item.attachments : undefined,
      steered: true,
    };
    setThreads((ts) => {
      const cur = ts.find((t) => t.id === tid);
      if (!cur) return ts;
      // 插在仍在流式的助手占位之前：用户补充发生在回合中途，视觉顺序
      // 与时间线一致（占位继续在它下方流式演进）。
      const streamingIndex = (() => {
        for (let i = cur.messages.length - 1; i >= 0; i -= 1) {
          if (cur.messages[i].streaming || cur.messages[i].thinking) return i;
        }
        return cur.messages.length;
      })();
      const messages = [...cur.messages.slice(0, streamingIndex), steerMsg, ...cur.messages.slice(streamingIndex)];
      return [{ ...cur, messages }, ...ts.filter((t) => t.id !== tid)];
    });
    void (async () => {
      try {
        const ready = item.attachments.length ? await ensureAttachmentPaths(item.attachments) : [];
        if (ready.length && ready.some((att, i) => att.path !== item.attachments[i].path)) {
          setThreads((ts) => ts.map((t) => (t.id === tid
            ? { ...t, messages: t.messages.map((m) => (m.id === steerMsg.id ? { ...m, attachments: ready } : m)) }
            : t)));
        }
        await requestPiRpc({ type: 'steer', message: item.text + attachmentPromptBlock(ready) }, 30_000, rpcKey);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        showToast(`引导失败：${message}`);
        // 失败回滚：移除乐观消息，内容回到排队栏。
        setThreads((ts) => ts.map((t) => (t.id === tid ? { ...t, messages: t.messages.filter((m) => m.id !== steerMsg.id) } : t)));
        addToQueue(tid, item);
      }
    })();
  };

  /** 从排队栏移除一条（同步更新 ref，防止事件回调读到过期队列）。 */
  const removeFromQueue = (tid: string, itemId: string) => {
    pendingRef.current = { ...pendingRef.current, [tid]: (pendingRef.current[tid] ?? []).filter((x) => x.id !== itemId) };
    setPendingSends((all) => ({ ...all, [tid]: (all[tid] ?? []).filter((x) => x.id !== itemId) }));
  };

  /** 追加一条到排队栏尾部（同步更新 ref）。 */
  const addToQueue = (tid: string, item: PendingSend) => {
    pendingRef.current = { ...pendingRef.current, [tid]: [...(pendingRef.current[tid] ?? []), item] };
    setPendingSends((all) => ({ ...all, [tid]: [...(all[tid] ?? []), item] }));
  };

  /** 撤回：把排队消息放回输入框草稿（追加，不覆盖已有内容）。 */
  const withdrawPending = (item: PendingSend) => {
    const key = activeThread?.id ?? 'new';
    removeFromQueue(key, item.id);
    setDrafts((all) => {
      const current = all[key] ?? EMPTY_DRAFT;
      const text = current.text.trim() ? `${current.text}\n${item.text}` : item.text;
      return { ...all, [key]: { text, attachments: [...current.attachments, ...item.attachments] } };
    });
  };

  /** 回合结束冲刷：FIFO 取出队首作为新回合发送；仍忙碌则留待下次。 */
  const flushPending = (tid: string) => {
    const queue = pendingRef.current[tid] ?? [];
    if (!queue.length) return;
    const [first, ...rest] = queue;
    pendingRef.current = { ...pendingRef.current, [tid]: rest };
    setPendingSends((all) => ({ ...all, [tid]: rest }));
    // runTurn 依赖渲染期 state（threads/composer/project），用 ref 取最新实现，
    // 避免事件订阅 effect 闭包里的过期版本。
    window.setTimeout(() => runTurnRef.current(first.text, first.attachments, tid), 120);
  };

  const runDemoReply = (id: string, aid: string) => {
    const reply = pickReply();
    const start = Date.now();
    const t1 = window.setTimeout(() => {
      updateMsg(id, aid, () => ({ streaming: true }));
      let i = 0;
      const iv = window.setInterval(() => {
        i += 3;
        if (i >= reply.content.length) {
          clearInterval(iv);
          updateMsg(id, aid, () => ({
            content: reply.content,
            streaming: false,
            duration: Math.max(1, Math.round((Date.now() - start) / 1000)),
            edits: reply.edits,
            steps: reply.steps,
          }));
          if (navRef.current.threadId !== id || navRef.current.view !== 'home')
            setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, unread: true } : t)));
          delete timers.current[id];
          // 演示模式回合结束：同样冲刷排队消息。
          flushPending(id);
        } else {
          updateMsg(id, aid, () => ({ content: reply.content.slice(0, i) }));
        }
      }, 22);
      timers.current[id] = [...(timers.current[id] || []), iv];
    }, 1400);
    timers.current[id] = [...(timers.current[id] || []), t1];
  };

  const stop = () => {
    if (!activeThread) return;
    const id = activeThread.id;
    (timers.current[id] || []).forEach((x) => {
      clearTimeout(x);
      clearInterval(x);
    });
    delete timers.current[id];
    if (isDesktopRuntime()) {
      const run = [...piRuns.current.values()].find((r) => r.threadId === id);
      if (run) {
        piRuns.current.delete(run.rpcKey);
        void sendPiRpc({ type: 'abort' }, run.rpcKey).catch(() => {});
      }
    }
    // 停止 = 用户要中断这个会话的运行：排队消息一并撤回草稿（pilo 的
    // releaseActiveTurn 同款），否则 abort 触发的 settled 会立刻把它们发出。
    // 注意同步清 ref：settled 事件比下一次渲染先到，只清 state 会漏。
    const queued = pendingRef.current[id] ?? [];
    if (queued.length) {
      pendingRef.current = { ...pendingRef.current, [id]: [] };
      setPendingSends((all) => ({ ...all, [id]: [] }));
      setDrafts((all) => {
        const current = all[id] ?? EMPTY_DRAFT;
        const text = [...queued.map((q) => q.text), current.text.trim()].filter(Boolean).join('\n');
        return { ...all, [id]: { text, attachments: [...current.attachments, ...queued.flatMap((q) => q.attachments)] } };
      });
    }
    setThreads((ts) =>
      ts.map((t) =>
        t.id !== id
          ? t
          : {
              ...t,
              messages: t.messages.map((m) =>
                m.streaming || m.thinking
                  ? { ...m, thinking: false, streaming: false, content: (m.content ? m.content + '\n\n' : '') + '已停止' }
                  : m,
              ),
            },
      ),
    );
  };

  /* ---------- 侧栏 / 右侧面板拖拽伸缩 ---------- */
  const startSidebarDrag = () => {
    const left = mainRef.current!.getBoundingClientRect().left;
    startDrag((x) => {
      const raw = x - left;
      if (raw < SIDEBAR_MIN) {
        setSidebarOpen(false); // 缩到极限，直接隐藏
        return false;
      }
      setSidebarW(Math.min(SIDEBAR_MAX, raw));
    });
  };

  const startRightDrag = () => {
    const rect = bodyRef.current!.getBoundingClientRect();
    startDrag((x) => {
      const raw = rect.right - x;
      if (raw > rect.width - COVER_AT) {
        setRightCover(true); // 放大到一定程度，覆盖聊天区域
        return;
      }
      setRightCover(false);
      setRightW(Math.max(RIGHT_MIN, Math.min(raw, rect.width - CHAT_MIN)));
    });
  };

  /* ---------- 快捷键 ---------- */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const k = e.key.toLowerCase();
      const t = activeThread;
      if (e.altKey) {
        if (k === 'r' && t) { e.preventDefault(); startRename(t.id, 'header'); }
        else if (k === 'p' && t) { e.preventDefault(); patchThread(t.id, { pinned: !t.pinned }); }
        return;
      }
      if (e.shiftKey) {
        if (k === 'a' && t) { e.preventDefault(); archiveThread(t.id); }
        else if (k === 'u' && t) { e.preventDefault(); patchThread(t.id, { unread: true }); showToast('已标记为未读'); }
        else if (k === 'g') { e.preventDefault(); openPanel('diff'); }
        return;
      }
      if (k === 'b') { e.preventDefault(); setSidebarOpen((o) => !o); }
      else if (k === 'n') { e.preventDefault(); newChat(); }
      else if (k === ',') { e.preventDefault(); openSettings(); }
      else if (k === '`') { e.preventDefault(); openPanel('terminal'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const menus: Record<string, MenuAction[]> = {
    文件: [
      { label: '新聊天', shortcut: 'Ctrl+N', onClick: newChat },
      { label: '新建项目…', onClick: () => setDialog({ kind: 'project' }) },
      { label: '', divider: true },
      { label: '设置', shortcut: 'Ctrl+,', onClick: openSettings },
      { label: '', divider: true },
      { label: '退出', onClick: () => showToast('退出（演示）') },
    ],
    编辑: [
      { label: '撤销', shortcut: 'Ctrl+Z', onClick: () => document.execCommand('undo') },
      { label: '重做', shortcut: 'Ctrl+Y', onClick: () => document.execCommand('redo') },
      { label: '', divider: true },
      { label: '剪切', shortcut: 'Ctrl+X' },
      { label: '复制', shortcut: 'Ctrl+C' },
      { label: '粘贴', shortcut: 'Ctrl+V' },
      { label: '全选', shortcut: 'Ctrl+A', onClick: () => document.execCommand('selectAll') },
    ],
    视图: [
      { label: sidebarOpen ? '隐藏边栏' : '显示边栏', shortcut: 'Ctrl+B', onClick: () => setSidebarOpen((o) => !o) },
      { label: rightOpen ? '隐藏侧边面板' : '显示侧边面板', onClick: () => setRightOpen((o) => !o) },
      { label: '终端', shortcut: 'Ctrl+`', onClick: () => openPanel('terminal') },
      { label: '', divider: true },
      { label: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题', onClick: () => setThemePref(theme === 'dark' ? 'light' : 'dark') },
      { label: '跟随系统主题', onClick: () => setThemePref('system') },
    ],
    帮助: [
      { label: '文档', onClick: () => showToast('打开文档（演示）') },
      { label: '在 GitHub 上查看源码', onClick: () => showToast('开源仓库（演示）') },
      { label: '报告问题', onClick: () => showToast('报告问题（演示）') },
      { label: '', divider: true },
      { label: '关于', onClick: () => showToast('WEPI v0.1.0 · 纯前端演示') },
    ],
  };

  const editingProject = dialog?.kind === 'project' && dialog.editId ? projects.find((p) => p.id === dialog.editId) ?? null : null;
  const scheduleThread = dialog?.kind === 'schedule' ? threads.find((t) => t.id === dialog.threadId) : undefined;

  return (
    <div data-theme={theme} className="flex h-full flex-col bg-[var(--bg-app)] text-[var(--text)]">
      <TitleBar
        menus={menus}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        canBack={back.length > 0}
        canForward={fwd.length > 0}
        onBack={goBack}
        onForward={goForward}
        onToast={showToast}
      />
      <div className="flex min-h-0 flex-1">
        <Rail view={nav.view} onNavigate={navigate} />
        <div
          ref={mainRef}
          className="flex min-w-0 flex-1 overflow-hidden rounded-tl-xl border-l border-t border-[var(--border)] bg-[var(--bg-main)]"
        >
          {nav.view === 'settings' && (
            <Settings
              theme={themePref}
              onTheme={setThemePref}
              archived={threads.filter((t) => t.archived)}
              hiddenWorkspaces={store.hiddenWorkspaces}
              onRestoreWorkspace={restoreWorkspace}
              onRestore={(id) => {
                patchThread(id, { archived: false });
                showToast('已恢复聊天');
              }}
              onDelete={deleteThread}
              onToast={showToast}
            />
          )}
          {nav.view === 'mcp' && <McpPage onToast={showToast} />}
          {nav.view === 'skills' && <SkillsPage onToast={showToast} />}
          {nav.view === 'providers' && (
            <ProvidersPage
              providers={providers}
              setProviders={setProviders}
              defaultModel={composer.model}
              onSetDefault={(id) => setComposer((c) => ({ ...c, model: id }))}
              onToast={showToast}
            />
          )}
          {nav.view === 'management' && <ManagementPage onToast={showToast} />}
          {nav.view === 'home' && (
            <>
              {sidebarOpen && (
                <Sidebar
                  width={sidebarW}
                  projects={projects}
                  threads={threads}
                  selectedProject={selectedProject}
                  activeThreadId={activeThread?.id ?? null}
                  expanded={expanded}
                  renaming={renaming}
                  onToggleExpand={(id) => setExpanded((e) => (e.includes(id) ? e.filter((x) => x !== id) : [...e, id]))}
                  onOpenThread={openThread}
                  onNewChat={() => newChatIn(null)}
                  onNewChatIn={(pid) => newChatIn(pid)}
                  onCreateProject={() => setDialog({ kind: 'project' })}
                  onThreadMenu={(t, x, y) => setMenu({ x, y, items: threadMenu(t, 'sidebar') })}
                  onProjectMenu={(p, x, y) => setMenu({ x, y, items: projectMenu(p) })}
                  onRenameSubmit={(id, title) => {
                    patchThread(id, { title });
                    setRenaming(null);
                  }}
                  onRenameCancel={() => setRenaming(null)}
                  onStartResize={startSidebarDrag}
                  onToast={showToast}
                />
              )}
              <div ref={bodyRef} className="relative flex h-full min-h-0 min-w-0 flex-1">
                <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg-main)]">
                  {activeThread ? (
                    <ChatView
                      thread={activeThread}
                      project={project}
                      rightOpen={rightOpen}
                      onToggleRight={() => setRightOpen((o) => !o)}
                      onViewChanges={() => openPanel('diff', activeThread.lastTurnId ?? undefined)}
                      onMenu={(x, y) => setMenu({ x, y, items: threadMenu(activeThread, 'header') })}
                      renaming={renaming?.id === activeThread.id && renaming.from === 'header'}
                      onRenameSubmit={(title) => {
                        patchThread(activeThread.id, { title });
                        setRenaming(null);
                      }}
                      onRenameCancel={() => setRenaming(null)}
                      onToast={showToast}
                      onOpenLink={openChatLink}
                    />
                  ) : (
                    <EmptyState project={project} rightOpen={rightOpen} onToggleRight={() => setRightOpen((o) => !o)} />
                  )}
                  <div className="mx-auto w-full max-w-[760px] px-4 pb-4">
                    {/* Extension UI 待响应卡：pi 扩展的对话请求（安全审批 / ask）阻塞等待用户。
                        响应/超时/取消后经 onSettled 从登记表移除卡片。
                        key/id 先提取为局部 const：闭包捕获稳定值，不随 activeThread 变化。 */}
                    {(() => {
                      const rpcKey = activeThread?.rpcKey;
                      const pending = rpcKey ? uiRequests[rpcKey] : undefined;
                      if (!rpcKey || !pending) return null;
                      const settle = () => clearUiRequest(rpcKey, pending.id);
                      return isSecurityConfirm(pending) ? (
                        <SecurityConfirmCard request={pending} sessionKey={rpcKey} onSettled={settle} />
                      ) : (
                        <DialogRequestCard request={pending} sessionKey={rpcKey} onSettled={settle} />
                      );
                    })()}
                    {/* Todo 常驻条：活会话来自 widget 行快照；历史会话从会话文件兜底。
                        全部完成时组件内部自行隐藏（数据保留在会话侧）。 */}
                    {(() => {
                      const key = activeThread?.rpcKey;
                      const live = key ? todoBySession[key] : undefined;
                      if (live && live.length > 0) return <TodoStrip items={live} />;
                      const fallback = activeThread ? todoByThread[activeThread.id] : undefined;
                      return fallback ? <TodoStrip items={fallback} /> : null;
                    })()}
                    <Composer
                      project={project}
                      projects={projects}
                      onSelectProject={setSelectedProject}
                      onCreateProject={() => setDialog({ kind: 'project' })}
                      showChips={!activeThread}
                      settings={composer}
                      onSettings={setComposer}
                      modelOptions={modelOptions}
                      effortOptions={piEfforts}
                      draft={draft}
                      onDraft={setDraft}
                      onSend={send}
                      busy={busy}
                      onStop={stop}
                      onToast={showToast}
                      usage={usage}
                      commands={slashCommands}
                      onSlashTrigger={(trigger) => {
                        if (trigger) loadSlashCommands(activeThread?.rpcKey ?? undefined);
                      }}
                      queue={activeThread ? pendingSends[activeThread.id] ?? [] : []}
                      onQueueItem={(item, action) => {
                        if (action === 'steer') steerNow(item);
                        else withdrawPending(item);
                      }}
                    />
                  </div>
                </div>
                {rightOpen && (
                  <RightPanel
                    onClose={() => setRightOpen(false)}
                    openKind={openKind}
                    width={rightW}
                    cover={rightCover}
                    onStartDrag={startRightDrag}
                    onToggleCover={() => setRightCover((c) => !c)}
                    workspaceRoot={project?.path ?? undefined}
                    target={panelTarget}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}

      {/* 原生拖拽落区提示：文件进入窗口即提示，松手后并入当前会话草稿 */}
      {dropActive && nav.view === 'home' && (
        <div className="pointer-events-none fixed inset-0 z-[120] flex items-center justify-center bg-black/40">
          <div className="rounded-2xl border border-dashed border-[var(--blue)] bg-[var(--bg-elev)] px-6 py-4 text-[14px] text-[var(--text)] shadow-2xl shadow-black/40">
            松开以添加图片或文件
          </div>
        </div>
      )}

      {dialog?.kind === 'project' && (
        <ProjectDialog
          key={dialog.editId ?? 'new'}
          initial={editingProject}
          onClose={() => setDialog(null)}
          onSubmit={(name, path) => {
            if (editingProject) {
              setProjects((ps) => ps.map((p) => (p.id === editingProject.id ? { ...p, name, path } : p)));
              showToast('项目已更新');
            } else createProject(name, path);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'confirm' && (
        <ConfirmDialog
          title={dialog.title}
          desc={dialog.desc}
          label={dialog.label}
          onConfirm={dialog.onConfirm}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'schedule' && scheduleThread && (
        <ScheduleDialog
          title={scheduleThread.title}
          onClose={() => setDialog(null)}
          onSubmit={(s) => showToast(`已添加计划任务：${s}`)}
        />
      )}

      {toast && (
        <div className="fade-in pointer-events-none fixed bottom-24 left-1/2 z-[300] -translate-x-1/2 rounded-lg bg-[var(--text)] px-3.5 py-2 text-[13px] text-[var(--bg-main)] shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
