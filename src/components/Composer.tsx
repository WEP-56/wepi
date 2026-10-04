import { useRef, useState } from 'react';
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
} from 'lucide-react';
import type { ModelOption, Project, ReasoningEffort } from '../data';
import { Popover, MenuItem } from './ui';
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
  onSend,
  busy,
  onStop,
  onToast,
  usage,
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
  onSend: (text: string) => void;
  busy: boolean;
  onStop: () => void;
  onToast: (s: string) => void;
  usage: UsageSnapshot;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [env, setEnv] = useState<'本地' | '云端'>('本地');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const model = modelOptions.find((m) => m.id === settings.model) ?? modelOptions[0];

  const submit = () => {
    if (busy) return onStop();
    const t = text.trim();
    if (!t) return;
    onSend(files.length ? `${t}\n\n附件：${files.map((f) => '`' + f + '`').join(' ')}` : t);
    setText('');
    setFiles([]);
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  const canSend = busy || text.trim().length > 0;

  return (
    <div className="w-full">
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
      <div className="relative rounded-[22px] border border-[var(--border)] bg-[var(--bg-input)] shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {files.map((f) => (
              <span key={f} className="flex items-center gap-1.5 rounded-lg bg-[var(--bg-hover)] px-2 py-1 text-[12px] text-[var(--text)]">
                <FileText size={12} /> {f}
                <button onClick={() => setFiles(files.filter((x) => x !== f))} className="text-[var(--text-3)] hover:text-[var(--text)]">
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 220) + 'px';
          }}
          onKeyDown={(e) => {
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
                <MenuItem icon={<Paperclip size={13} />} onClick={() => { setFiles([...files, 'README.md']); close(); }}>添加文件</MenuItem>
                <MenuItem icon={<Image size={13} />} onClick={() => { setFiles([...files, 'screenshot.png']); close(); }}>添加图片</MenuItem>
                <MenuItem icon={<Folder size={13} />} onClick={() => { setFiles([...files, 'src/']); close(); }}>添加文件夹上下文</MenuItem>
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
            disabled={!canSend}
            className={cn(
              'ml-1 flex h-[30px] w-[30px] items-center justify-center rounded-full transition-colors',
              canSend ? 'bg-[var(--text)] text-[var(--bg-main)]' : 'bg-[var(--send)] text-[var(--bg-main)] opacity-80',
            )}
          >
            {busy ? <Square size={11} fill="currentColor" /> : <ArrowUp size={16} strokeWidth={2.4} />}
          </button>
        </div>
      </div>
    </div>
  );
}
