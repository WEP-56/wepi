import { useState, useEffect } from 'react';
import {
  Globe,
  X,
  Plus,
  Minimize2,
  Maximize2,
  PanelRight,
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  MoreHorizontal,
  FileDiff,
  SquareTerminal,
  Files,
  MessageCirclePlus,
  Folder,
  FileText,
  ChevronRight,
} from 'lucide-react';
import { Kbd } from './ui';
import { ResizeHandle } from './Resizer';
import { cn } from '../utils/cn';

export type TabKind = 'new' | 'diff' | 'terminal' | 'files' | 'chat' | 'web';
interface Tab {
  id: string;
  kind: TabKind;
  url?: string;
}

const titles: Record<TabKind, string> = {
  new: '新标签页',
  diff: '变更',
  terminal: '终端',
  files: '文件',
  chat: '侧边聊天',
  web: '网页',
};
const icons: Record<TabKind, typeof Globe> = {
  new: Globe,
  diff: FileDiff,
  terminal: SquareTerminal,
  files: Files,
  chat: MessageCirclePlus,
  web: Globe,
};

let tid = 1;

function DiffView() {
  const lines = [
    { t: ' ', s: "import { useState } from 'react';" },
    { t: '+', s: "import { validateEmail } from '../utils/validate';" },
    { t: ' ', s: '' },
    { t: ' ', s: 'export function LoginForm({ onSubmit }: Props) {' },
    { t: ' ', s: "  const [email, setEmail] = useState('');" },
    { t: '+', s: "  const [error, setError] = useState('');" },
    { t: ' ', s: '' },
    { t: ' ', s: '  const handleSubmit = () => {' },
    { t: '-', s: '    onSubmit(email, password);' },
    { t: '+', s: "    if (!validateEmail(email)) return setError('请输入有效的邮箱地址');" },
    { t: '+', s: "    setError('');" },
    { t: '+', s: '    onSubmit(email, password);' },
    { t: ' ', s: '  };' },
  ];
  return (
    <div className="p-3">
      <div className="overflow-hidden rounded-xl border border-[var(--border)]">
        <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-hover)] px-3 py-2 text-[12.5px] text-[var(--text)]">
          <FileText size={13} /> src/pages/Login.tsx
          <span className="ml-auto text-[#3fb950]">+5</span>
          <span className="text-[#f85149]">-1</span>
        </div>
        <pre className="overflow-x-auto py-1 font-mono text-[12px] leading-[20px]">
          {lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                'flex px-3',
                l.t === '+' && 'bg-[#3fb950]/15 text-[#3fb950]',
                l.t === '-' && 'bg-[#f85149]/15 text-[#f85149]',
                l.t === ' ' && 'text-[var(--text-2)]',
              )}
            >
              <span className="w-6 select-none text-[var(--text-3)]">{i + 1}</span>
              <span className="w-4 select-none">{l.t}</span>
              {l.s}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

function TerminalView() {
  const prompt = 'PS C:\\Users\\you\\code\\demo-web>';
  const [hist, setHist] = useState<string[]>([
    'Windows PowerShell',
    `${prompt} npm test`,
    '',
    ' PASS  tests/validate.test.ts',
    ' PASS  tests/login.test.ts',
    '',
    'Tests:       12 passed, 12 total',
    'Time:        1.84 s',
  ]);
  const [cmd, setCmd] = useState('');
  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-main)] p-3 font-mono text-[12px] leading-[19px] text-[var(--text)]">
      {hist.map((h, i) => (
        <div key={i} className="whitespace-pre-wrap">{h}</div>
      ))}
      <form
        className="flex"
        onSubmit={(e) => {
          e.preventDefault();
          const out = cmd === 'clear' ? null : cmd ? `${cmd.split(' ')[0]}: 演示终端，命令未实际执行` : '';
          setHist(out === null ? [] : [...hist, `${prompt} ${cmd}`, ...(out ? [out] : [])]);
          setCmd('');
        }}
      >
        <span className="whitespace-pre">{prompt} </span>
        <input autoFocus value={cmd} onChange={(e) => setCmd(e.target.value)} className="flex-1 bg-transparent outline-none" />
      </form>
    </div>
  );
}

function FilesView() {
  const tree = ['src/', 'src/pages/', 'src/pages/Login.tsx', 'src/utils/', 'src/utils/validate.ts', 'tests/', 'public/', 'package.json', 'README.md'];
  return (
    <div className="p-2 text-[13px]">
      {tree.map((f) => (
        <div key={f} className="flex items-center gap-2 rounded-md px-2 py-1 text-[var(--text)] hover:bg-[var(--bg-hover)]" style={{ paddingLeft: 8 + (f.split('/').length - (f.endsWith('/') ? 2 : 1)) * 14 }}>
          {f.endsWith('/') ? <><ChevronRight size={12} className="text-[var(--text-3)]" /><Folder size={13} className="text-[var(--text-2)]" /></> : <FileText size={13} className="ml-[20px] text-[var(--text-2)]" />}
          {f.replace(/\/$/, '').split('/').pop()}
        </div>
      ))}
    </div>
  );
}

export default function RightPanel({
  onClose,
  openKind,
  width,
  cover,
  onStartDrag,
  onToggleCover,
}: {
  onClose: () => void;
  openKind: { kind: TabKind; n: number } | null;
  width: number;
  cover: boolean;
  onStartDrag: () => void;
  onToggleCover: () => void;
}) {
  const [tabs, setTabs] = useState<Tab[]>([{ id: 't0', kind: 'new' }]);
  const [active, setActive] = useState('t0');
  const [url, setUrl] = useState('');
  const cur = tabs.find((t) => t.id === active) ?? tabs[0];

  const openTool = (kind: TabKind, extra?: Partial<Tab>) => {
    setTabs((ts) => ts.map((t) => (t.id === cur.id ? { ...t, kind, ...extra } : t)));
  };

  useEffect(() => {
    if (!openKind) return;
    const id = 't' + tid++;
    setTabs((ts) => [...ts, { id, kind: openKind.kind }]);
    setActive(id);
  }, [openKind]);

  const addTab = () => {
    const id = 't' + tid++;
    setTabs([...tabs, { id, kind: 'new' }]);
    setActive(id);
    setUrl('');
  };
  const closeTab = (id: string) => {
    const rest = tabs.filter((t) => t.id !== id);
    if (!rest.length) return onClose();
    setTabs(rest);
    if (active === id) setActive(rest[rest.length - 1].id);
  };

  const tools: { kind: TabKind; label: string; key: string; Icon: typeof Globe }[] = [
    { kind: 'diff', label: '变更', key: 'Ctrl+Shift+G', Icon: FileDiff },
    { kind: 'terminal', label: '终端', key: 'Ctrl+`', Icon: SquareTerminal },
    { kind: 'files', label: '文件', key: 'Ctrl+P', Icon: Files },
    { kind: 'chat', label: '侧边聊天', key: 'Ctrl+Alt+S', Icon: MessageCirclePlus },
  ];

  return (
    <div
      style={cover ? undefined : { width }}
      className={cn(
        'flex flex-col border-l border-[var(--border)] bg-[var(--bg-main)]',
        cover ? 'absolute inset-0 z-20' : 'relative h-full shrink-0',
      )}
    >
      <ResizeHandle onStart={onStartDrag} className={cover ? 'left-0' : 'left-[-3px]'} />
      <div className="flex h-[52px] shrink-0 items-center gap-1 px-2">
        <div className="scroll-thin flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const I = icons[t.kind];
            return (
              <div
                key={t.id}
                onClick={() => setActive(t.id)}
                className={cn(
                  'group flex h-8 min-w-[90px] max-w-[220px] flex-1 cursor-default items-center gap-1.5 rounded-lg border px-2.5 text-[13px]',
                  t.id === active ? 'border-[var(--border-strong)] bg-[var(--bg-card)] text-[var(--text)]' : 'border-transparent text-[var(--text-2)] hover:bg-[var(--bg-hover)]',
                )}
              >
                <I size={13} className="shrink-0" />
                <span className="truncate">{t.kind === 'web' ? t.url : titles[t.kind]}</span>
                <button onClick={(e) => { e.stopPropagation(); closeTab(t.id); }} className="ml-auto shrink-0 rounded text-[var(--text-3)] hover:text-[var(--text)]">
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
        <button onClick={addTab} className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)]"><Plus size={16} /></button>
        <div className="h-4 w-px bg-[var(--border-strong)]" />
        <button
          onClick={onToggleCover}
          title={cover ? '还原' : '覆盖聊天区域'}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
        >
          {cover ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
        <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--bg-active)] text-[var(--text)]"><PanelRight size={15} /></button>
      </div>

      {(cur.kind === 'new' || cur.kind === 'web') && (
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <div className="flex h-9 items-center rounded-full border border-[var(--border)] px-1 text-[var(--text-3)]">
            <button className="flex h-7 w-7 items-center justify-center rounded-full"><ArrowLeft size={14} /></button>
            <button className="flex h-7 w-7 items-center justify-center rounded-full"><ArrowRight size={14} /></button>
          </div>
          <button className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-hover)]"><RefreshCw size={14} /></button>
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) openTool('web', { url: url.trim() });
            }}
          >
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="搜索或输入网址"
              className="h-9 w-full rounded-full bg-[var(--bg-hover)] px-4 text-center text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:text-left"
            />
          </form>
          <button className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-hover)]"><MoreHorizontal size={15} /></button>
        </div>
      )}

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {cur.kind === 'new' && (
          <div className="px-5 pt-8">
            <div className="mb-3 text-[13px] font-medium text-[var(--text)]">工具</div>
            <div className="space-y-1.5">
              {tools.map(({ kind, label, key, Icon }) => (
                <button
                  key={kind}
                  onClick={() => openTool(kind)}
                  className="group flex h-10 w-full items-center gap-2.5 rounded-lg bg-[var(--bg-hover)] px-3 text-[13.5px] text-[var(--text)] hover:bg-[var(--bg-active)]"
                >
                  <Icon size={14} className="text-[var(--text-2)]" />
                  {label}
                  <span className="ml-auto"><Kbd>{key}</Kbd></span>
                </button>
              ))}
            </div>
          </div>
        )}
        {cur.kind === 'web' && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <Globe size={34} className="text-[var(--text-3)]" />
            <div className="text-[14px] text-[var(--text)]">{cur.url}</div>
            <div className="text-[12.5px] text-[var(--text-3)]">纯前端演示：桌面端将通过 WebView 渲染网页，供 Agent 浏览与操作。</div>
          </div>
        )}
        {cur.kind === 'diff' && <DiffView />}
        {cur.kind === 'terminal' && <TerminalView />}
        {cur.kind === 'files' && <FilesView />}
        {cur.kind === 'chat' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-[13px] text-[var(--text-3)]">
            <MessageCirclePlus size={30} />
            在不打断主任务的情况下提问
          </div>
        )}
      </div>
    </div>
  );
}
