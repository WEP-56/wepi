import { useCallback, useEffect, useRef, useState } from 'react';
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
import { fileTarget, workspace, type PanelTarget, type Review } from './lib/workspace';
import type { UsageSnapshot } from './components/ContextUsage';
import {
  efforts,
  buildModelOptions,
  pickReply,
  uid,
  type Thread,
  type Project,
  type Provider,
  type McpServer,
  type Skill,
  type Message,
} from './data';

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
  const persist = useCallback((next: PersistedStore) => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
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
  const [mcp, setMcp] = useState<McpServer[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
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
  const [piModels, setPiModels] = useState<{ id: string; name: string; provider: string }[]>([]);
  const [piEfforts, setPiEfforts] = useState<readonly (typeof efforts)[number][]>(efforts);
  const [usage, setUsage] = useState<UsageSnapshot>({ contextPercent: 0, contextTokens: 0, contextWindow: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCost: 0 });
  const [piConfigReady, setPiConfigReady] = useState(false);
  const [piRuntimeInfo, setPiRuntimeInfo] = useState<{ agentDir?: string; piPath?: string; skillsCount: number; extensionsCount: number }>({ skillsCount: 0, extensionsCount: 0 });

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

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const h = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  useEffect(() => localStorage.setItem('theme', themePref), [themePref]);
  useEffect(() => localStorage.setItem('composer-settings', JSON.stringify(composer)), [composer]);
  useEffect(() => {
    if (!isDesktopRuntime()) { setPiConfigReady(true); return; }
    void readPiConfig().then((snapshot) => {
      if (!snapshot) return;
      setPiRuntimeInfo({ agentDir: snapshot.agentDir, piPath: snapshot.piPath, skillsCount: snapshot.skillsCount, extensionsCount: snapshot.extensionsCount });
      const entries = Object.entries(snapshot.models.providers ?? {});
      piModelsConfig.current = Object.fromEntries(entries.map(([id, value]) => [id, value as unknown as Record<string, unknown>]));
      const nextProviders: Provider[] = entries.map(([id, value]) => {
        const name = id;
        const lower = id.toLowerCase();
        const kind: Provider['kind'] = lower.includes('anthropic') ? 'anthropic' : lower.includes('google') || lower.includes('gemini') ? 'google' : lower.includes('deepseek') ? 'deepseek' : lower.includes('ollama') ? 'ollama' : lower.includes('openai') ? 'openai' : 'custom';
        return { id, name, kind, baseUrl: value.baseUrl ?? '', api: value.api, headers: value.headers, compat: value.compat, apiKey: value.apiKey ?? snapshot.auth[id]?.key ?? '', enabled: true, models: (value.models ?? []).map((model) => model.id), modelDetails: Object.fromEntries((value.models ?? []).map((model) => [model.id, model])) };
      });
      setProviders(nextProviders);
      const mcpServers = snapshot.mcp.mcpServers;
      if (mcpServers && typeof mcpServers === 'object') {
        setMcp(Object.entries(mcpServers as Record<string, Record<string, unknown>>).map(([id, server]) => ({
          id,
          name: id,
          transport: typeof server.url === 'string' ? 'http' : 'stdio',
          command: typeof server.command === 'string' ? server.command : '',
          args: Array.isArray(server.args) ? server.args.join(' ') : typeof server.args === 'string' ? server.args : '',
          url: typeof server.url === 'string' ? server.url : '',
          env: server.env && typeof server.env === 'object' ? Object.entries(server.env as Record<string, unknown>).map(([key, value]) => `${key}=${String(value)}`).join('\n') : '',
          enabled: true,
          status: 'disabled',
          tools: [],
        })));
      }
      setSkills((snapshot.skills ?? []).map((name) => ({ id: name, name, description: '来自 Pi skills 目录', source: '用户', enabled: true, content: '' })));
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

  const openWithItems = (path?: string): CtxItem[] =>
    ['VS Code', '文件资源管理器', '终端'].map((n) => ({
      label: n,
      onClick: () => showToast(`已在 ${n} 中打开 ${path ?? '工作区'}`),
    }));

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
  };

  /* ---------- Pi RPC 事件 → 聊天区域渲染状态机 ---------- */
  useEffect(() => {
    let dispose: (() => void) | undefined;
    dispose = listenPiRpc({
      event: (record) => {
        // 按来源会话键路由：允许多个会话同时运行（切走再发消息不会串台）。
        const sessionKey = typeof record.__sessionKey === 'string' ? record.__sessionKey : undefined;
        const run = sessionKey ? piRuns.current.get(sessionKey) : undefined;
        if (!run) return;
        // 回合状态由纯函数归约器推进，事件处理不再直接改 ref。
        const next = applyPiEvent(run.state, record, Date.now());
        if (next !== run.state) {
          run.state = next;
          updateMsg(run.threadId, run.messageId, () => ({
            content: displayContent(next),
            thinking: next.thinking,
            streaming: next.streaming,
            thinkingContent: next.thinkingContent || undefined,
            steps: next.steps.length ? next.steps : undefined,
            ...(next.duration !== undefined ? { duration: next.duration } : {}),
          }));
        }
        if (record.type === 'agent_settled' && next.finished) {
          const turnId = run.turnId;
          void workspace<Review & { id: string }>('turn_end', run.cwd ?? '', { id: turnId }).then((review) => {
            const edits = review.files.map((file) => ({ file: file.file, add: file.add, del: file.del }));
            setThreads((ts) => ts.map((thread) => thread.id === run.threadId ? { ...thread, lastTurnId: review.id, messages: thread.messages.map((message) => message.id === run.messageId ? { ...message, edits: edits.length ? edits : undefined } : message) } : thread));
          }).catch(() => {});
          if (navRef.current.threadId !== run.threadId || navRef.current.view !== 'home')
            setThreads((ts) => ts.map((thread) => thread.id === run.threadId ? { ...thread, unread: true } : thread));
          piRuns.current.delete(run.rpcKey);
          void requestPiRpc<{ sessionFile?: string; contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null }; tokens?: { input?: number; output?: number; cacheRead?: number }; cost?: number }>({ type: 'get_session_stats' }, 10_000, run.rpcKey).then((stats) => {
            const context = stats.contextUsage ?? {};
            const tokens = stats.tokens ?? {};
            setUsage({ contextPercent: context.percent ?? 0, contextTokens: context.tokens ?? 0, contextWindow: context.contextWindow ?? 0, inputTokens: tokens.input ?? 0, outputTokens: tokens.output ?? 0, cacheReadTokens: tokens.cacheRead ?? 0, totalCost: stats.cost ?? 0 });
            if (stats.sessionFile) {
              setThreads((ts) => ts.map((thread) => (thread.id === run.threadId && !thread.piSessionPath ? { ...thread, piSessionPath: stats.sessionFile } : thread)));
            }
          }).catch(() => {});
        }
      },
      error: (message) => showToast(message),
      exit: (sessionKey) => {
        const run = sessionKey ? piRuns.current.get(sessionKey) : undefined;
        if (!run) return;
        piRuns.current.delete(run.rpcKey);
        updateMsg(run.threadId, run.messageId, (message) => ({
          thinking: false,
          streaming: false,
          content: message.content || 'Pi RPC 进程已退出，请检查 Pi 配置和错误日志。',
        }));
      },
    });
    return () => { dispose?.(); void stopPiRpc(); };
  }, [showToast]);

  const send = (text: string) => {
    let tid = activeThread?.id;
    const userMsg: Message = { id: uid(), role: 'user', content: text };
    const aid = uid();
    const thinking: Message = { id: aid, role: 'assistant', content: '', thinking: true };
    // 新会话的工作目录取自所选项目——Pi 会话按 cwd 归档，必须一开始就绑定。
    const newThreadCwd = projects.find((p) => p.id === selectedProject)?.path ?? null;
    if (!tid) {
      tid = uid();
      const t: Thread = {
        id: tid,
        title: text.split('\n')[0].slice(0, 24),
        projectId: selectedProject,
        messages: [userMsg, thinking],
        piCwd: newThreadCwd,
      };
      setThreads((ts) => [t, ...ts]);
      expand(selectedProject);
      go({ view: 'home', threadId: tid });
    } else {
      const id = tid;
      setThreads((ts) => {
        const cur = ts.find((t) => t.id === id);
        if (!cur) return ts;
        return [{ ...cur, messages: [...cur.messages, userMsg, thinking] }, ...ts.filter((t) => t.id !== id)];
      });
    }
    if (isDesktopRuntime()) {
      const rpcThreadId = tid;
      const runStartedAt = Date.now();
      const current = threads.find((t) => t.id === rpcThreadId);
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
        await ensurePiSession({ sessionKey: rpcKey, cwd: workingDirectory, sessionPath });
        mutate((prev) => ({
          ...prev,
          threads: prev.threads.map((t) => (t.id === rpcThreadId ? { ...t, rpcKey, piCwd: t.piCwd ?? workingDirectory } : t)),
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
        // prompt 用 request 发送：Pi 接受后即返回，被拒绝时错误能落到调用方，
        // 而不是混进助手正文。
        await requestPiRpc({ type: 'prompt', message: text }, 30_000, rpcKey);
        await refreshPiCatalog(rpcKey);
      })().catch((error: unknown) => {
        piRuns.current.delete(rpcKey);
        const message = error instanceof Error ? error.message : 'Pi RPC 启动失败';
        showToast(message);
        updateMsg(rpcThreadId, aid, () => ({ thinking: false, streaming: false, content: `发送失败：${message}` }));
      });
      return;
    }
    runDemoReply(tid, aid);
  };

  const runDemoReply = (id: string, aid: string) => {
    const reply = pickReply();
    const start = Date.now();
    const t1 = window.setTimeout(() => {
      updateMsg(id, aid, () => ({ thinking: false, streaming: true }));
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
        } else {
          updateMsg(id, aid, () => ({ content: reply.content.slice(0, i) }));
        }
      }, 22);
      timers.current[id] = [...(timers.current[id] || []), iv];
    }, 1400);
    timers.current[id] = [t1];
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
          {nav.view === 'mcp' && <McpPage servers={mcp} setServers={setMcp} onToast={showToast} />}
          {nav.view === 'skills' && <SkillsPage skills={skills} setSkills={setSkills} onToast={showToast} />}
          {nav.view === 'providers' && (
            <ProvidersPage
              providers={providers}
              setProviders={setProviders}
              defaultModel={composer.model}
              onSetDefault={(id) => setComposer((c) => ({ ...c, model: id }))}
              onToast={showToast}
            />
          )}
          {nav.view === 'management' && <ManagementPage onToast={showToast} runtime={piRuntimeInfo} providerCount={providers.length} />}
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
                      onSend={send}
                      busy={busy}
                      onStop={stop}
                      onToast={showToast}
                      usage={usage}
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
