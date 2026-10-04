import { useState } from 'react';
import { Plus, Search, Sparkles, Pencil, Trash2, Upload, Copy } from 'lucide-react';
import { uid, type Skill } from '../../data';
import { PageShell, Btn, Modal, Field, inputCls, Segmented, Card } from '../kit';
import { Toggle } from '../ui';
import { cn } from '../../utils/cn';

type Filter = '全部' | Skill['source'];

const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '');

function SkillForm({
  initial,
  onClose,
  onSave,
  onFork,
}: {
  initial: Skill | null;
  onClose: () => void;
  onSave: (s: Skill) => void;
  onFork: (s: Skill) => void;
}) {
  const readOnly = initial?.source === '内置';
  const [d, setD] = useState<Skill>(
    initial ?? {
      id: uid(),
      name: '',
      description: '',
      source: '用户',
      enabled: true,
      content: '# 使用说明\n\n描述 Agent 在什么场景下使用这个 Skill，以及具体步骤。',
    },
  );
  const set = (p: Partial<Skill>) => setD((x) => ({ ...x, ...p }));
  const valid = slug(d.name) && d.description.trim() && d.content.trim();
  return (
    <Modal title={readOnly ? `查看 Skill · ${d.name}` : initial ? '编辑 Skill' : '新建 Skill'} onClose={onClose} width={620}>
      {readOnly && (
        <div className="mb-4 rounded-xl bg-[var(--bg-hover)] px-3 py-2 text-[12.5px] text-[var(--text-2)]">内置 Skill 为只读，可另存为用户 Skill 后修改。</div>
      )}
      <Field label="名称" hint="使用小写字母、数字与连字符">
        <input autoFocus={!readOnly} readOnly={readOnly} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="my-skill" className={cn(inputCls, 'font-mono text-[12.5px]')} />
      </Field>
      <Field label="描述" hint="告诉 Agent 何时应该使用该 Skill">
        <input readOnly={readOnly} value={d.description} onChange={(e) => set({ description: e.target.value })} placeholder="一句话说明用途与触发场景" className={inputCls} />
      </Field>
      <Field label="指令（SKILL.md）">
        <textarea
          readOnly={readOnly}
          value={d.content}
          onChange={(e) => set({ content: e.target.value })}
          rows={9}
          spellCheck={false}
          className="scroll-thin w-full resize-none rounded-xl border border-[var(--border-strong)] bg-transparent px-3 py-2 font-mono text-[12.5px] leading-6 text-[var(--text)] outline-none focus:border-[var(--blue)]"
        />
      </Field>
      <div className="mt-5 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>
          {readOnly ? '关闭' : '取消'}
        </Btn>
        {readOnly ? (
          <Btn variant="primary" onClick={() => onFork(d)}>
            <Copy size={13} /> 另存为用户 Skill
          </Btn>
        ) : (
          <Btn variant="primary" disabled={!valid} onClick={() => onSave({ ...d, name: slug(d.name) })}>
            保存
          </Btn>
        )}
      </div>
    </Modal>
  );
}

export default function SkillsPage({
  skills,
  setSkills,
  onToast,
}: {
  skills: Skill[];
  setSkills: React.Dispatch<React.SetStateAction<Skill[]>>;
  onToast: (s: string) => void;
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('全部');
  const [editing, setEditing] = useState<Skill | 'new' | null>(null);

  const list = skills.filter(
    (s) => (filter === '全部' || s.source === filter) && (s.name + s.description).toLowerCase().includes(q.toLowerCase()),
  );

  const save = (s: Skill) => {
    const exists = skills.some((x) => x.id === s.id);
    setSkills((ss) => (exists ? ss.map((x) => (x.id === s.id ? s : x)) : [...ss, s]));
    setEditing(null);
    onToast(exists ? '已保存 Skill' : `已创建 Skill ${s.name}`);
  };

  return (
    <PageShell
      title="Skill 配置"
      desc="Skill 是由说明与资源组成的能力包（SKILL.md）。Agent 会在相关任务中按需加载已启用的 Skill。"
      actions={
        <>
          <Btn onClick={() => onToast('导入 Skill 文件夹（演示）')}>
            <Upload size={14} /> 导入
          </Btn>
          <Btn variant="primary" onClick={() => setEditing('new')}>
            <Plus size={14} /> 新建 Skill
          </Btn>
        </>
      }
    >
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-9 flex-1 items-center gap-2 rounded-full bg-[var(--bg-hover)] px-3.5">
          <Search size={14} className="text-[var(--text-2)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 Skill" className="min-w-0 flex-1 bg-transparent text-[13.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]" />
        </div>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={(['全部', '内置', '用户', '项目'] as Filter[]).map((v) => ({ value: v, label: v }))}
        />
      </div>

      {list.length === 0 ? (
        <Card className="py-14 text-center text-[13.5px] text-[var(--text-3)]">没有匹配的 Skill</Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {list.map((s) => (
            <Card key={s.id} className={cn('flex flex-col p-4 transition-opacity', !s.enabled && 'opacity-70')}>
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-hover)] text-[var(--text)]">
                  <Sparkles size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13.5px] font-medium text-[var(--text)]">{s.name}</div>
                  <span className="mt-1 inline-block rounded-md bg-[var(--bg-hover)] px-1.5 py-0.5 text-[11px] text-[var(--text-2)]">{s.source}</span>
                </div>
                <Toggle on={s.enabled} onChange={(v) => setSkills((ss) => ss.map((x) => (x.id === s.id ? { ...x, enabled: v } : x)))} />
              </div>
              <p className="mt-3 line-clamp-2 min-h-[40px] text-[12.5px] leading-5 text-[var(--text-2)]">{s.description}</p>
              <div className="mt-3 flex items-center gap-1">
                <button onClick={() => setEditing(s)} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                  <Pencil size={12} /> {s.source === '内置' ? '查看' : '编辑'}
                </button>
                {s.source !== '内置' && (
                  <button
                    onClick={() => {
                      setSkills((ss) => ss.filter((x) => x.id !== s.id));
                      onToast(`已删除 ${s.name}`);
                    }}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[#f85149]"
                  >
                    <Trash2 size={12} /> 删除
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <SkillForm
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={save}
          onFork={(s) => save({ ...s, id: uid(), source: '用户', name: s.name + '-copy' })}
        />
      )}
    </PageShell>
  );
}
