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
  CirclePlus,
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
import { isDesktopRuntime, listenPiRpc, promptRecord, readPiConfig, requestPiRpc, sendPiRpc, startPiRpc, stopPiRpc, writePiConfig } from './lib/piRpc';
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

export default function App() {
  const [themePref, setThemePref] = useState<ThemePref>(() => (localStorage.getItem('theme') as ThemePref) || 'dark');
  const [sysDark, setSysDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [mcp, setMcp] = useState<McpServer[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [nav, setNav] = useState<NavState>({ view: 'home', threadId: null });
  const [back, setBack] = useState<NavState[]>([]);
  const [fwd, setFwd] = useState<NavState[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<{ id: string; from: 'sidebar' | 'header' } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarW, setSidebarW] = useState(248);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightW, setRightW] = useState(366);
  const [rightCover, setRightCover] = useState(false);
  const [openKind, setOpenKind] = useState<{ kind: TabKind; n: number } | null>(null);
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
  const piRun = useRef<{ threadId: string; messageId: string; startedAt: number } | null>(null);
  const piCwd = useRef<string | null>(null);
  const piModelsConfig = useRef<Record<string, Record<string, unknown>>>({});

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
      if (snapshot.cwd && projects.length === 0) {
        const normalized = snapshot.cwd.replace(/[\\/]+$/, '');
        const name = normalized.split(/[\\/]/).pop() || normalized;
        setProjects([{ id: `workspace:${normalized}`, name, path: normalized, branch: 'main' }]);
      }
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
  const openPanel = (kind: TabKind) => {
    setRightOpen(true);
    setOpenKind({ kind, n: Date.now() });
  };
  const expand = (pid: string | null) => {
    if (pid) setExpanded((e) => (e.includes(pid) ? e : [...e, pid]));
  };

  /* ---------- 会话 / 项目操作 ---------- */
  const patchThread = (id: string, p: Partial<Thread>) => setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));

  const openThread = (id: string) => {
    patchThread(id, { unread: false });
    go({ view: 'home', threadId: id });
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
    setThreads((ts) => ts.filter((t) => t.id !== id));
    if (nav.threadId === id) setNav({ view: 'home', threadId: null });
    showToast('已永久删除聊天');
  };

  const confirmDelete = (t: Thread) =>
    setDialog({
      kind: 'confirm',
      title: '永久删除聊天？',
      desc: `「${t.title}」将被永久删除，此操作无法撤销。如只想隐藏它，可以选择「归档」。`,
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

  const removeProject = (p: Project) => {
    setProjects((ps) => ps.filter((x) => x.id !== p.id));
    setThreads((ts) => ts.map((t) => (t.projectId === p.id ? { ...t, projectId: null } : t)));
    if (selectedProject === p.id) setSelectedProject(null);
    showToast(`已移除项目 ${p.name}`);
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
        { label: '新建侧边聊天', icon: <CirclePlus size={15} />, shortcut: 'Alt+Ctrl+S', onClick: () => openPanel('chat') },
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

  const refreshPiCatalog = async () => {
    try {
      const result = await requestPiRpc<{ models?: { id: string; name?: string; provider: string }[] }>({ type: 'get_available_models' });
      const models = (result.models ?? []).map((model) => ({ id: model.id, name: model.name ?? model.id, provider: model.provider }));
      if (models.length) {
        setPiModels(models);
        setComposer((current) => models.some((model) => `${model.provider}:${model.id}` === current.model) ? current : { ...current, model: `${models[0].provider}:${models[0].id}` });
      }
    } catch { /* Older Pi versions can omit this command; keep the static catalog. */ }
    try {
      const result = await requestPiRpc<{ model?: { id?: string; provider?: string }; thinkingLevel?: string }>({ type: 'get_state' });
      if (result.model?.id && result.model.provider) setComposer((current) => ({ ...current, model: `${result.model!.provider}:${result.model!.id}` }));
      if (result.thinkingLevel && (efforts as readonly string[]).includes(result.thinkingLevel)) setComposer((current) => ({ ...current, effort: result.thinkingLevel as typeof efforts[number] }));
    } catch { /* State is optional during Pi startup. */ }
    try {
      const result = await requestPiRpc<{ levels?: string[]; thinkingLevels?: string[] }>({ type: 'get_available_thinking_levels' });
      const levels = result.levels ?? result.thinkingLevels ?? [];
      const supported = levels.filter((level): level is (typeof efforts)[number] => (efforts as readonly string[]).includes(level));
      if (supported.length) {
        setPiEfforts(supported);
        setComposer((current) => supported.includes(current.effort) ? current : { ...current, effort: supported[0] });
      }
    } catch { /* Older Pi versions do not expose thinking levels. */ }
    try {
      const result = await requestPiRpc<{ contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null }; tokens?: { input?: number; output?: number; cacheRead?: number }; cost?: number }>({ type: 'get_session_stats' });
      const context = result.contextUsage ?? {};
      const tokens = result.tokens ?? {};
      setUsage({ contextPercent: context.percent ?? 0, contextTokens: context.tokens ?? 0, contextWindow: context.contextWindow ?? 0, inputTokens: tokens.input ?? 0, outputTokens: tokens.output ?? 0, cacheReadTokens: tokens.cacheRead ?? 0, totalCost: result.cost ?? 0 });
    } catch { /* Stats are optional until the first completed turn. */ }
  };

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void listenPiRpc({
      event: (record) => {
        const run = piRun.current;
        if (!run) return;
        const event = record.type;
        const assistantEvent = (record.assistantMessageEvent ?? {}) as Record<string, unknown>;
        const appendThinking = (delta: string) => updateMsg(run.threadId, run.messageId, (message) => ({ thinking: true, streaming: true, thinkingContent: (message.thinkingContent ?? '') + delta }));
        const textFromContent = (value: unknown) => Array.isArray(value)
          ? value.filter((block): block is Record<string, unknown> => !!block && typeof block === 'object' && block.type === 'text').map((block) => typeof block.text === 'string' ? block.text : '').join('')
          : typeof value === 'string' ? value : '';
        if (event === 'assistant_text_delta') {
          if (typeof record.delta === 'string') updateMsg(run.threadId, run.messageId, (message) => ({ thinking: false, streaming: true, content: message.content + record.delta }));
        } else if (event === 'assistant_thinking_start') {
          updateMsg(run.threadId, run.messageId, () => ({ thinking: true, streaming: true }));
        } else if (event === 'assistant_thinking_delta') {
          if (typeof record.delta === 'string') appendThinking(record.delta);
        } else if (event === 'assistant_thinking_end') {
          updateMsg(run.threadId, run.messageId, () => ({ thinking: false, streaming: true }));
        } else if (event === 'assistant_message_start') {
          updateMsg(run.threadId, run.messageId, () => ({ thinking: true, streaming: true, content: '', thinkingContent: '' }));
        } else if (event === 'user_message_start') {
          // Pi may echo the accepted user message; the local optimistic message is authoritative.
        } else if (event === 'message_update') {
          if (assistantEvent.type === 'text_delta' && typeof assistantEvent.delta === 'string') {
            updateMsg(run.threadId, run.messageId, (message) => ({
              thinking: false,
              streaming: true,
              content: message.content + assistantEvent.delta,
            }));
          } else if (assistantEvent.type === 'thinking_delta' && typeof assistantEvent.delta === 'string') {
            appendThinking(assistantEvent.delta);
          }
        } else if (event === 'assistant_message_end') {
          updateMsg(run.threadId, run.messageId, (message) => ({ thinking: false, streaming: true, content: message.content || textFromContent((record.message as Record<string, unknown> | undefined)?.content) }));
        } else if (event === 'message_end') {
          const message = record.message as Record<string, unknown> | undefined;
          const blocks = Array.isArray(message?.content) ? message.content : [];
          const content = blocks
            .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object' && block.type === 'text')
            .map((block) => typeof block.text === 'string' ? block.text : '')
            .join('');
          if (content) updateMsg(run.threadId, run.messageId, (current) => ({ content, thinking: false, streaming: true, thinkingContent: current.thinkingContent }));
        } else if (event === 'tool_execution_start') {
          const toolName = typeof record.toolName === 'string' ? record.toolName : '工具';
          const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : uid();
          const args = record.args as Record<string, unknown> | undefined;
          const command = typeof args?.command === 'string' ? args.command : typeof args?.path === 'string' ? `${toolName} ${args.path}` : `${toolName}…`;
          updateMsg(run.threadId, run.messageId, (message) => ({
            thinking: false,
            streaming: true,
            steps: [...(message.steps ?? []), { id: toolCallId, kind: 'action', icon: toolName === 'bash' || toolName === 'shell' ? 'command' : 'agent', label: `已运行 ${command}`, detail: { kind: 'command', command, lines: [] } }],
          }));
        } else if (event === 'tool_execution_update') {
          const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : '';
          const output = textFromContent((record.partialResult as Record<string, unknown> | undefined)?.content ?? record.partialResult);
          if (toolCallId && output) updateMsg(run.threadId, run.messageId, (message) => ({ steps: (message.steps ?? []).map((step) => step.id !== toolCallId || step.detail?.kind !== 'command' ? step : { ...step, detail: { ...step.detail, lines: output.split('\n').map((line) => ({ s: line })) } }) }));
        } else if (event === 'tool_execution_end') {
          const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : '';
          const result = record.result as Record<string, unknown> | undefined;
          const output = textFromContent(result?.content ?? result);
          if (toolCallId) updateMsg(run.threadId, run.messageId, (message) => ({ steps: (message.steps ?? []).map((step) => step.id !== toolCallId || step.detail?.kind !== 'command' || !output ? step : { ...step, detail: { ...step.detail, lines: output.split('\n').map((line) => ({ s: line, t: record.isError ? 'err' as const : undefined })) } }) }));
        } else if (event === 'rpc_message') {
          const message = record.message as Record<string, unknown> | undefined;
          if (message?.success === false) updateMsg(run.threadId, run.messageId, () => ({ thinking: false, streaming: false, content: `Pi RPC 请求失败：${String(message.error ?? '未知错误')}` }));
        } else if (event === 'agent_settled') {
          updateMsg(run.threadId, run.messageId, (message) => ({
            thinking: false,
            streaming: false,
            duration: Math.max(1, Math.round((Date.now() - run.startedAt) / 1000)),
            content: message.content || '（Pi 未返回文本）',
          }));
          if (navRef.current.threadId !== run.threadId || navRef.current.view !== 'home')
            setThreads((ts) => ts.map((thread) => thread.id === run.threadId ? { ...thread, unread: true } : thread));
          piRun.current = null;
          void requestPiRpc<{ contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null }; tokens?: { input?: number; output?: number; cacheRead?: number }; cost?: number }>({ type: 'get_session_stats' }).then((stats) => {
            const context = stats.contextUsage ?? {};
            const tokens = stats.tokens ?? {};
            setUsage({ contextPercent: context.percent ?? 0, contextTokens: context.tokens ?? 0, contextWindow: context.contextWindow ?? 0, inputTokens: tokens.input ?? 0, outputTokens: tokens.output ?? 0, cacheReadTokens: tokens.cacheRead ?? 0, totalCost: stats.cost ?? 0 });
          }).catch(() => {});
        }
      },
      error: (message) => showToast(message),
      exit: () => {
        const run = piRun.current;
        if (!run) return;
        piRun.current = null;
        updateMsg(run.threadId, run.messageId, (message) => ({
          thinking: false,
          streaming: false,
          content: message.content || 'Pi RPC 进程已退出，请检查 Pi 配置和错误日志。',
        }));
      },
    }).then((unlisten) => { dispose = unlisten; });
    return () => { dispose?.(); void stopPiRpc(); };
  }, [showToast]);

  const send = (text: string) => {
    let tid = activeThread?.id;
    const userMsg: Message = { id: uid(), role: 'user', content: text };
    const aid = uid();
    const thinking: Message = { id: aid, role: 'assistant', content: '', thinking: true };
    if (!tid) {
      tid = uid();
      const t: Thread = {
        id: tid,
        title: text.split('\n')[0].slice(0, 24),
        projectId: selectedProject,
        messages: [userMsg, thinking],
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
      const workingDirectory = project?.path ?? null;
      void (async () => {
        if (piCwd.current !== workingDirectory) {
          await stopPiRpc();
          piCwd.current = workingDirectory;
        }
        await startPiRpc({ cwd: workingDirectory ?? undefined });
      })().then(async () => {
        // Pi owns provider, model, thinking level, and session configuration.
        piRun.current = { threadId: rpcThreadId, messageId: aid, startedAt: runStartedAt };
        await refreshPiCatalog();
        const [provider, ...modelParts] = composer.model.split(':');
        const modelId = modelParts.join(':');
        try {
          if (provider && modelId) await requestPiRpc({ type: 'set_model', provider, modelId });
          const thinking = await requestPiRpc<{ levels?: string[]; thinkingLevels?: string[] }>({ type: 'get_available_thinking_levels' });
          const levels = (thinking.levels ?? thinking.thinkingLevels ?? []).filter((level): level is (typeof efforts)[number] => (efforts as readonly string[]).includes(level));
          if (levels.length) setPiEfforts(levels);
          await requestPiRpc({ type: 'set_thinking_level', level: composer.effort });
        } catch {
          // Keep compatibility with older Pi builds that lack one of these RPCs.
        }
        await sendPiRpc(promptRecord(uid(), text));
      }).catch((error: unknown) => {
        piRun.current = null;
        const message = error instanceof Error ? error.message : 'Pi RPC 启动失败';
        showToast(message);
        updateMsg(rpcThreadId, aid, () => ({ thinking: false, streaming: false, content: `Pi RPC 启动失败：${message}` }));
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
    if (isDesktopRuntime() && piRun.current?.threadId === id) {
      piRun.current = null;
      void sendPiRpc({ type: 'abort' }).catch(() => {});
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
        else if (k === 's') { e.preventDefault(); openPanel('chat'); }
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
              <div ref={bodyRef} className="relative flex min-w-0 flex-1">
                <div className="flex min-w-0 flex-1 flex-col bg-[var(--bg-main)]">
                  {activeThread ? (
                    <ChatView
                      thread={activeThread}
                      project={project}
                      rightOpen={rightOpen}
                      onToggleRight={() => setRightOpen((o) => !o)}
                      onViewChanges={() => openPanel('diff')}
                      onMenu={(x, y) => setMenu({ x, y, items: threadMenu(activeThread, 'header') })}
                      renaming={renaming?.id === activeThread.id && renaming.from === 'header'}
                      onRenameSubmit={(title) => {
                        patchThread(activeThread.id, { title });
                        setRenaming(null);
                      }}
                      onRenameCancel={() => setRenaming(null)}
                      onToast={showToast}
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
