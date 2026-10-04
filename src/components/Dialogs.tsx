import { useState } from 'react';
import { Folder, FolderPlus, ChevronDown, Check, X } from 'lucide-react';
import type { Project } from '../data';
import { Modal, Btn, Field, inputCls, Segmented } from './kit';
import { Popover, MenuItem } from './ui';
import { pickDirectory, folderName, looksAbsolute } from '../lib/fs';
import { cn } from '../utils/cn';

/** 创建 / 编辑项目：名称 + 源文件夹（本地目录） */
export function ProjectDialog({
  initial,
  onClose,
  onSubmit,
}: {
  initial?: Project | null;
  onClose: () => void;
  onSubmit: (name: string, path: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [path, setPath] = useState(initial?.path ?? '');
  const [touched, setTouched] = useState(!!initial);
  const [mode, setMode] = useState<'pick' | 'manual'>('pick');
  const [manual, setManual] = useState('');
  const [picking, setPicking] = useState(false);

  const applyPath = (p: string, n: string) => {
    setPath(p);
    if (!touched) setName(n);
  };

  const pick = async () => {
    setPicking(true);
    const d = await pickDirectory();
    setPicking(false);
    if (d) applyPath(d.path, d.name);
  };

  const addManual = () => {
    const p = manual.trim();
    if (p) applyPath(p, folderName(p));
  };

  const valid = name.trim().length > 0 && path.length > 0;
  const submit = () => valid && onSubmit(name.trim(), path);

  return (
    <Modal title={initial ? '编辑项目' : '创建项目'} onClose={onClose} width={520}>
      <div className="flex h-12 items-stretch overflow-hidden rounded-xl border border-[var(--border-strong)] focus-within:border-[var(--blue)]">
        <div className="flex w-12 items-center justify-center border-r border-[var(--border-strong)] text-[var(--text-2)]">
          <Folder size={16} />
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setTouched(true);
          }}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && submit()}
          placeholder="项目名称"
          className="min-w-0 flex-1 bg-transparent px-3 text-[14px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]"
        />
      </div>

      <div className="mb-2 mt-5 text-[13px] font-medium text-[var(--text-2)]">源文件夹</div>
      <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-hover)]">
        {path ? (
          <div className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-active)] text-[var(--text)]">
                <Folder size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium text-[var(--text)]">{folderName(path)}</div>
                <div className="truncate font-mono text-[12px] text-[var(--text-3)]" title={path}>
                  {path}
                </div>
              </div>
              <button
                onClick={() => setPath('')}
                title="更换文件夹"
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-active)] hover:text-[var(--text)]"
              >
                <X size={15} />
              </button>
            </div>
            {!looksAbsolute(path) && (
              <div className="mt-3 text-[12px] leading-5 text-[var(--text-3)]">
                浏览器环境只能获取文件夹名称；桌面版会通过系统对话框返回完整的本地路径。也可以点 × 后使用「手动输入路径」。
              </div>
            )}
          </div>
        ) : (
          <div className="flex min-h-[112px] flex-col items-center justify-center gap-3 p-4">
            <Popover
              width={220}
              trigger={(_, toggle) => (
                <button onClick={toggle} className="flex items-center gap-1 text-[13px] text-[var(--text-2)] hover:text-[var(--text)]">
                  {mode === 'pick' ? (
                    <span>
                      在<b className="font-semibold text-[var(--text)]">此电脑</b>上添加文件夹
                    </span>
                  ) : (
                    <span>手动输入路径</span>
                  )}
                  <ChevronDown size={14} />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    right={mode === 'pick' ? <Check size={13} /> : undefined}
                    onClick={() => {
                      setMode('pick');
                      close();
                    }}
                  >
                    在此电脑上添加文件夹
                  </MenuItem>
                  <MenuItem
                    right={mode === 'manual' ? <Check size={13} /> : undefined}
                    onClick={() => {
                      setMode('manual');
                      close();
                    }}
                  >
                    手动输入路径
                  </MenuItem>
                </>
              )}
            </Popover>
            {mode === 'pick' ? (
              <button
                onClick={pick}
                disabled={picking}
                className="flex items-center gap-1.5 rounded-full bg-[var(--bg-active)] px-4 py-1.5 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--border-strong)] disabled:opacity-60"
              >
                <FolderPlus size={14} /> {picking ? '选择中…' : '添加'}
              </button>
            ) : (
              <form
                className="flex w-full items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  addManual();
                }}
              >
                <input
                  autoFocus
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder="C:\Users\you\code\my-project"
                  className={cn(inputCls, 'h-9 font-mono text-[12.5px]')}
                />
                <button
                  type="submit"
                  className="shrink-0 rounded-full bg-[var(--bg-active)] px-4 py-1.5 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--border-strong)]"
                >
                  添加
                </button>
              </form>
            )}
          </div>
        )}
      </div>

      <div className="mt-7 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>
          取消
        </Btn>
        <Btn variant="primary" disabled={!valid} onClick={submit}>
          {initial ? '保存' : '创建项目'}
        </Btn>
      </div>
    </Modal>
  );
}

export function ConfirmDialog({
  title,
  desc,
  label,
  onConfirm,
  onClose,
}: {
  title: string;
  desc: string;
  label: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} width={440}>
      <p className="text-[13.5px] leading-6 text-[var(--text-2)]">{desc}</p>
      <div className="mt-6 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>
          取消
        </Btn>
        <Btn
          variant="primary"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {label}
        </Btn>
      </div>
    </Modal>
  );
}

export function ScheduleDialog({
  title,
  onClose,
  onSubmit,
}: {
  title: string;
  onClose: () => void;
  onSubmit: (summary: string) => void;
}) {
  const [name, setName] = useState(title);
  const [freq, setFreq] = useState<'hour' | 'day' | 'week'>('day');
  const [time, setTime] = useState('09:00');
  const [prompt, setPrompt] = useState(`继续推进：${title}`);
  const label = { hour: '每小时', day: '每天', week: '每周一' }[freq];
  return (
    <Modal title="添加计划任务" onClose={onClose} width={500}>
      <Field label="任务名称">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      </Field>
      <Field label="重复频率">
        <div className="flex items-center gap-3">
          <Segmented
            value={freq}
            onChange={setFreq}
            options={[
              { value: 'hour', label: '每小时' },
              { value: 'day', label: '每天' },
              { value: 'week', label: '每周' },
            ]}
          />
          {freq !== 'hour' && (
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="h-9 rounded-lg border border-[var(--border-strong)] bg-transparent px-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--blue)]"
            />
          )}
        </div>
      </Field>
      <Field label="提示词">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          className="scroll-thin w-full resize-none rounded-xl border border-[var(--border-strong)] bg-transparent px-3 py-2 text-[13.5px] leading-6 text-[var(--text)] outline-none focus:border-[var(--blue)]"
        />
      </Field>
      <div className="mt-5 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>
          取消
        </Btn>
        <Btn
          variant="primary"
          disabled={!name.trim() || !prompt.trim()}
          onClick={() => {
            onSubmit(`${name.trim()} · ${label}${freq === 'hour' ? '' : ' ' + time}`);
            onClose();
          }}
        >
          创建
        </Btn>
      </div>
    </Modal>
  );
}
