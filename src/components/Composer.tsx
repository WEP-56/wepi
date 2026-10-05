import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  CircleAlert,
  ChevronDown,
  ArrowUp,
  Square,
  Folder,
  Laptop,
  GitBranch,
  Check,
  Paperclip,
  Image,
  FileText,
  X,
  Cloud,
  Search,
  Clock,
  CornerUpLeft,
  Undo2,
} from 'lucide-react';
import { uid, type Attachment, type ComposerDraft, type ModelOption, type PendingSend, type Project, type ReasoningEffort } from '../data';
import {
  attachmentFromFile,
  attachmentFromPath,
  attachmentsFromClipboard,
  ensureAttachmentPaths,
  pickAttachments,
} from '../lib/attachments';
import { pickDirectory } from '../lib/fs';
import { activeSlashQuery, filterCommands, type SlashCommand } from '../lib/slashCommands';
import { Popover, MenuItem } from './ui';
import { AttachmentThumb, ImageViewer } from './Attachments';
import { SlashMenu } from './SlashMenu';
import ModelEffortPanel, { effortLabel } from './ModelEffortPanel';
import ContextUsage, { type UsageSnapshot } from './ContextUsage';
import { cn } from '../utils/cn';

export interface ComposerSettings {
  model: string;
  effort: ReasoningEffort;
  access: string;
}

function ProjectPicker({
  projects,
  project,
  onSelect,
  onCreate,
  close,
}: {
  projects: Project[];
  project: Project | null;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  close: () => void;
}) {
  const [q, setQ] = useState('');
  const list = projects.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="mx-1 mb-1 mt-0.5 flex items-center gap-2 border-b border-[var(--border)] px-2 pb-2 pt-1.5">
        <Search size={14} className="shrink-0 text-[var(--text-3)]" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索项目"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]"
        />
      </div>
      <div className="scroll-thin max-h-[190px] overflow-y-auto">
        {list.length === 0 && <div className="px-2.5 py-2 text-[12.5px] text-[var(--text-3)]">没有匹配的项目</div>}
        {list.map((p) => (
          <MenuItem
            key={p.id}
            icon={<Folder size={14} />}
            right={project?.id === p.id ? <Check size={14} className="text-[var(--text)]" /> : undefined}
            selected={project?.id === p.id}
            onClick={() => {
              onSelect(p.id);
              close();
            }}
          >
            {p.name}
          </MenuItem>
        ))}
      </div>
      <div className="mx-2 my-1 h-px bg-[var(--border)]" />
      <MenuItem
        icon={<Plus size={14} />}
        onClick={() => {
          close();
          onCreate();
        }}
      >
        新建项目
      </MenuItem>
      <MenuItem
        icon={<X size={14} />}
        onClick={() => {
          onSelect(null);
          close();
        }}
      >
        不在项目中工作
      </MenuItem>
    </>
  );
}

export default function Composer({
  project,
  projects,
  onSelectProject,
  onCreateProject,
  showChips,
  settings,
  onSettings,
  modelOptions,
  effortOptions,
  draft,
  onDraft,
  onSend,
  busy,
  onStop,
  onToast,
  usage,
  commands,
  onSlashTrigger,
  queue,
  onQueueItem,
}: {
  project: Project | null;
  projects: Project[];
  onSelectProject: (id: string | null) => void;
  onCreateProject: () => void;
  showChips: boolean;
  settings: ComposerSettings;
  onSettings: (s: ComposerSettings) => void;
  modelOptions: ModelOption[];
  effortOptions?: readonly ReasoningEffort[];
  /** 草稿由上层持有：切换页面/会话、重启应用都不丢 */
  draft: ComposerDraft;
  onDraft: (updater: ComposerDraft | ((prev: ComposerDraft) => ComposerDraft)) => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  busy: boolean;
  onStop: () => void;
  onToast: (s: string) => void;
  usage: UsageSnapshot;
  /** 斜杠命令目录（内置 + pi 上报），空数组也会显示菜单骨架 */
  commands?: readonly SlashCommand[];
  /** 输入框触发 `/` 时回调一次（App 据此懒加载 pi 的命令目录） */
  onSlashTrigger?: (trigger: '/' | null) => void;
  /** 任务进行中的排队消息（悬浮栏展示） */
  queue?: readonly PendingSend[];
  /** 排队消息操作：steer=引导插入当前回合，withdraw=撤回放回输入框 */
  onQueueItem?: (item: PendingSend, action: 'steer' | 'withdraw') => void;
}) {
  const { text, attachments } = draft;
  const [env, setEnv] = useState<'本地' | '云端'>('本地');
  const [dropping, setDropping] = useState(false);
  const [viewer, setViewer] = useState<Attachment | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const model = modelOptions.find((m) => m.id === settings.model) ?? modelOptions[0];

  /* ---------- 斜杠命令菜单状态 ---------- */
  const [caret, setCaret] = useState(text.length);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const activeQuery = useMemo(() => activeSlashQuery(text, caret), [text, caret]);
  const filtered = useMemo(
    () => (activeQuery ? filterCommands(commands ?? [], activeQuery.query) : []),
    [activeQuery, commands],
  );
  const menuOpen = !!activeQuery && !dismissed;
  const effectiveHighlighted = filtered.length > 0 ? Math.min(highlighted, filtered.length - 1) : 0;

  // 触发状态变化时通知外层（懒加载命令目录）；关闭时传 null。
  const onSlashTriggerRef = useRef(onSlashTrigger);
  useEffect(() => { onSlashTriggerRef.current = onSlashTrigger; });
  useEffect(() => {
    onSlashTriggerRef.current?.(activeQuery ? '/' : null);
  }, [activeQuery?.start, activeQuery?.query]);

  const syncCaret = useCallback(() => {
    const ta = taRef.current;
    if (ta) setCaret(ta.selectionStart ?? text.length);
  }, [text.length]);

  const selectCommand = useCallback(
    (command: SlashCommand) => {
      // 替换「斜杠 + 查询串」为完整命令，光标落在命令后的空格上。
      const end = activeQuery ? Math.max(activeQuery.end, 1) : text.length;
      const inserted = `/${command.name} `;
      const next = `${text.slice(0, 0)}${inserted}${text.slice(end)}`;
      setDismissed(true);
      setText(next);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        const pos = inserted.length;
        ta.setSelectionRange(pos, pos);
        setCaret(pos);
      });
    },
    [activeQuery, text],
  );

  const setText = (value: string) => onDraft((current) => ({ ...current, text: value }));
  const addAttachments = (list: Attachment[]) => {
    if (!list.length) return;
    onDraft((current) => ({ ...current, attachments: [...current.attachments, ...list] }));
    // 桌面端立刻把粘贴的图片落盘：草稿重启后仍能复原，Pi 也始终有路径可读。
    void ensureAttachmentPaths(list).then((resolved) => {
      if (!resolved.some((att, i) => att.path !== list[i].path)) return;
      const byId = new Map(resolved.map((att) => [att.id, att]));
      onDraft((current) => ({
        ...current,
        attachments: current.attachments.map((att) => byId.get(att.id) ?? att),
      }));
    });
  };
  const removeAttachment = (id: string) =>
    onDraft((current) => ({ ...current, attachments: current.attachments.filter((att) => att.id !== id) }));

  /** 文本被外部清空或切换草稿时同步回缩高度，否则会残留上一条的高度。 */
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
  }, [text]);

  const submit = () => {
    if (busy) {
      // 任务进行中：有内容 → 转向发送（steer，插入当前回合）；
      // 无内容 → 停止按钮语义（按钮区已按此切换图标）。
      const t = text.trim();
      if (!t && attachments.length === 0) return onStop();
      onSend(t, attachments);
      return;
    }
    const t = text.trim();
    if (!t && attachments.length === 0) return;
    onSend(t, attachments);
  };

  /** busy 时输入框有内容 → 显示「转向发送」而非停止按钮 */
  const busyComposing = busy && (text.trim().length > 0 || attachments.length > 0);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (dropped.length === 0) return;
    addAttachments(await Promise.all(dropped.map((file) => (
      file.type.startsWith('image/')
        ? attachmentFromFile(file)
        : (file as File & { path?: string }).path
          ? attachmentFromPath((file as File & { path?: string }).path!)
          : attachmentFromFile(file)
    ))));
  };

  return (
    <div className="w-full">
      {/* 任务进行中的排队消息：等当前回合结束自动发送；可「引导」立即插入
       * 当前回合（pi steer）或「撤回」放回输入框。 */}
      {busy && (queue?.length ?? 0) > 0 && (
        <div className="mx-3 mb-1.5 flex flex-col gap-1">
          {queue!.map((item) => (
            <div
              key={item.id}
              className="flex min-h-[34px] items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-1 text-[12px] text-[var(--text-2)]"
            >
              <Clock size={12} className="shrink-0 text-[var(--text-3)]" />
              <span className="min-w-0 flex-1 truncate" title={item.text}>
                {item.text || (item.attachments.length ? `${item.attachments.length} 个附件` : '')}
              </span>
              <button
                type="button"
                title="立即插入当前任务，不等它结束"
                onClick={() => onQueueItem?.(item, 'steer')}
                className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[var(--blue)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                <CornerUpLeft size={12} />
                引导
              </button>
              <button
                type="button"
                title="撤回：内容放回输入框"
                onClick={() => onQueueItem?.(item, 'withdraw')}
                className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
              >
                <Undo2 size={12} />
                撤回
              </button>
            </div>
          ))}
        </div>
      )}
      {showChips && (
        <div className="-mb-2.5 mx-3 flex items-center gap-1 rounded-t-2xl bg-[var(--bg-chip)] px-3 pb-3 pt-1.5 text-[13px] text-[var(--text-2)]">
          <Popover
            side="top"
            width={270}
            trigger={(_, toggle) => (
              <button
                onClick={toggle}
                title={project?.path}
                className="flex items-center gap-1.5 rounded-md px-1.5 py-1 font-medium hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
              >
                <Folder size={14} />
                {project ? project.name : '选择项目'}
              </button>
            )}
          >
            {(close) => (
              <ProjectPicker
                projects={projects}
                project={project}
                onSelect={onSelectProject}
                onCreate={onCreateProject}
                close={close}
              />
            )}
          </Popover>
          {project && (
            <>
              <span title="工作区存在未提交的更改" className="px-1 text-[var(--orange)]">
                <CircleAlert size={13} />
              </span>
              <button
                onClick={() => setEnv(env === '本地' ? '云端' : '本地')}
                className="ml-2 flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
              >
                {env === '本地' ? <Laptop size={14} /> : <Cloud size={14} />} {env}
              </button>
              <button
                onClick={() => onToast(`当前分支：${project.branch}`)}
                className="ml-2 flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
              >
                <GitBranch size={14} /> {project.branch}
              </button>
            </>
          )}
        </div>
      )}
      <div
        className={cn(
          'relative rounded-[22px] border border-[var(--border)] bg-[var(--bg-input)] shadow-[0_2px_12px_rgba(0,0,0,0.06)]',
          dropping && 'border-[var(--blue)]',
        )}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={(e) => void handleDrop(e)}
      >
        {menuOpen && activeQuery && (
          <SlashMenu
            query={activeQuery.query}
            commands={filtered}
            highlighted={effectiveHighlighted}
            onHighlight={setHighlighted}
            onSelect={selectCommand}
          />
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap items-start gap-2 px-3 pt-3">
            {attachments.map((att) =>
              att.kind === 'image' ? (
                <div key={att.id} className="group/att relative">
                  <AttachmentThumb
                    att={att}
                    title="点击查看原图"
                    onClick={() => setViewer(att)}
                    className="h-16 w-16 rounded-xl border border-[var(--border)] transition-opacity hover:opacity-90"
                  />
                  <button
                    type="button"
                    title="移除"
                    onClick={() => removeAttachment(att.id)}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--bg-elev)] text-[var(--text-2)] opacity-0 transition-opacity hover:text-[#f85149] group-hover/att:opacity-100"
                  >
                    <X size={11} />
                  </button>
                </div>
              ) : (
                <span
                  key={att.id}
                  className="flex max-w-full items-center gap-1.5 rounded-lg bg-[var(--bg-hover)] px-2 py-1 text-[12px]"
                >
                  <FileText size={12} className="shrink-0 text-[var(--blue)]" />
                  <span className="max-w-[260px] truncate font-mono text-[var(--blue)]" title={att.path || att.value}>
                    {att.path || att.value}
                  </span>
                  <button
                    type="button"
                    title="移除"
                    onClick={() => removeAttachment(att.id)}
                    className="shrink-0 text-[var(--text-3)] hover:text-[var(--text)]"
                  >
                    <X size={11} />
                  </button>
                </span>
              ),
            )}
          </div>
        )}
        {dropping && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[22px] border border-dashed border-[var(--blue)] bg-[var(--bg-elev)]/90 text-[13px] text-[var(--text)]">
            松开以添加图片或文件
          </div>
        )}
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDismissed(false);
            setHighlighted(0);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 220) + 'px';
          }}
          onPaste={(e) => {
            const hasImage = Array.from(e.clipboardData?.items ?? []).some((item) => item.kind === 'file' && item.type.startsWith('image/'));
            if (!hasImage) return;
            // 图文同源（如从网页/文档复制）时保留文字粘贴，只在纯图片时接管。
            if (!e.clipboardData.getData('text/plain')) e.preventDefault();
            void attachmentsFromClipboard(e.clipboardData).then(addAttachments);
          }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onKeyUp={syncCaret}
          onKeyDown={(e) => {
            // IME 合成中的按键不参与菜单导航（中文输入法确认候选的 Enter
            // 不是发送/选中）。
            const composing = e.nativeEvent.isComposing;
            if (menuOpen && !composing && filtered.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlighted((i) => (i + 1) % filtered.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlighted((i) => (i - 1 + filtered.length) % filtered.length);
                return;
              }
              if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
                e.preventDefault();
                selectCommand(filtered[effectiveHighlighted]);
                return;
              }
            }
            if (menuOpen && !composing && e.key === 'Escape') {
              e.preventDefault();
              setDismissed(true);
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="随心输入"
          className="scroll-thin block max-h-[220px] min-h-[52px] w-full resize-none bg-transparent px-[14px] pt-[14px] text-[14px] leading-[22px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]"
        />
        <div className="flex items-center gap-1 px-2.5 pb-2.5 pt-1">
          <Popover
            side="top"
            width={200}
            trigger={(_, toggle) => (
              <button onClick={toggle} className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text)] hover:bg-[var(--bg-hover)]">
                <Plus size={18} />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem icon={<Paperclip size={13} />} onClick={() => { close(); void pickAttachments('any').then(addAttachments); }}>添加文件</MenuItem>
                <MenuItem icon={<Image size={13} />} onClick={() => { close(); void pickAttachments('image').then(addAttachments); }}>添加图片</MenuItem>
                <MenuItem
                  icon={<Folder size={13} />}
                  onClick={() => {
                    close();
                    void pickDirectory().then((dir) => {
                      if (dir) addAttachments([{ id: uid(), kind: 'file', name: dir.name, value: dir.path, path: dir.path }]);
                    });
                  }}
                >
                  添加文件夹上下文
                </MenuItem>
              </>
            )}
          </Popover>
          <ContextUsage usage={usage} />
          <div className="flex-1" />
          <Popover
            side="top"
            align="right"
            width={280}
            trigger={(_, toggle) => (
              <button onClick={toggle} className="flex items-center gap-1 rounded-full px-2 py-1 text-[13px] text-[var(--text)] hover:bg-[var(--bg-hover)]">
                <span className="max-w-[150px] truncate font-medium">{model ? model.name : '选择模型'}</span>
                {model && <span className="text-[var(--text-2)]">{effortLabel(settings.effort)}</span>}
                <ChevronDown size={13} className="ml-0.5 text-[var(--text-3)]" />
              </button>
            )}
          >
            {() => (
              <ModelEffortPanel
                model={model}
                modelOptions={modelOptions}
                effortOptions={effortOptions}
                effort={settings.effort}
                onEffort={(effort) => onSettings({ ...settings, effort })}
                onModel={(id) => onSettings({ ...settings, model: id })}
              />
            )}
          </Popover>
          <button
            onClick={submit}
            title={busy ? (busyComposing ? '加入队列，任务结束后自动发送' : '停止') : '发送'}
            disabled={busy ? false : !(text.trim().length > 0 || attachments.length > 0)}
            className={cn(
              'ml-1 flex h-[30px] w-[30px] items-center justify-center rounded-full transition-colors',
              busy && !busyComposing
                ? 'bg-[var(--text)] text-[var(--bg-main)] hover:opacity-90'
                : 'bg-[var(--text)] text-[var(--bg-main)] hover:opacity-85',
            )}
          >
            {busy && !busyComposing ? <Square size={11} fill="currentColor" /> : <ArrowUp size={16} strokeWidth={2.4} />}
          </button>
        </div>
      </div>
      {viewer && <ImageViewer att={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}
