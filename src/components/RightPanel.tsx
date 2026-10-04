import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileDiff,
  Files,
  Folder,
  GitBranch,
  Globe,
  Maximize2,
  Minimize2,
  Minus,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  X,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { parsePatch } from 'diff';
import { IconBtn, Kbd, MenuItem, Popover } from './ui';
import { ResizeHandle } from './Resizer';
import { cn } from '../utils/cn';
import {
  errorText,
  workspace,
  type FileEntry,
  type FilePreview,
  type PanelTarget,
  type Review,
  type TabKind,
} from '../lib/workspace';
import { isDesktopRuntime } from '../lib/piRpc';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export type { TabKind } from '../lib/workspace';

interface Tab {
  id: string;
  kind: TabKind;
  path?: string;
  url?: string;
  reviewId?: string;
  line?: number;
}

const titles: Record<TabKind, string> = { new: '新标签页', files: '文件', diff: '变更', terminal: '终端', web: '网页' };
const icons: Record<TabKind, typeof Globe> = { new: Globe, files: Files, diff: FileDiff, terminal: SquareTerminal, web: Globe };
const tools: { kind: TabKind; label: string; key: string; Icon: typeof Globe }[] = [
  { kind: 'diff', label: '变更', key: 'Ctrl+Shift+G', Icon: FileDiff },
  { kind: 'files', label: '文件', key: 'Ctrl+P', Icon: Files },
  { kind: 'terminal', label: '终端', key: 'Ctrl+`', Icon: SquareTerminal },
  { kind: 'web', label: '网页', key: 'Ctrl+L', Icon: Globe },
];
const actionClass =
  'flex h-7 shrink-0 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-hover)] px-2 text-[12px] text-[var(--text)] transition-colors hover:bg-[var(--bg-active)] disabled:opacity-40';

let sequence = 1;
const basename = (value: string) => value.split(/[\\/]/).pop() || value;

/**
 * 文件树排序：先按路径逐段比较（父目录一定排在子节点前面，子节点紧跟自己父目录），
 * 同一层级的兄弟再按「目录在前、名称升序」排列。
 * 之前按「是否目录 + 名称」整体排序，展开出来的文件会被排到树的其它位置。
 */
function compareEntries(left: FileEntry, right: FileEntry) {
  const a = left.path.split('/');
  const b = right.path.split('/');
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (a[index] === b[index]) continue;
    // 层级中还有后续片段（或条目本身就是目录）说明这一段是目录，目录排在文件前面。
    const aDirectory = index < a.length - 1 || left.directory;
    const bDirectory = index < b.length - 1 || right.directory;
    if (aDirectory !== bDirectory) return aDirectory ? -1 : 1;
    return a[index].localeCompare(b[index], 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  }
  // 前缀相同：祖先（路径更短）排在子节点前面。
  return a.length - b.length;
}

function FileTree({ root, selected, onOpen }: { root: string; selected?: string; onOpen: (entry: FileEntry) => void }) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(
    async (path: string) => {
      try {
        const next = await workspace<FileEntry[]>('list', root, { path });
        setEntries((old) => [...old.filter((entry) => entry.path.split('/').slice(0, -1).join('/') !== path), ...next]);
        setError('');
      } catch (cause) {
        setError(errorText(cause));
      }
    },
    [root],
  );

  useEffect(() => {
    setEntries([]);
    setExpanded(new Set(['']));
    if (root) void load('');
  }, [root, load]);

  const visible = useMemo(
    () =>
      entries
        .filter((entry) => {
          if (filter && !entry.path.toLowerCase().includes(filter.toLowerCase())) return false;
          const parts = entry.path.split('/');
          return parts.length === 1 || parts.slice(0, -1).every((_, index) => expanded.has(parts.slice(0, index + 1).join('/')));
        })
        .sort(compareEntries),
    [entries, expanded, filter],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 p-2">
        <div className="flex h-9 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-hover)] px-2.5">
          <Search size={14} className="shrink-0 text-[var(--text-3)]" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="筛选文件..."
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--text-3)]"
          />
          {filter && (
            <button title="清空筛选" onClick={() => setFilter('')} className="shrink-0 text-[var(--text-3)] hover:text-[var(--text)]">
              <X size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pb-2">
        {error && <div className="px-2 py-2 text-[12px] text-[#f85149]">{error}</div>}
        {!root && <div className="p-4 text-center text-[13px] text-[var(--text-3)]">请先选择工作区</div>}
        {visible.map((entry) => (
          <div
            key={entry.path}
            title={entry.path}
            onClick={() => {
              if (!entry.directory) {
                onOpen(entry);
                return;
              }
              const next = new Set(expanded);
              if (next.has(entry.path)) next.delete(entry.path);
              else {
                next.add(entry.path);
                void load(entry.path);
              }
              setExpanded(next);
            }}
            className={cn(
              'flex h-7 cursor-default items-center gap-1 rounded px-2 text-[13px] hover:bg-[var(--bg-hover)]',
              selected === entry.path && 'bg-[var(--bg-active)] text-[var(--blue)]',
            )}
            style={{ paddingLeft: 8 + (entry.path.split('/').length - 1) * 14 }}
          >
            {entry.directory ? (
              expanded.has(entry.path) ? (
                <ChevronDown size={13} className="shrink-0" />
              ) : (
                <ChevronRight size={13} className="shrink-0" />
              )
            ) : (
              <span className="w-[13px] shrink-0" />
            )}
            {entry.directory ? (
              <Folder size={14} className="shrink-0 text-[#c6a15b]" />
            ) : (
              <FileCode2 size={14} className="shrink-0 text-[var(--text-2)]" />
            )}
            <span className="truncate">{entry.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Preview({ value, line }: { value: FilePreview | null; line?: number }) {
  if (!value)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[13px] text-[var(--text-3)]">
        从右侧文件树中选择文件进行预览
      </div>
    );
  if (value.kind === 'image')
    return (
      <div className="scroll-thin flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img src={value.content} alt={value.path} className="max-h-full max-w-full object-contain" />
      </div>
    );
  if (value.kind !== 'text')
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[13px] text-[var(--text-3)]">
        二进制文件，请使用系统应用打开
      </div>
    );
  const focus = Math.max(0, (line ?? 1) - 1);
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-auto">
      <div className="min-w-max py-2 font-mono text-[12px] leading-5 text-[var(--text-2)]">
        {value.content.split('\n').map((text, index) => (
          <div key={index} className={cn('flex', index === focus && 'bg-[#3b8bf6]/15')}>
            <span className="sticky left-0 z-10 w-10 shrink-0 select-none bg-[var(--bg-main)] pr-2 text-right text-[11px] text-[var(--text-3)]">
              {index + 1}
            </span>
            <span className="whitespace-pre pl-3 pr-4">{text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilesView({ root, tab, onTarget }: { root: string; tab: Tab; onTarget: (target: PanelTarget) => void }) {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [selected, setSelected] = useState<string | undefined>(tab.path);
  const [error, setError] = useState('');
  const loaded = useRef<string | undefined>(undefined);

  const relativePath = useCallback(
    (path: string) => {
      const cleanRoot = root.replace(/[\\/]$/, '');
      const lower = path.toLowerCase();
      const prefix = cleanRoot.toLowerCase();
      return lower.startsWith(`${prefix}/`) || lower.startsWith(`${prefix}\\`)
        ? path.slice(cleanRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
        : path;
    },
    [root],
  );

  const open = useCallback(
    async (entry: FileEntry) => {
      const path = relativePath(entry.path);
      setSelected(entry.path);
      loaded.current = path;
      try {
        const next = await workspace<FilePreview>('read', root, { path });
        setPreview(next);
        setSelected(next.path);
        setError('');
        onTarget({ kind: 'files', path: entry.path, line: tab.line, n: Date.now() });
      } catch (cause) {
        setPreview(null);
        setError(errorText(cause));
      }
    },
    [onTarget, relativePath, root, tab.line],
  );

  // 会话里的文件链接（可能带 :行号）打开时同步预览；这里不再创建新标签页。
  useEffect(() => {
    if (!root || !tab.path) return;
    const path = relativePath(tab.path);
    if (loaded.current === path) return;
    loaded.current = path;
    void workspace<FilePreview>('read', root, { path })
      .then((next) => {
        setPreview(next);
        setSelected(next.path);
        setError('');
      })
      .catch((cause) => {
        setPreview(null);
        setError(errorText(cause));
      });
  }, [relativePath, root, tab.path]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-r border-[var(--border)]">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 text-[12px] text-[var(--text-2)]">
          <Files size={14} className="shrink-0" />
          <span className="truncate" title={selected}>
            {selected ?? '工作区文件'}
          </span>
        </div>
        {error && <div className="shrink-0 px-3 py-2 text-[12px] text-[#f85149]">{error}</div>}
        <Preview value={preview} line={tab.line} />
      </div>
      <div className="flex min-h-0 w-[42%] min-w-[168px] max-w-[62%] shrink-0 flex-col overflow-hidden">
        <FileTree root={root} selected={selected} onOpen={open} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 变更：可展开 / 收起的 diff 列表                                      */
/* ------------------------------------------------------------------ */

type Scope = 'working' | 'staged' | 'branch' | 'turn';

const scopes: { value: Scope; label: string }[] = [
  { value: 'working', label: '工作区' },
  { value: 'staged', label: '暂存' },
  { value: 'branch', label: '分支' },
  { value: 'turn', label: '上一轮' },
];
/** 默认只取变更点附近的上下文，展开时再向 Git 要更多（见 workspace.rs 的 context 参数）。 */
const CONTEXT_LINES = 3;
/** 与 workspace.rs 里的 clamp 保持一致。 */
const MAX_CONTEXT = 400;

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  header: string;
}

interface PatchState {
  text: string;
  context: number;
  binary: boolean;
}

type DiffRow =
  | { kind: 'head'; key: string; text: string }
  | { kind: 'line'; key: string; type: '+' | '-' | ' '; text: string; old?: number; new?: number }
  | { kind: 'gap'; key: string; count: number };

function parseHunks(text: string): Hunk[] {
  const parsed = parsePatch(text);
  const headers = text
    .split('\n')
    .filter((line) => line.startsWith('@@'))
    .map((line) => line.trimEnd());
  return (parsed[0]?.hunks ?? []).map((hunk, index) => ({
    ...hunk,
    header: headers[index] ?? `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
  }));
}

function buildDiffRows(hunks: Hunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let cursor = 1;
  hunks.forEach((hunk, index) => {
    rows.push({ kind: 'head', key: `head-${index}`, text: hunk.header });
    const leading = hunk.newStart - cursor;
    if (leading > 0) rows.push({ kind: 'gap', key: `gap-${index}`, count: leading });
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    for (const raw of hunk.lines) {
      // `\ No newline at end of file` 只是标记，不占行号。
      if (raw.startsWith('\\')) continue;
      const marker = raw.slice(0, 1);
      const value = raw.slice(1).replace(/\r$/, '');
      if (marker === '+') {
        rows.push({ kind: 'line', key: `a${newNo}`, type: '+', text: value, new: newNo });
        newNo += 1;
      } else if (marker === '-') {
        rows.push({ kind: 'line', key: `d${oldNo}`, type: '-', text: value, old: oldNo });
        oldNo += 1;
      } else {
        rows.push({ kind: 'line', key: `c${newNo}`, type: ' ', text: value, old: oldNo, new: newNo });
        oldNo += 1;
        newNo += 1;
      }
    }
    cursor = hunk.newStart + hunk.newLines;
  });
  return rows;
}

function DiffLineRow({ row }: { row: Extract<DiffRow, { kind: 'line' }> }) {
  const added = row.type === '+';
  const removed = row.type === '-';
  return (
    <div className={cn('flex', added && 'bg-[#3fb950]/12', removed && 'bg-[#f85149]/12')}>
      <span className="sticky left-0 z-10 w-11 shrink-0 select-none bg-[#171717] pr-2 text-right text-[10.5px] text-[var(--text-3)]">
        {row.old ?? ''}
      </span>
      <span className="sticky left-11 z-10 w-11 shrink-0 select-none border-r border-[var(--border)] bg-[#171717] pr-2 text-right text-[10.5px] text-[var(--text-3)]">
        {row.new ?? ''}
      </span>
      <span className={cn('w-5 shrink-0 select-none text-center', added ? 'text-[#3fb950]' : removed ? 'text-[#f85149]' : 'text-[var(--text-3)]')}>
        {added ? '+' : removed ? '-' : ' '}
      </span>
      <span className={cn('whitespace-pre pr-4', added ? 'text-[#7ee787]' : removed ? 'text-[#ffa198]' : 'text-[var(--text-2)]')}>
        {row.text || ' '}
      </span>
    </div>
  );
}

function DiffBody({ state, onGrow }: { state?: PatchState; onGrow: (count: number) => void }) {
  const hunks = useMemo(() => {
    if (!state?.text) return [] as Hunk[];
    try {
      return parseHunks(state.text);
    } catch {
      return [] as Hunk[];
    }
  }, [state?.text]);

  if (!state) return <div className="px-3 py-3 text-[12px] text-[var(--text-3)]">正在读取差异…</div>;
  if (state.binary) return <div className="px-3 py-3 text-[12px] text-[var(--text-3)]">二进制文件，无法显示文本差异。</div>;
  if (!hunks.length)
    return <div className="px-3 py-3 text-[12px] text-[var(--text-3)]">{state.text ? '没有可显示的文本差异。' : '没有差异内容。'}</div>;

  const rows = buildDiffRows(hunks);
  return (
    <div className="scroll-thin max-h-[52vh] min-h-0 overflow-auto border-t border-[var(--border)] bg-[#171717]">
      <div className="min-w-max font-mono text-[11.5px] leading-[19px]">
        {rows.map((row) => {
          if (row.kind === 'head')
            return (
              <div key={row.key} className="flex items-center justify-end bg-[var(--bg-hover)] px-3 py-[3px] text-[10.5px] text-[var(--text-3)]">
                <span className="truncate">{row.text}</span>
              </div>
            );
          if (row.kind === 'gap')
            return (
              <div key={row.key} className="flex h-7 items-center gap-2 border-y border-[var(--border)] bg-[var(--bg-hover)] px-2 font-sans text-[11.5px] text-[var(--text-3)]">
                <span className="truncate">⋯ {row.count} 行未修改</span>
                <button
                  title="展开这段未修改的代码"
                  onClick={() => onGrow(row.count)}
                  className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--bg-active)] hover:text-[var(--text)]"
                >
                  <ChevronDown size={12} />
                  展开
                </button>
              </div>
            );
          return <DiffLineRow key={row.key} row={row} />;
        })}
      </div>
    </div>
  );
}

function DiffView({ root, tab }: { root: string; tab: Tab }) {
  const [scope, setScope] = useState<Scope>('working');
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [patches, setPatches] = useState<Record<string, PatchState>>({});
  const [contexts, setContexts] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    if (!root) return;
    setBusy(true);
    try {
      const next = await workspace<Review>('review', root, { scope, id: tab.reviewId });
      setReview(next);
      setError('');
    } catch (cause) {
      setReview(null);
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }, [root, scope, tab.reviewId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 换个范围，之前缓存的差异内容就不再适用。
  useEffect(() => {
    setPatches({});
    setFailed({});
  }, [scope, root]);

  const loadPatch = useCallback(
    async (file: string, context: number) => {
      const id = `${scope}:${file}`;
      try {
        const value = await workspace<{ patch: string; binary: boolean }>('diff', root, {
          scope,
          path: file,
          id: tab.reviewId,
          base: review?.base,
          context,
        });
        setPatches((old) => ({ ...old, [id]: { text: value.patch, context, binary: value.binary } }));
      } catch (cause) {
        setError(errorText(cause));
        setFailed((old) => ({ ...old, [id]: true }));
      }
    },
    [root, scope, tab.reviewId, review?.base],
  );

  useEffect(() => {
    for (const file of open) {
      const id = `${scope}:${file}`;
      if (!patches[id] && !failed[id]) void loadPatch(file, contexts[file] ?? CONTEXT_LINES);
    }
  }, [open, patches, failed, contexts, scope, loadPatch]);

  const forget = (id: string) => {
    setPatches((old) => Object.fromEntries(Object.entries(old).filter(([key]) => key !== id)));
  };

  const toggle = (file: string) => {
    const id = `${scope}:${file}`;
    const next = new Set(open);
    if (next.has(file)) {
      next.delete(file);
      // 收起时丢掉放大的上下文，重新展开回到紧凑视图。
      setContexts((value) => ({ ...value, [file]: CONTEXT_LINES }));
      forget(id);
    } else {
      next.add(file);
    }
    setOpen(next);
  };

  const grow = (file: string, count: number) => {
    const id = `${scope}:${file}`;
    const next = Math.min((contexts[file] ?? CONTEXT_LINES) + count + 8, MAX_CONTEXT);
    setContexts((old) => ({ ...old, [file]: next }));
    setFailed((old) => Object.fromEntries(Object.entries(old).filter(([key]) => key !== id)));
    void loadPatch(file, next);
  };

  const reload = () => {
    setPatches({});
    setFailed({});
    void load();
  };

  const gitAction = async (action: 'stage' | 'unstage' | 'commit' | 'turn_undo', file?: string) => {
    setBusy(true);
    try {
      if (action === 'commit') {
        const message = window.prompt('提交说明');
        if (!message?.trim()) return;
        await workspace(action, root, { message });
      } else if (action === 'turn_undo') {
        await workspace(action, root, { id: tab.reviewId });
      } else {
        await workspace(action, root, { path: file });
      }
      setPatches({});
      setFailed({});
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const files = review?.files ?? [];
  const totals = files.reduce((sum, change) => ({ add: sum.add + change.add, del: sum.del + change.del }), { add: 0, del: 0 });
  const options = tab.reviewId ? scopes : scopes.filter((item) => item.value !== 'turn');
  const label = scopes.find((item) => item.value === scope)?.label ?? scope;
  const branch = review ? `${review.branch}${review.upstream ? ` → ${review.upstream}` : ''}` : '未连接 Git';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2">
        <Popover
          width={156}
          trigger={(opened, toggleMenu) => (
            <button onClick={toggleMenu} className={cn(actionClass, 'gap-1.5')} title="选择变更范围">
              <GitBranch size={13} className="text-[var(--text-2)]" />
              {label}
              <ChevronDown size={13} className={cn('text-[var(--text-3)] transition-transform', opened && 'rotate-180')} />
            </button>
          )}
        >
          {(close) =>
            options.map((item) => (
              <MenuItem
                key={item.value}
                selected={item.value === scope}
                onClick={() => {
                  setScope(item.value);
                  close();
                }}
              >
                {item.label}
              </MenuItem>
            ))
          }
        </Popover>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-3)]" title={`${branch} · 领先 ${review?.ahead ?? 0} 落后 ${review?.behind ?? 0}`}>
          {branch}
        </span>
        <span className="flex shrink-0 items-center gap-1 font-mono text-[11.5px]">
          <span className="text-[#3fb950]">+{totals.add}</span>
          <span className="text-[#f85149]">-{totals.del}</span>
        </span>
        {scope === 'staged' && (
          <button className={actionClass} disabled={busy || !files.length} onClick={() => void gitAction('commit')}>
            提交
          </button>
        )}
        {scope === 'turn' && (
          <button className={actionClass} disabled={busy} onClick={() => void gitAction('turn_undo')} title="撤销这一轮的改动">
            撤销
          </button>
        )}
        <IconBtn title="刷新" onClick={reload}>
          <RefreshCw size={14} className={busy ? 'animate-spin' : undefined} />
        </IconBtn>
      </div>
      {error && <div className="shrink-0 px-3 py-2 text-[12px] text-[#f85149]">{error}</div>}
      {review?.undone && <div className="shrink-0 px-3 py-1.5 text-[11.5px] text-[var(--text-3)]">这一轮的改动已经撤销</div>}
      <div className="scroll-thin min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        {!root && <div className="p-5 text-center text-[12.5px] text-[var(--text-3)]">请先选择工作区</div>}
        {root && review && !files.length && <div className="p-6 text-center text-[12.5px] text-[var(--text-3)]">该范围没有文件变更</div>}
        {files.map((change) => {
          const id = `${scope}:${change.file}`;
          const opened = open.has(change.file);
          return (
            <div key={change.file} className="border-b border-[var(--border)]">
              <div className={cn('group flex items-center gap-1.5 py-1.5 pl-2 pr-2 hover:bg-[var(--bg-hover)]', opened && 'bg-[var(--bg-hover)]')}>
                <button onClick={() => toggle(change.file)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                  {opened ? (
                    <ChevronDown size={13} className="shrink-0 text-[var(--text-3)]" />
                  ) : (
                    <ChevronRight size={13} className="shrink-0 text-[var(--text-3)]" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12.5px]" title={change.file}>
                    {change.file}
                  </span>
                </button>
                <span className="shrink-0 font-mono text-[11.5px] text-[#3fb950]">+{change.add}</span>
                <span className="shrink-0 font-mono text-[11.5px] text-[#f85149]">-{change.del}</span>
                {scope !== 'turn' && (
                  <IconBtn
                    className="h-6 w-6 opacity-0 group-hover:opacity-100"
                    title={scope === 'staged' ? '取消暂存' : '暂存'}
                    onClick={() => void gitAction(scope === 'staged' ? 'unstage' : 'stage', change.file)}
                  >
                    {scope === 'staged' ? <Minus size={13} /> : <Plus size={13} />}
                  </IconBtn>
                )}
              </div>
              {opened && <DiffBody state={patches[id]} onGrow={(count) => grow(change.file, count)} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 终端                                                                */
/* ------------------------------------------------------------------ */

function TerminalView({ root, id }: { root: string; id: string }) {
  const node = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const host = node.current;
    if (!host || !isDesktopRuntime()) return;
    const terminal = new Terminal({
      theme: { background: '#181818', foreground: '#ececec', cursor: '#ececec' },
      fontSize: 12,
      convertEol: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);

    let frame = 0;
    let started = false;
    const measure = () => {
      frame = 0;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (!started) {
        started = true;
        void invoke('terminal_start', { id, root, cols: terminal.cols, rows: terminal.rows }).catch((cause) => {
          setError(errorText(cause));
          terminal.writeln(`\r\n终端启动失败：${errorText(cause)}`);
        });
        return;
      }
      void invoke('terminal_resize', { id, cols: terminal.cols, rows: terminal.rows }).catch(() => {});
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    // 等面板完成一次布局再测量；否则 xterm 会按 0 宽度摊平，只剩一条窄缝。
    schedule();

    const data = terminal.onData((value) => {
      void invoke('terminal_write', { id, data: value });
    });
    let stop: UnlistenFn | undefined;
    void listen<{ id: string; data?: string; exit?: number }>('workspace-terminal', (event) => {
      if (event.payload.id !== id) return;
      if (event.payload.data) terminal.write(Uint8Array.from(atob(event.payload.data), (char) => char.charCodeAt(0)));
      if (event.payload.exit !== undefined) {
        terminal.writeln(`\r\n[进程已退出: ${event.payload.exit}]`);
        setRunning(false);
      }
    }).then((value) => {
      stop = value;
    });

    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      stop?.();
      data.dispose();
      observer.disconnect();
      terminal.dispose();
      void invoke('terminal_close', { id }).catch(() => {});
    };
  }, [id, root]);

  if (!isDesktopRuntime())
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-[13px] text-[var(--text-3)]">
        浏览器预览模式不提供本地终端，请运行桌面端。
      </div>
    );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[#181818]">
      <div ref={node} className="min-h-0 min-w-0 flex-1 overflow-hidden px-1 pt-1" />
      {(!running || error) && (
        <div className="flex h-6 shrink-0 items-center gap-2 border-t border-[var(--border)] px-2 text-[11px] text-[var(--text-3)]">
          <span className="truncate">{error || '进程已退出'}</span>
        </div>
      )}
    </div>
  );
}
/* ------------------------------------------------------------------ */
/* 网页                                                                */
/* ------------------------------------------------------------------ */

function WebView({ tab, onUrl }: { tab: Tab; onUrl: (url: string) => void }) {
  const [url, setUrl] = useState(tab.url ?? '');
  const [loading, setLoading] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const id = `browser-${tab.id}`;

  const navigate = async () => {
    let value = url.trim();
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 HTTP 和 HTTPS 网页');
      setUrl(value);
      onUrl(value);
      setLoading(true);
      if (isDesktopRuntime()) await invoke('browser_control', { id, action: 'navigate', args: { url: value } });
    } catch (cause) {
      setUrl(errorText(cause));
    }
  };

  const bounds = useCallback(() => {
    const rect = content.current?.getBoundingClientRect();
    if (!rect || !isDesktopRuntime()) return;
    void invoke('browser_control', { id, action: 'bounds', args: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } });
  }, [id]);

  useEffect(() => {
    if (!isDesktopRuntime() || !tab.url || !content.current) return;
    const rect = content.current.getBoundingClientRect();
    void invoke('browser_control', {
      id,
      action: 'create',
      args: { url: tab.url, x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    }).catch(() => {});
    const observer = new ResizeObserver(bounds);
    observer.observe(content.current);
    window.addEventListener('resize', bounds);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', bounds);
      void invoke('browser_control', { id, action: 'close', args: {} }).catch(() => {});
    };
  }, [id, tab.url, bounds]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border)] px-2 pb-2">
        <IconBtn title="后退" className="shrink-0" onClick={() => void invoke('browser_control', { id, action: 'back', args: {} }).catch(() => {})}>
          <ArrowLeft size={14} />
        </IconBtn>
        <IconBtn title="前进" className="shrink-0" onClick={() => void invoke('browser_control', { id, action: 'forward', args: {} }).catch(() => {})}>
          <ArrowRight size={14} />
        </IconBtn>
        <form
          className="flex min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            void navigate();
          }}
        >
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="搜索或输入网址"
            className="h-8 w-full rounded-full bg-[var(--bg-hover)] px-3 text-[12px] outline-none"
          />
        </form>
        <IconBtn title="刷新" className="shrink-0" onClick={() => void navigate()}>
          <RefreshCw size={13} />
        </IconBtn>
      </div>
      {isDesktopRuntime() ? (
        <div ref={content} className="flex min-h-0 min-w-0 flex-1 items-center justify-center text-[12px] text-[var(--text-3)]">
          {loading ? '网页加载中…' : '在内置 WebView 中打开网页'}
        </div>
      ) : tab.url ? (
        <iframe ref={frame} title="内置网页" src={tab.url} onLoad={() => setLoading(false)} className="min-h-0 min-w-0 flex-1 border-0 bg-white" sandbox="allow-forms allow-modals allow-popups allow-scripts" />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 text-[13px] text-[var(--text-3)]">
          <Globe size={30} />
          输入网址后打开网页
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 侧边面板                                                            */
/* ------------------------------------------------------------------ */

export default function RightPanel({
  onClose,
  openKind,
  width,
  cover,
  onStartDrag,
  onToggleCover,
  workspaceRoot,
  target,
}: {
  onClose: () => void;
  openKind: { kind: TabKind; n: number; reviewId?: string } | null;
  width: number;
  cover: boolean;
  onStartDrag: () => void;
  onToggleCover: () => void;
  workspaceRoot?: string;
  target?: PanelTarget | null;
}) {
  const [tabs, setTabs] = useState<Tab[]>([{ id: 't0', kind: 'new' }]);
  const [active, setActive] = useState('t0');
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];

  const open = useCallback((kind: TabKind, data: Partial<Tab> = {}) => {
    const id = `t${sequence++}`;
    setTabs((old) => [...old, { id, kind, ...data }]);
    setActive(id);
  }, []);

  useEffect(() => {
    if (openKind) open(openKind.kind, { path: target?.path, url: target?.url, reviewId: openKind.reviewId ?? target?.reviewId, line: target?.line });
  }, [openKind?.n, open]);

  useEffect(() => {
    if (target) open(target.kind, { path: target.path, url: target.url, line: target.line, reviewId: target.reviewId });
  }, [target?.n, open]);

  const close = (id: string) => {
    const rest = tabs.filter((tab) => tab.id !== id);
    if (!rest.length) return onClose();
    setTabs(rest);
    if (active === id) setActive(rest[rest.length - 1].id);
  };

  const update = (id: string, patch: Partial<Tab>) => setTabs((old) => old.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));

  return (
    <div
      style={cover ? undefined : { width }}
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--bg-main)]',
        cover ? 'absolute inset-0 z-20' : 'relative shrink-0',
      )}
    >
      <ResizeHandle onStart={onStartDrag} className={cover ? 'left-0' : 'left-[-3px]'} />
      <div className="flex h-[52px] shrink-0 items-center gap-1 px-2">
        <div className="scroll-thin flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = icons[tab.kind];
            const name = tab.kind === 'files' && tab.path ? basename(tab.path) : tab.kind === 'web' && tab.url ? tab.url : titles[tab.kind];
            return (
              <div
                key={tab.id}
                onClick={() => setActive(tab.id)}
                title={name}
                className={cn(
                  'group flex h-8 min-w-[92px] max-w-[200px] flex-1 items-center gap-1.5 rounded-lg border px-2.5 text-[13px]',
                  tab.id === active
                    ? 'border-[var(--border-strong)] bg-[var(--bg-card)] text-[var(--text)]'
                    : 'border-transparent text-[var(--text-2)] hover:bg-[var(--bg-hover)]',
                )}
              >
                <Icon size={13} className="shrink-0" />
                <span className="truncate">{name}</span>
                <button aria-label="关闭标签" onClick={(event) => { event.stopPropagation(); close(tab.id); }} className="ml-auto shrink-0 text-[var(--text-3)] hover:text-[var(--text)]">
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
        <IconBtn title="新建标签页" onClick={() => open('new')}>
          <Plus size={16} />
        </IconBtn>
        <IconBtn title={cover ? '还原' : '最大化'} onClick={onToggleCover}>
          {cover ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </IconBtn>
        <IconBtn title="关闭侧边面板" active onClick={onClose}>
          <PanelRight size={15} />
        </IconBtn>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {current.kind === 'new' && (
          <div className="scroll-thin min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="px-4 pt-7">
              <div className="mb-3 text-[13px] font-medium text-[var(--text)]">工具</div>
              <div className="grid grid-cols-2 gap-2">
                {tools.map(({ kind, label, key, Icon }) => (
                  <button
                    key={kind}
                    onClick={() => open(kind)}
                    className="flex h-[62px] min-w-0 flex-col justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-2.5 text-left text-[13px] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]"
                  >
                    <Icon size={15} className="shrink-0 text-[var(--text-2)]" />
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{label}</span>
                      <span className="ml-auto shrink-0">
                        <Kbd>{key}</Kbd>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {current.kind === 'files' && (
          <FilesView root={workspaceRoot ?? ''} tab={current} onTarget={(next) => update(current.id, { path: next.path, line: next.line })} />
        )}
        {current.kind === 'diff' && <DiffView root={workspaceRoot ?? ''} tab={current} />}
        {current.kind === 'terminal' && <TerminalView root={workspaceRoot ?? ''} id={`term-${current.id}`} />}
        {current.kind === 'web' && <WebView tab={current} onUrl={(url) => update(current.id, { url })} />}
      </div>
    </div>
  );
}
