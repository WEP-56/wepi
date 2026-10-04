import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Search,
  Sparkles,
  Pencil,
  Trash2,
  RefreshCw,
  Download,
  ExternalLink,
  AlertTriangle,
  PackageOpen,
  FolderOpen,
} from 'lucide-react';
import { Btn, Modal, Field, inputCls, Segmented, Card } from '../kit';
import { Toggle } from '../ui';
import { cn } from '../../utils/cn';
import { isDesktopRuntime } from '../../lib/piRpc';
import {
  skillsApi,
  shellApi,
  adminErrorMessage,
  openExternal,
  type SkillSummary,
  type SkillLocation,
  type SkillStoreItem,
} from '../../lib/piAdmin';

type PageTab = 'local' | 'store';

const formatInstalls = (count: number) => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
};

/* ---------- 技能编辑器 ---------- */

function SkillEditor({
  skill,
  onClose,
  onSaved,
  onToast,
}: {
  skill: SkillSummary;
  onClose: () => void;
  onSaved: () => void;
  onToast: (s: string) => void;
}) {
  const [content, setContent] = useState('');
  const [name, setName] = useState(skill.name);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    skillsApi.read(skill.path)
      .then((result) => { if (!cancelled) setContent(result.content); })
      .catch((caught) => { if (!cancelled) setError(adminErrorMessage(caught, '读取技能失败')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [skill.path]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      if (name.trim() && name.trim() !== skill.name) {
        await skillsApi.rename(skill.path, name.trim());
      }
      await skillsApi.write(skill.path, content);
      onToast('技能已保存（重启会话后生效）');
      onSaved();
      onClose();
    } catch (caught) {
      setError(adminErrorMessage(caught, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`编辑技能 · ${skill.name}`} onClose={onClose} width={680}>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-3)]">
        <span className="rounded-md bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--text-2)]">{skill.sourceLabel}</span>
        <span className="font-mono">{skill.path}</span>
      </div>
      {skill.warnings.length > 0 && (
        <div className="mb-4 flex flex-col gap-1 rounded-xl border border-[#d29922]/40 bg-[#d29922]/10 px-3 py-2 text-[12px] text-[#d29922]">
          {skill.warnings.map((warning) => (
            <span key={warning} className="flex items-center gap-1.5"><AlertTriangle size={12} />{warning}</span>
          ))}
        </div>
      )}
      {error && <div className="mb-3 rounded-xl border border-[#f85149]/40 px-3 py-2 text-[12.5px] text-[#f85149]">{error}</div>}
      <Field label="名称" hint="小写字母、数字与连字符（保存在 frontmatter）">
        <input value={name} onChange={(e) => setName(e.target.value)} className={cn(inputCls, 'font-mono text-[12.5px]')} />
      </Field>
      <Field label="SKILL.md 全文">
        {loading ? (
          <div className="py-8 text-center text-[13px] text-[var(--text-3)]">读取中…</div>
        ) : (
          <textarea
            value={content}
            spellCheck={false}
            onChange={(e) => setContent(e.target.value)}
            rows={14}
            className="scroll-thin w-full resize-none rounded-xl border border-[var(--border-strong)] bg-transparent px-3 py-2 font-mono text-[12.5px] leading-6 text-[var(--text)] outline-none focus:border-[var(--blue)]"
          />
        )}
      </Field>
      <div className="mt-5 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>取消</Btn>
        <Btn variant="primary" disabled={saving || loading} onClick={save}>{saving ? '保存中…' : '保存'}</Btn>
      </div>
    </Modal>
  );
}

/* ---------- 新建技能 ---------- */

function CreateSkillDialog({
  locations,
  onClose,
  onCreated,
  onToast,
}: {
  locations: SkillLocation[];
  onClose: () => void;
  onCreated: () => void;
  onToast: (s: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [locationId, setLocationId] = useState(locations[0]?.id ?? 'pi-global');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const valid = name.trim() && description.trim();

  const submit = async () => {
    setCreating(true);
    setError('');
    try {
      await skillsApi.create(locationId, name.trim(), description.trim());
      onToast(`已创建技能 ${name.trim()}`);
      onCreated();
      onClose();
    } catch (caught) {
      setError(adminErrorMessage(caught, '创建失败'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal title="新建技能" onClose={onClose} width={560}>
      {error && <div className="mb-3 rounded-xl border border-[#f85149]/40 px-3 py-2 text-[12.5px] text-[#f85149]">{error}</div>}
      <Field label="名称" hint="小写字母、数字与连字符">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-skill" className={cn(inputCls, 'font-mono text-[12.5px]')} />
      </Field>
      <Field label="描述" hint="告诉 Agent 何时应该使用该技能">
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明用途与触发场景" className={inputCls} />
      </Field>
      <Field label="位置">
        <Segmented
          value={locationId}
          onChange={setLocationId}
          options={locations.map((location) => ({ value: location.id, label: location.label }))}
        />
      </Field>
      <div className="mt-5 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>取消</Btn>
        <Btn variant="primary" disabled={!valid || creating} onClick={submit}>{creating ? '创建中…' : '创建'}</Btn>
      </div>
    </Modal>
  );
}

/* ---------- 技能商店（skills.sh） ---------- */

function StorePanel({ onInstalled, onToast }: { onInstalled: () => void; onToast: (s: string) => void }) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [items, setItems] = useState<SkillStoreItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);
  const [output, setOutput] = useState<{ slug: string; success: boolean; text: string } | null>(null);

  const search = useCallback(async (term: string) => {
    setLoading(true);
    setError('');
    try {
      const result = await skillsApi.storeSearch(term, 50);
      setItems(result.items);
    } catch (caught) {
      setError(adminErrorMessage(caught, '搜索失败（skills.sh 可能不可达）'));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 默认展示热门列表（空关键词搜索）。
  useEffect(() => { void search(''); }, [search]);

  const install = async (item: SkillStoreItem) => {
    if (installing) return;
    setInstalling(item.slug);
    setOutput(null);
    try {
      const result = await skillsApi.storeInstall(item.slug);
      setOutput({ slug: item.slug, success: result.success, text: result.output });
      if (result.success) {
        onToast(`已安装 ${item.name}（重启会话后生效）`);
        onInstalled();
      }
    } catch (caught) {
      setOutput({ slug: item.slug, success: false, text: adminErrorMessage(caught, '安装失败') });
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-9 flex-1 items-center gap-2 rounded-full bg-[var(--bg-hover)] px-3.5">
          <Search size={14} className="text-[var(--text-2)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { setSubmitted(query.trim()); void search(query.trim()); } }}
            placeholder="搜索 skills.sh 技能包"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]"
          />
        </div>
        <Btn onClick={() => { setSubmitted(query.trim()); void search(query.trim()); }} disabled={loading}>
          <Search size={13} /> 搜索
        </Btn>
      </div>
      {error && <div className="mb-3 rounded-xl border border-[#f85149]/40 px-3 py-2 text-[12.5px] text-[#f85149]">{error}</div>}
      {output && (
        <div className={cn('mb-3 rounded-xl border px-3 py-2 text-[12px]', output.success ? 'border-[#3fb950]/40 text-[#3fb950]' : 'border-[#f85149]/40 text-[#f85149]')}>
          <div className="mb-1 font-medium">{output.slug} · {output.success ? '安装成功' : '安装失败'}</div>
          <pre className="scroll-thin max-h-[120px] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-5">{output.text}</pre>
        </div>
      )}
      {loading ? (
        <Card className="py-12 text-center text-[13px] text-[var(--text-3)]">搜索中…</Card>
      ) : items.length === 0 ? (
        <Card className="py-12 text-center text-[13px] text-[var(--text-3)]">
          {submitted ? `没有匹配「${submitted}」的技能` : '热门列表为空（skills.sh 可能不可达）'}
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <Card key={item.slug} className="flex flex-col p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-hover)] text-[var(--text)]">
                  <Sparkles size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13.5px] font-medium text-[var(--text)]">{item.name}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--text-3)]">
                    <span className="rounded-md bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--text-2)]">{formatInstalls(item.installs)} 次安装</span>
                    <span className="truncate">{item.source}</span>
                  </div>
                </div>
              </div>
              <p className="mt-2.5 line-clamp-2 min-h-[36px] text-[12.5px] leading-5 text-[var(--text-2)]">{item.description}</p>
              <div className="mt-3 flex items-center gap-1.5">
                <button
                  onClick={() => void install(item)}
                  disabled={installing !== null}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40"
                >
                  <Download size={12} /> {installing === item.slug ? '安装中…' : '一键安装'}
                </button>
                <button
                  onClick={() => openExternal(`https://www.skills.sh/skills/${item.slug}`, onToast)}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                >
                  <ExternalLink size={12} /> 详情
                </button>
                <div className="flex-1" />
                <span className="truncate font-mono text-[10.5px] text-[var(--text-3)]" title={item.slug}>{item.slug}</span>
              </div>
            </Card>
          ))}
        </div>
      )}
      <p className="mt-4 text-[11.5px] text-[var(--text-3)]">
        数据来自 skills.sh；安装命令 <code className="rounded bg-[var(--bg-hover)] px-1 py-0.5 font-mono">npx skills add &lt;pkg&gt; --agent pi --global --yes</code>，安装到 ~/.pi/agent/skills。
      </p>
    </div>
  );
}

/* ---------- 主页面 ---------- */

export default function SkillsPage({ onToast }: { onToast: (s: string) => void }) {
  const [tab, setTab] = useState<PageTab>('local');
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [locations, setLocations] = useState<SkillLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('全部');
  const [editing, setEditing] = useState<SkillSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SkillSummary | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError('');
    try {
      const result = await skillsApi.list();
      if (generation !== loadGeneration.current) return;
      setSkills(result.skills);
      setLocations(result.locations);
    } catch (caught) {
      if (generation === loadGeneration.current) setError(adminErrorMessage(caught, '读取技能列表失败'));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  const sources = useMemo(() => ['全部', ...new Set(skills.map((skill) => skill.sourceId))], [skills]);
  const list = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return skills.filter((skill) =>
      (sourceFilter === '全部' || skill.sourceId === sourceFilter)
      && (!keyword || (skill.name + skill.description).toLowerCase().includes(keyword)),
    );
  }, [skills, query, sourceFilter]);

  const toggleUserOnly = async (skill: SkillSummary, userOnly: boolean) => {
    if (toggling) return;
    setToggling(skill.path);
    try {
      const updated = await skillsApi.setUserOnly(skill.path, userOnly);
      setSkills((current) => current.map((item) => (item.path === skill.path ? updated : item)));
      onToast(userOnly ? `${skill.name} 已设为仅手动调用（/skill:${skill.name}）` : `${skill.name} 已恢复自动调用`);
    } catch (caught) {
      onToast(adminErrorMessage(caught, '操作失败'));
    } finally {
      setToggling(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    try {
      await skillsApi.remove(target.path);
      onToast(`已删除 ${target.name}`);
      void load();
    } catch (caught) {
      onToast(adminErrorMessage(caught, '删除失败'));
    }
  };

  return (
    <div className="scroll-thin min-w-0 flex-1 overflow-y-auto bg-[var(--bg-main)]">
      <div className="fade-in mx-auto max-w-[880px] px-10 pb-16 pt-12">
        <div className="mb-6 flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[28px] font-medium text-[var(--text)]">Skill 配置</h2>
            <p className="mt-2 max-w-[580px] text-[13.5px] leading-6 text-[var(--text-2)]">
              Skill 是由 SKILL.md 与资源组成的能力包。发现全局目录中的已有技能，支持编辑、更新语义与商店一键安装。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-1">
            <Btn onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> 刷新
            </Btn>
            {tab === 'local' && (
              <>
                <Btn
                  onClick={() => {
                    const root = locations[0]?.path;
                    if (!root) return;
                    shellApi.showInExplorer(root).catch((error) => onToast(adminErrorMessage(error, '无法打开目录')));
                  }}
                >
                  <FolderOpen size={14} /> 打开目录
                </Btn>
                <Btn variant="primary" onClick={() => setCreating(true)}>
                  <Plus size={14} /> 新建
                </Btn>
              </>
            )}
          </div>
        </div>

        <div className="mb-4 flex items-center gap-3">
          <Segmented
            value={tab}
            onChange={(value) => { setTab(value); if (value === 'local') void load(); }}
            options={[
              { value: 'local', label: `本地技能${skills.length ? `（${skills.length}）` : ''}` },
              { value: 'store', label: '技能商店' },
            ]}
          />
          {tab === 'store' && <span className="text-[12.5px] text-[var(--text-3)]">来自 skills.sh</span>}
        </div>

        {error && <div className="mb-4 rounded-xl border border-[#f85149]/40 px-3 py-2 text-[13px] text-[#f85149]">{error}</div>}

        {tab === 'store' ? (
          <StorePanel onInstalled={() => void load()} onToast={onToast} />
        ) : (
          <>
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-9 max-w-[280px] flex-1 items-center gap-2 rounded-full bg-[var(--bg-hover)] px-3.5">
                <Search size={14} className="text-[var(--text-2)]" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索技能" className="min-w-0 flex-1 bg-transparent text-[13.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]" />
              </div>
              {sources.length > 1 && (
                <Segmented
                  value={sourceFilter}
                  onChange={setSourceFilter}
                  options={sources.map((value) => ({ value, label: value === '全部' ? '全部' : value === 'pi-global' ? '~/.pi' : '~/.agents' }))}
                />
              )}
            </div>

            {loading ? (
              <Card className="py-12 text-center text-[13px] text-[var(--text-3)]">加载中…</Card>
            ) : list.length === 0 ? (
              <Card className="flex flex-col items-center gap-3 py-14 text-[var(--text-3)]">
                <PackageOpen size={30} />
                <div className="text-[13.5px]">
                  {!isDesktopRuntime() ? '需要桌面版运行' : skills.length === 0 ? '还没有技能，可从商店安装或新建' : '没有匹配的技能'}
                </div>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {list.map((skill) => (
                  <Card key={skill.id} className="flex flex-col p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-hover)] text-[var(--text)]">
                        <Sparkles size={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-mono text-[13.5px] font-medium text-[var(--text)]">{skill.name}</span>
                          {skill.warnings.length > 0 && (
                            <AlertTriangle size={12} className="shrink-0 text-[#d29922]" >
                              <title>{skill.warnings.join('；')}</title>
                            </AlertTriangle>
                          )}
                        </div>
                        <span className="mt-1 inline-block rounded-md bg-[var(--bg-hover)] px-1.5 py-0.5 text-[11px] text-[var(--text-2)]">{skill.sourceLabel}</span>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-2 min-h-[40px] text-[12.5px] leading-5 text-[var(--text-2)]">
                      {skill.description || <span className="text-[var(--text-3)]">（无描述）</span>}
                    </p>
                    <div className="mt-3 flex items-center gap-1">
                      <button onClick={() => setEditing(skill)} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                        <Pencil size={12} /> 编辑
                      </button>
                      <button
                        onClick={() => setPendingDelete(skill)}
                        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[#f85149]"
                      >
                        <Trash2 size={12} /> 删除
                      </button>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-[var(--bg-hover)] px-2.5 py-2">
                      <div className="min-w-0">
                        <div className="text-[12px] font-medium text-[var(--text)]">仅手动调用</div>
                        <div className="truncate text-[10.5px] text-[var(--text-3)]">开启后模型不再自动调用，仍可用 /skill:{skill.name}</div>
                      </div>
                      <Toggle on={skill.userOnly} disabled={toggling === skill.path} onChange={(value) => void toggleUserOnly(skill, value)} />
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {editing && <SkillEditor skill={editing} onClose={() => setEditing(null)} onSaved={() => void load()} onToast={onToast} />}
      {creating && <CreateSkillDialog locations={locations} onClose={() => setCreating(false)} onCreated={() => void load()} onToast={onToast} />}
      {pendingDelete && (
        <Modal title={`删除技能「${pendingDelete.name}」？`} onClose={() => setPendingDelete(null)} width={480}>
          <p className="text-[13px] leading-6 text-[var(--text-2)]">
            将删除 {pendingDelete.type === 'directory' ? '整个技能目录' : '技能文件'}：<br />
            <span className="break-all font-mono text-[12px] text-[var(--text-3)]">{pendingDelete.type === 'directory' ? pendingDelete.dir : pendingDelete.path}</span><br />
            此操作无法撤销。
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setPendingDelete(null)}>取消</Btn>
            <Btn variant="danger" onClick={confirmDelete}>删除</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}
