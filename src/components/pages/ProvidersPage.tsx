import { useState } from 'react';
import { Plus, Eye, EyeOff, X, Star, Trash2, CircleCheck, CircleAlert, LoaderCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { uid, type Provider, type ModelDetails } from '../../data';
import { Btn, Modal, Field, inputCls, Card } from '../kit';
import { Toggle } from '../ui';
import { cn } from '../../utils/cn';

const kindMeta: Record<Provider['kind'], { color: string; label: string }> = {
  openai: { color: '#10a37f', label: 'OpenAI' },
  anthropic: { color: '#d97757', label: 'Anthropic' },
  google: { color: '#4285f4', label: 'Gemini' },
  deepseek: { color: '#4d6bfe', label: 'DeepSeek' },
  ollama: { color: '#8a8a8a', label: 'Ollama' },
  custom: { color: '#a855f7', label: '自定义' },
};

function Avatar({ p, size = 32 }: { p: Provider; size?: number }) {
  return (
    <div
      style={{ width: size, height: size, background: kindMeta[p.kind].color, fontSize: size * 0.42 }}
      className="flex shrink-0 items-center justify-center rounded-lg font-semibold text-white"
    >
      {p.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function AddDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (p: Provider) => void }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const valid = name.trim() && /^https?:\/\//.test(baseUrl.trim());
  return (
    <Modal title="添加提供商" onClose={onClose} width={500}>
      <Field label="名称">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 OpenRouter / 公司内网网关" className={inputCls} />
      </Field>
      <Field label="Base URL" hint="OpenAI 兼容接口，例如 https://openrouter.ai/api/v1">
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://" className={cn(inputCls, 'font-mono text-[12.5px]')} />
      </Field>
      <Field label="API Key（可选）">
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" className={cn(inputCls, 'font-mono text-[12.5px]')} />
      </Field>
      <div className="mt-6 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>
          取消
        </Btn>
        <Btn
          variant="primary"
          disabled={!valid}
          onClick={() =>
            onAdd({ id: uid(), name: name.trim(), kind: 'custom', baseUrl: baseUrl.trim(), apiKey, enabled: true, models: [], custom: true })
          }
        >
          添加
        </Btn>
      </div>
    </Modal>
  );
}

export default function ProvidersPage({
  providers,
  setProviders,
  defaultModel,
  onSetDefault,
  onToast,
}: {
  providers: Provider[];
  setProviders: React.Dispatch<React.SetStateAction<Provider[]>>;
  defaultModel: string;
  onSetDefault: (id: string) => void;
  onToast: (s: string) => void;
}) {
  const [sel, setSel] = useState(providers[0]?.id ?? '');
  const [adding, setAdding] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [newModel, setNewModel] = useState('');
  const [test, setTest] = useState<Record<string, { s: 'testing' | 'ok' | 'error'; msg: string }>>({});
  const [openModel, setOpenModel] = useState<string | null>(null);

  const p = providers.find((x) => x.id === sel) ?? providers[0];
  const patch = (id: string, pt: Partial<Provider>) => setProviders((ps) => ps.map((x) => (x.id === id ? { ...x, ...pt } : x)));

  const runTest = (pr: Provider) => {
    setTest((t) => ({ ...t, [pr.id]: { s: 'testing', msg: '正在连接…' } }));
    setTimeout(() => {
      const ok = pr.enabled && pr.baseUrl.trim().length > 0 && (pr.kind === 'ollama' || pr.apiKey.trim().length > 0);
      setTest((t) => ({
        ...t,
        [pr.id]: ok
          ? { s: 'ok', msg: `配置有效 · ${pr.models.length} 个模型已写入 Pi` }
          : { s: 'error', msg: pr.enabled ? '请填写 Base URL 和 API Key' : '请先启用提供商' },
      }));
    }, 300);
  };

  const addModel = () => {
    const m = newModel.trim();
    if (!p || !m) return;
    if (p.models.includes(m)) return onToast('模型已存在');
    patch(p.id, { models: [...p.models, m] });
    setNewModel('');
  };

  const t = p ? test[p.id] : undefined;
  const patchModel = (modelId: string, details: Partial<ModelDetails>) => {
    if (!p) return;
    const current = p.modelDetails?.[modelId] ?? { id: modelId, name: modelId };
    patch(p.id, { modelDetails: { ...(p.modelDetails ?? {}), [modelId]: { ...current, ...details } } });
  };
  const addObjectEntry = (field: 'headers' | 'compat') => {
    if (!p) return;
    const current = field === 'headers' ? p.headers ?? {} : p.compat ?? {};
    let key = field === 'headers' ? 'X-Title' : 'supportsReasoningEffort';
    let i = 2;
    while (key in current) key = `${field === 'headers' ? 'X-Header' : 'option'}${i++}`;
    patch(p.id, { [field]: { ...current, [key]: field === 'headers' ? '' : true } });
  };

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex w-[264px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-side)]">
        <div className="px-4 pb-3 pt-4 text-[17px] font-semibold text-[var(--text)]">提供商配置</div>
        <div className="scroll-thin flex-1 overflow-y-auto px-2 pb-2">
          {providers.map((x) => (
            <button
              key={x.id}
              onClick={() => {
                setSel(x.id);
                setShowKey(false);
              }}
              className={cn(
                'mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-[var(--bg-hover)]',
                p?.id === x.id && 'bg-[var(--bg-active)]',
              )}
            >
              <Avatar p={x} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium text-[var(--text)]">{x.name}</div>
                <div className="text-[12px] text-[var(--text-3)]">{x.models.length} 个模型</div>
              </div>
              <span className={cn('h-2 w-2 shrink-0 rounded-full', x.enabled ? 'bg-[#3fb950]' : 'bg-[var(--text-3)]/50')} />
            </button>
          ))}
        </div>
        <div className="border-t border-[var(--border)] p-2">
          <button onClick={() => setAdding(true)} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-[13.5px] text-[var(--text)] hover:bg-[var(--bg-hover)]">
            <Plus size={15} className="text-[var(--text-2)]" /> 添加提供商
          </button>
        </div>
      </div>

      <div className="scroll-thin min-w-0 flex-1 overflow-y-auto bg-[var(--bg-main)]">
        {p ? (
          <div key={p.id} className="fade-in mx-auto max-w-[740px] px-10 pb-16 pt-12">
            <div className="mb-8 flex items-center gap-4">
              <Avatar p={p} size={44} />
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[26px] font-medium text-[var(--text)]">{p.name}</h2>
                <div className="text-[13px] text-[var(--text-3)]">{kindMeta[p.kind].label} · {p.enabled ? '已启用，模型会出现在输入框的模型列表中' : '未启用'}</div>
              </div>
              <Toggle on={p.enabled} onChange={(v) => patch(p.id, { enabled: v })} />
            </div>

            <h3 className="mb-3 text-[14px] font-medium text-[var(--text)]">连接</h3>
            <Card className="mb-8 p-4">
              <Field label="Base URL">
                <input value={p.baseUrl} onChange={(e) => patch(p.id, { baseUrl: e.target.value })} className={cn(inputCls, 'font-mono text-[12.5px]')} />
              </Field>
              <Field label="接口类型" hint="Pi 使用的协议适配器，例如 openai-responses、openai-completions 或 anthropic-messages">
                <input value={p.api ?? ''} onChange={(e) => patch(p.id, { api: e.target.value })} placeholder="openai-responses" className={cn(inputCls, 'font-mono text-[12.5px]')} />
              </Field>
              <Field label="API Key" hint={p.kind === 'ollama' ? '本地 Ollama 无需 API Key' : '密钥仅保存在本机，不会上传'}>
                <div className="relative">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={p.apiKey}
                    onChange={(e) => patch(p.id, { apiKey: e.target.value })}
                    placeholder={p.kind === 'ollama' ? '（可留空）' : 'sk-…'}
                    className={cn(inputCls, 'pr-10 font-mono text-[12.5px]')}
                  />
                  <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)]">
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </Field>
              <div className="flex items-center gap-3">
                <Btn onClick={() => runTest(p)} disabled={t?.s === 'testing'}>
                  检查配置
                </Btn>
                {t && (
                  <span
                    className={cn(
                      'flex items-center gap-1.5 text-[12.5px]',
                      t.s === 'ok' && 'text-[#3fb950]',
                      t.s === 'error' && 'text-[#f85149]',
                      t.s === 'testing' && 'text-[var(--text-2)]',
                    )}
                  >
                    {t.s === 'ok' ? <CircleCheck size={14} /> : t.s === 'error' ? <CircleAlert size={14} /> : <LoaderCircle size={14} className="animate-spin" />}
                    {t.msg}
                  </span>
                )}
              </div>
            </Card>

            <h3 className="mb-3 text-[14px] font-medium text-[var(--text)]">请求头</h3>
            <Card className="mb-8 p-4">
              <div className="mb-3 text-[12.5px] text-[var(--text-3)]">随该提供商请求发送的自定义 HTTP 请求头。</div>
              <div className="space-y-2">
                {Object.entries(p.headers ?? {}).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2">
                    <input value={key} onChange={(e) => { const next = { ...(p.headers ?? {}) }; delete next[key]; next[e.target.value] = value; patch(p.id, { headers: next }); }} className={cn(inputCls, 'font-mono text-[12px]')} placeholder="请求头" />
                    <input value={value} onChange={(e) => patch(p.id, { headers: { ...(p.headers ?? {}), [key]: e.target.value } })} className={cn(inputCls, 'font-mono text-[12px]')} placeholder="值" />
                    <button title="删除请求头" onClick={() => { const next = { ...(p.headers ?? {}) }; delete next[key]; patch(p.id, { headers: next }); }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-3)] hover:bg-[var(--bg-hover)] hover:text-[#f85149]"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
              <button onClick={() => addObjectEntry('headers')} className="mt-3 flex items-center gap-1.5 text-[12.5px] text-[var(--text-2)] hover:text-[var(--text)]"><Plus size={14} /> 添加请求头</button>
            </Card>

            <h3 className="mb-3 text-[14px] font-medium text-[var(--text)]">接口兼容性</h3>
            <Card className="mb-8 p-4">
              <div className="mb-3 text-[12.5px] text-[var(--text-3)]">调整兼容层发送请求时的行为，值会原样写入 Pi 配置。</div>
              <div className="space-y-2">
                {Object.entries(p.compat ?? {}).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2">
                    <input value={key} onChange={(e) => { const next = { ...(p.compat ?? {}) }; delete next[key]; next[e.target.value] = value; patch(p.id, { compat: next }); }} className={cn(inputCls, 'font-mono text-[12px]')} placeholder="选项" />
                    <input value={String(value)} onChange={(e) => { const raw = e.target.value; const parsed = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw; patch(p.id, { compat: { ...(p.compat ?? {}), [key]: parsed } }); }} className={cn(inputCls, 'font-mono text-[12px]')} placeholder="值" />
                    <button title="删除兼容选项" onClick={() => { const next = { ...(p.compat ?? {}) }; delete next[key]; patch(p.id, { compat: next }); }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-3)] hover:bg-[var(--bg-hover)] hover:text-[#f85149]"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
              <button onClick={() => addObjectEntry('compat')} className="mt-3 flex items-center gap-1.5 text-[12.5px] text-[var(--text-2)] hover:text-[var(--text)]"><Plus size={14} /> 添加兼容选项</button>
            </Card>

            <h3 className="mb-3 text-[14px] font-medium text-[var(--text)]">模型</h3>
            <Card className="mb-8">
              {p.models.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-[var(--text-3)]">还没有模型，在下方添加模型 ID。</div>}
              {p.models.map((m) => {
                const id = `${p.id}:${m}`;
                const isDefault = defaultModel === id;
                return (
                  <div key={m} className="border-b border-[var(--border)] last:border-b-0">
                    <div className="flex items-center gap-3 px-4 py-2.5">
                    <button title="展开模型详情" onClick={() => setOpenModel(openModel === m ? null : m)} className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)]">{openModel === m ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-[var(--text)]">{m}</span>
                    {isDefault ? (
                      <span className="flex items-center gap-1 rounded-md bg-[var(--bg-active)] px-2 py-0.5 text-[12px] text-[var(--text)]">
                        <Star size={11} fill="currentColor" /> 默认
                      </span>
                    ) : (
                      <button
                        disabled={!p.enabled}
                        title={p.enabled ? '' : '请先启用该提供商'}
                        onClick={() => {
                          onSetDefault(id);
                          onToast(`默认模型已设为 ${m}`);
                        }}
                        className="rounded-md px-2 py-0.5 text-[12px] text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40"
                      >
                        设为默认
                      </button>
                    )}
                    <button onClick={() => patch(p.id, { models: p.models.filter((x) => x !== m) })} className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-3)] hover:bg-[var(--bg-hover)] hover:text-[#f85149]">
                      <X size={14} />
                    </button>
                    </div>
                    {openModel === m && (() => {
                      const d = p.modelDetails?.[m] ?? {};
                      const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
                      return <div className="space-y-3 bg-[var(--bg-hover)]/40 px-12 pb-4 pt-1">
                        <Field label="显示名称"><input value={d.name ?? m} onChange={(e) => patchModel(m, { name: e.target.value })} className={cn(inputCls, 'font-mono text-[12px]')} /></Field>
                        <div className="grid grid-cols-2 gap-3">
                          <label className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2 text-[12.5px] text-[var(--text)]">支持深度思考 <Toggle on={!!d.reasoning} onChange={(value) => patchModel(m, { reasoning: value })} /></label>
                          <label className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2 text-[12.5px] text-[var(--text)]">支持图片输入 <Toggle on={(d.input ?? []).includes('image')} onChange={(value) => patchModel(m, { input: value ? Array.from(new Set([...(d.input ?? ['text']), 'image'])) : (d.input ?? ['text']).filter((x) => x !== 'image') })} /></label>
                        </div>
                        <div className="grid grid-cols-2 gap-3"><Field label="上下文长度"><input type="number" value={d.contextWindow ?? ''} onChange={(e) => patchModel(m, { contextWindow: e.target.value ? Number(e.target.value) : undefined })} className={cn(inputCls, 'font-mono text-[12px]')} /></Field><Field label="最大输出 Token 数"><input type="number" value={d.maxTokens ?? ''} onChange={(e) => patchModel(m, { maxTokens: e.target.value ? Number(e.target.value) : undefined })} className={cn(inputCls, 'font-mono text-[12px]')} /></Field></div>
                        <div><div className="mb-2 text-[12.5px] font-medium text-[var(--text-2)]">思考档位映射</div><div className="grid grid-cols-2 gap-2">{levels.map((level) => <div key={level} className="flex items-center gap-2"><span className="w-16 text-[12px] text-[var(--text-2)]">{level}</span><input value={d.thinkingLevelMap?.[level] ?? ''} placeholder="跟随 Pi 默认" onChange={(e) => patchModel(m, { thinkingLevelMap: { ...(d.thinkingLevelMap ?? {}), [level]: e.target.value || null } })} className={cn(inputCls, 'h-8 font-mono text-[12px]')} /></div>)}</div></div>
                      </div>;
                    })()}
                  </div>
                );
              })}
              <form
                className="flex items-center gap-2 border-t border-[var(--border)] p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  addModel();
                }}
              >
                <input value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="添加模型 ID，例如 gpt-5-codex" className={cn(inputCls, 'h-9 font-mono text-[12.5px]')} />
                <Btn type="submit" disabled={!newModel.trim()}>
                  <Plus size={13} /> 添加
                </Btn>
              </form>
            </Card>

            {p.custom && (
              <Btn
                variant="danger"
                onClick={() => {
                  setProviders((ps) => ps.filter((x) => x.id !== p.id));
                  setSel(providers.find((x) => x.id !== p.id)?.id ?? '');
                  onToast(`已删除提供商 ${p.name}`);
                }}
              >
                <Trash2 size={13} /> 删除此提供商
              </Btn>
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-[13.5px] text-[var(--text-3)]">暂无提供商，点击左下角添加。</div>
        )}
      </div>

      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onAdd={(np) => {
            setProviders((ps) => [...ps, np]);
            setSel(np.id);
            setAdding(false);
            onToast(`已添加提供商 ${np.name}`);
          }}
        />
      )}
    </div>
  );
}
