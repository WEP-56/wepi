import { useState } from 'react';
import {
  House,
  Plug,
  Sparkles,
  Server,
  Boxes,
  Settings,
  Bell,
  Search,
  SquarePen,
  Folder,
  FolderOpen,
  FolderPlus,
  ChevronDown,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Pin,
  X,
} from 'lucide-react';
import type { Project, Thread } from '../data';
import { cn } from '../utils/cn';
import { AppIcon } from './ui';
import { RenameInput } from './kit';
import { ResizeHandle } from './Resizer';

export type ViewId = 'home' | 'settings' | 'mcp' | 'skills' | 'providers' | 'management';

export function Rail({
  view,
  onNavigate,
}: {
  view: ViewId;
  onNavigate: (v: ViewId) => void;
}) {
  const btn = (active: boolean) =>
    cn(
      'flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]',
      active && 'bg-[var(--bg-active)] text-[var(--text)]',
    );
  const items = [
    { id: 'home', label: '首页', Icon: House },
    { id: 'mcp', label: 'MCP 配置', Icon: Plug },
    { id: 'skills', label: 'Skill 配置', Icon: Sparkles },
    { id: 'providers', label: '提供商配置', Icon: Server },
  ] as const;
  return (
    <div className="flex w-[52px] shrink-0 flex-col items-center gap-2 bg-[var(--bg-app)] pb-3 pt-2">
      {items.map(({ id, label, Icon }) => (
        <button key={id} title={label} onClick={() => onNavigate(id)} className={btn(view === id)}>
          <Icon size={id === 'home' ? 18 : 17} fill={id === 'home' && view === 'home' ? 'currentColor' : 'none'} />
        </button>
      ))}
      <div className="my-1 h-px w-6 bg-[var(--border-strong)]" />
      <button title="Pi 高级管理" onClick={() => onNavigate('management')} className={btn(view === 'management')}>
        <Boxes size={17} />
      </button>
      <div className="flex-1" />
      <button title="设置" onClick={() => onNavigate('settings')} className={btn(view === 'settings')}>
        <Settings size={17} />
      </button>
    </div>
  );
}

const byPin = <T extends { pinned?: boolean }>(a: T[]) => [...a.filter((x) => x.pinned), ...a.filter((x) => !x.pinned)];

function ThreadRow({
  t,
  indent,
  active,
  renameMode,
  onOpen,
  onMenu,
  onRenameSubmit,
  onRenameCancel,
}: {
  t: Thread;
  indent?: boolean;
  active: boolean;
  renameMode: boolean;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  onRenameSubmit: (v: string) => void;
  onRenameCancel: () => void;
}) {
  const busy = t.messages.some((m) => m.streaming || m.thinking);
  if (renameMode)
    return (
      <div className={cn('flex py-0.5', indent && 'pl-6')}>
        <RenameInput initial={t.title} onSubmit={onRenameSubmit} onCancel={onRenameCancel} className="flex-1" />
      </div>
    );
  return (
    <div
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY);
      }}
      className={cn(
        'group/item flex cursor-default items-center rounded-lg py-[6px] pr-1.5 text-[13.5px] text-[var(--text)] hover:bg-[var(--bg-hover)]',
        indent ? 'pl-8' : 'pl-2',
        active && 'bg-[var(--bg-active)]',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{t.title}</span>
      {busy ? (
        <Loader2 size={12} className="ml-1 shrink-0 animate-spin text-[var(--blue)]" />
      ) : (
        t.unread && <span className="ml-1 h-2 w-2 shrink-0 rounded-full bg-[var(--blue)]" title="未读" />
      )}
      {t.pinned && <Pin size={12} className="ml-1.5 shrink-0 text-[var(--text-3)] group-hover/item:hidden" />}
      <button
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.left, r.bottom + 4);
        }}
        className="ml-1 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-2)] hover:text-[var(--text)] group-hover/item:flex"
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  );
}

export default function Sidebar({
  width,
  projects,
  threads,
  selectedProject,
  activeThreadId,
  expanded,
  renaming,
  onToggleExpand,
  onOpenThread,
  onNewChat,
  onNewChatIn,
  onCreateProject,
  onThreadMenu,
  onProjectMenu,
  onRenameSubmit,
  onRenameCancel,
  onStartResize,
  onToast,
}: {
  width: number;
  projects: Project[];
  threads: Thread[];
  selectedProject: string | null;
  activeThreadId: string | null;
  expanded: string[];
  renaming: { id: string; from: 'sidebar' | 'header' } | null;
  onToggleExpand: (id: string) => void;
  onOpenThread: (id: string) => void;
  onNewChat: () => void;
  onNewChatIn: (projectId: string) => void;
  onCreateProject: () => void;
  onThreadMenu: (t: Thread, x: number, y: number) => void;
  onProjectMenu: (p: Project, x: number, y: number) => void;
  onRenameSubmit: (id: string, title: string) => void;
  onRenameCancel: () => void;
  onStartResize: () => void;
  onToast: (s: string) => void;
}) {
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [recentOpen, setRecentOpen] = useState(true);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [moreProj, setMoreProj] = useState<string[]>([]);

  const alive = byPin(threads.filter((t) => !t.archived));
  const sortedProjects = byPin(projects);
  const shownProjects = showAllProjects ? sortedProjects : sortedProjects.slice(0, 5);
  const filtered = alive.filter((t) => !query || t.title.toLowerCase().includes(query.toLowerCase()));

  // 同一会话可能同时出现在「项目」与「最近」中，行内重命名只在第一处渲染
  let renameUsed = false;
  const takeRename = (id: string) => {
    if (renaming?.id === id && renaming.from === 'sidebar' && !renameUsed) {
      renameUsed = true;
      return true;
    }
    return false;
  };

  const row = (t: Thread, indent?: boolean) => (
    <ThreadRow
      key={t.id}
      t={t}
      indent={indent}
      active={activeThreadId === t.id}
      renameMode={takeRename(t.id)}
      onOpen={() => onOpenThread(t.id)}
      onMenu={(x, y) => onThreadMenu(t, x, y)}
      onRenameSubmit={(v) => onRenameSubmit(t.id, v)}
      onRenameCancel={onRenameCancel}
    />
  );

  return (
    <div style={{ width }} className="relative flex h-full shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-side)]">
      <ResizeHandle onStart={onStartResize} className="right-[-3px]" />

      <div className="flex items-center px-4 pb-2 pt-4">
        <div className="flex select-none items-center gap-2 text-[var(--text)]">
          <AppIcon size={22} />
          <span className="text-[17px] font-bold tracking-[0.14em]">WEPI</span>
        </div>
        <div className="flex-1" />
        <button
          title="通知"
          onClick={() => onToast('暂无新通知')}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
        >
          <Bell size={15} />
        </button>
        <button
          title="搜索聊天"
          onClick={() => {
            setSearching(!searching);
            setQuery('');
          }}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)]',
            searching && 'bg-[var(--bg-active)]',
          )}
        >
          <Search size={15} />
        </button>
      </div>

      {searching && (
        <div className="fade-in mx-2 mb-1 flex items-center gap-2 rounded-lg bg-[var(--bg-hover)] px-2.5 py-1.5">
          <Search size={14} className="text-[var(--text-3)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索聊天"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]"
          />
          <button
            onClick={() => {
              setSearching(false);
              setQuery('');
            }}
            className="text-[var(--text-3)] hover:text-[var(--text)]"
          >
            <X size={13} />
          </button>
        </div>
      )}

      <div className="px-2">
        <button
          onClick={onNewChat}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[14px] font-medium text-[var(--text)] hover:bg-[var(--bg-hover)]"
        >
          <SquarePen size={15} /> 新聊天
        </button>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto px-2 pb-3">
        {!searching && (
          <>
            <div className="mt-3 flex items-center px-2 py-1">
              <span className="text-[14px] font-medium text-[var(--text-2)]">项目</span>
              <div className="flex-1" />
              <button
                onClick={onCreateProject}
                title="新建项目"
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
              >
                <FolderPlus size={15} />
              </button>
            </div>

            {projects.length === 0 && (
              <button
                onClick={onCreateProject}
                className="w-full rounded-lg px-2 py-2 text-left text-[13px] text-[var(--text-3)] hover:bg-[var(--bg-hover)]"
              >
                还没有项目，点击新建
              </button>
            )}

            {shownProjects.map((p) => {
              const isOpen = expanded.includes(p.id);
              const pts = alive.filter((t) => t.projectId === p.id);
              const limit = moreProj.includes(p.id) ? pts.length : 5;
              return (
                <div key={p.id}>
                  <div
                    onClick={() => onToggleExpand(p.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onProjectMenu(p, e.clientX, e.clientY);
                    }}
                    title={p.path}
                    className={cn(
                      'group/proj flex cursor-default items-center gap-2 rounded-lg px-2 py-[6px] text-[13.5px] text-[var(--text)] hover:bg-[var(--bg-hover)]',
                      selectedProject === p.id && !activeThreadId && 'bg-[var(--bg-active)]',
                    )}
                  >
                    {isOpen ? (
                      <FolderOpen size={15} className="shrink-0 text-[var(--text-2)]" />
                    ) : (
                      <Folder size={15} className="shrink-0 text-[var(--text-2)]" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {p.pinned && <Pin size={12} className="shrink-0 text-[var(--text-3)] group-hover/proj:hidden" />}
                    <div className="hidden shrink-0 items-center group-hover/proj:flex">
                      <button
                        title="更多"
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = e.currentTarget.getBoundingClientRect();
                          onProjectMenu(p, r.left, r.bottom + 4);
                        }}
                        className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-2)] hover:text-[var(--text)]"
                      >
                        <MoreHorizontal size={14} />
                      </button>
                      <button
                        title="在此项目中新建聊天"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewChatIn(p.id);
                        }}
                        className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-2)] hover:text-[var(--text)]"
                      >
                        <SquarePen size={13} />
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="fade-in">
                      {pts.length === 0 ? (
                        <div className="py-1.5 pl-8 text-[12.5px] text-[var(--text-3)]">暂无聊天</div>
                      ) : (
                        pts.slice(0, limit).map((t) => row(t, true))
                      )}
                      {pts.length > 5 && (
                        <button
                          onClick={() =>
                            setMoreProj((m) => (m.includes(p.id) ? m.filter((x) => x !== p.id) : [...m, p.id]))
                          }
                          className="w-full rounded-lg py-1 pl-8 text-left text-[12.5px] text-[var(--text-3)] hover:bg-[var(--bg-hover)]"
                        >
                          {moreProj.includes(p.id) ? '收起' : `显示更多（${pts.length - 5}）`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {projects.length > 5 && (
              <button
                onClick={() => setShowAllProjects(!showAllProjects)}
                className="w-full rounded-lg px-2 py-[6px] text-left text-[13.5px] text-[var(--text-3)] hover:bg-[var(--bg-hover)]"
              >
                {showAllProjects ? '收起显示' : '展开显示'}
              </button>
            )}
          </>
        )}

        <div className="group mt-4 flex items-center px-2 py-1">
          <button
            onClick={() => setRecentOpen(!recentOpen)}
            className="flex items-center gap-1 text-[14px] font-medium text-[var(--text-2)]"
          >
            {searching ? '搜索结果' : '最近'}
            {!searching && (recentOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
          </button>
          <div className="flex-1" />
          {!searching && recentOpen && (
            <div className="hidden items-center group-hover:flex">
              <button
                onClick={onNewChat}
                title="新聊天"
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
              >
                <SquarePen size={13} />
              </button>
            </div>
          )}
        </div>
        {(recentOpen || searching) && (
          <div className="fade-in">
            {filtered.length === 0 && <div className="px-2 py-2 text-[13px] text-[var(--text-3)]">没有匹配的聊天</div>}
            {filtered.map((t) => row(t))}
          </div>
        )}
      </div>
    </div>
  );
}
