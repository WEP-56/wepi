import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Trash2,
  RefreshCw,
  Wrench,
  Download,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Search,
  Layers,
  LogIn,
} from 'lucide-react';
import { Btn, Modal, Field, inputCls, Segmented, Card } from '../kit';
import { Toggle } from '../ui';
import { cn } from '../../utils/cn';
import { isDesktopRuntime } from '../../lib/piRpc';
import {
  mcpApi,
  adminErrorMessage,
  type McpSnapshot,
  type McpListItem,
  type McpServerDefinition,
  type McpExposure,
  type McpImportScan,
  type McpProbeResult,
} from '../../lib/piAdmin';

/* ---------- 纯工具：与后端/PiDeck 的字段口径一致 ---------- */

type Transport = 'stdio' | 'http';

const inferTransport = (def: McpServerDefinition | null | undefined): Transport | null => {
  if (!def) return null;
  const hasCommand = typeof def.command === 'string' && def.command.trim().length > 0;
  const hasUrl = typeof def.url === 'string' && def.url.trim().length > 0;
  const count = Number(hasCommand) + Number(hasUrl);
  if (count !== 1) return null;
  if (hasCommand) return 'stdio';
  if (hasUrl) return 'http';
  return 'http';
};

const isServerDisabled = (def: McpServerDefinition | null | undefined) => {
  if (!def) return false;
  if (def.enabled === false) return true;
  return def.disabled === true;
};

const argsToText = (args?: string[]) => (args ?? []).join(' ');
const textToArgs = (text: string) => text.split(/\s+/).filter(Boolean);
const recordToText = (record?: Record<string, string>) =>
  Object.entries(record ?? {}).map(([key, value]) => `${key}=${value}`).join('\n');
const textToRecord = (text: string) =>
  Object.fromEntries(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('=') && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()] as [string, string];
      }),
  );

const layerLabels: Record<string, string> = {
  'user-config': '用户配置',
  agents: 'Agents 目录',
  'agents-dir': 'Agents 子目录',
  'pi-agent': 'Pi 配置',
};

const blankDefinition = (transport: Transport): McpServerDefinition =>
  transport === 'http' ? { url: 'https://' } : { command: 'npx', args: ['-y'] };

const exposureOptions: { value: McpExposure; label: string }[] = [
  { value: 'codemode', label: 'Codemode（默认）' },
  { value: 'deferred', label: 'Deferred（工具搜索）' },
  { value: 'direct', label: 'Direct（直接披露）' },
  { value: 'hidden', label: 'Hidden（隐藏）' },
];

const exposureMapToText = (record?: Record<string, McpExposure>) =>
  Object.entries(record ?? {}).map(([key, value]) => `${key}=${value}`).join('\n');
const textToExposureMap = (text: string): Record<string, McpExposure> => {
  const valid = new Set<McpExposure>(['codemode', 'deferred', 'direct', 'hidden']);
  return Object.fromEntries(
    text.split('\n').map((line) => line.trim()).filter((line) => line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        const value = line.slice(index + 1).trim() as McpExposure;
        return [line.slice(0, index).trim(), value] as [string, McpExposure];
      }).filter(([key, value]) => key && valid.has(value)),
  );
};

/* ---------- 编辑器表单 ---------- */

function ServerEditor({
  name,
  onNameChange,
  definition,
  onPatch,
  transport,
  onTransportChange,
  disabledName,
  probe,
  probing,
  onProbe,
  onLogin,
  loggingIn,
  originPath,
  ownedByWritable,
  onRemove,
  removeLabel,
}: {
  name: string;
  onNameChange: (value: string) => void;
  definition: McpServerDefinition;
  onPatch: (patch: Partial<McpServerDefinition>) => void;
  transport: Transport | null;
  onTransportChange: (next: Transport) => void;
  disabledName: boolean;
  probe: McpProbeResult | null;
  probing: boolean;
  onProbe: () => void;
  onLogin?: () => void;
  loggingIn?: boolean;
  originPath?: string;
  ownedByWritable?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="名称" hint={disabledName ? undefined : '小写字母、数字、下划线与连字符'}>
        <input
          value={name}
          disabled={disabledName}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="chrome-devtools"
          className={cn(inputCls, 'font-mono text-[12.5px]')}
        />
      </Field>
      <Field label="传输方式">
        <Segmented
          value={transport ?? 'stdio'}
          onChange={onTransportChange}
          options={[
            { value: 'stdio', label: '本地进程 (stdio)' },
            { value: 'http', label: '远程 (HTTP)' },
          ]}
        />
      </Field>
      {transport === 'stdio' && (
        <>
          <Field label="命令">
            <input value={definition.command ?? ''} onChange={(e) => onPatch({ command: e.target.value, url: undefined })} placeholder="npx" className={cn(inputCls, 'font-mono text-[12.5px]')} />
          </Field>
          <Field label="参数" hint="以空格分隔">
            <input value={argsToText(definition.args)} onChange={(e) => onPatch({ args: textToArgs(e.target.value) })} placeholder="-y chrome-devtools-mcp" className={cn(inputCls, 'font-mono text-[12.5px]')} />
          </Field>
          <Field label="环境变量" hint="每行一个 KEY=VALUE，# 开头的行忽略">
            <textarea
              value={recordToText(definition.env)}
              onChange={(e) => onPatch({ env: textToRecord(e.target.value) })}
              rows={3}
              placeholder="API_KEY=xxxx"
              className="scroll-thin w-full resize-none rounded-xl border border-[var(--border-strong)] bg-transparent px-3 py-2 font-mono text-[12.5px] leading-6 text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--blue)]"
            />
          </Field>
          <Field label="工作目录" hint="可使用 ~；相对路径相对于 Pi 会话目录">
            <input value={definition.cwd ?? ''} onChange={(e) => onPatch({ cwd: e.target.value || undefined })} placeholder="~/projects/my-mcp" className={cn(inputCls, 'font-mono text-[12.5px]')} />
          </Field>
        </>
      )}
      {transport === 'http' && (
        <>
          <Field label="服务器 URL" hint="需以 http:// 或 https:// 开头；Pi 使用 streamable HTTP">
            <input value={definition.url ?? ''} onChange={(e) => onPatch({ url: e.target.value, command: undefined, args: undefined, env: undefined, cwd: undefined })} placeholder="https://mcp.example.com/mcp" className={cn(inputCls, 'font-mono text-[12.5px]')} />
          </Field>
          <Field label="请求头" hint="每行一个 Header=VALUE，值可使用 ${ENV_VAR} 或 !command">
            <textarea value={recordToText(definition.headers)} onChange={(e) => onPatch({ headers: textToRecord(e.target.value) })} rows={3} placeholder="Authorization=Bearer ${MCP_TOKEN}" className="scroll-thin w-full resize-none rounded-xl border border-[var(--border-strong)] bg-transparent px-3 py-2 font-mono text-[12.5px] leading-6 text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--blue)]" />
          </Field>
          <Field label="OAuth 配置" hint="留空则使用 Pi 的动态注册；登录由 Pi 保存到 mcp-auth.json">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input value={definition.oauth?.clientId ?? ''} onChange={(e) => onPatch({ oauth: { ...definition.oauth, clientId: e.target.value || undefined } })} placeholder="clientId（可选）" className={cn(inputCls, 'font-mono text-[12px]')} />
              <input type="password" value={definition.oauth?.clientSecret ?? ''} onChange={(e) => onPatch({ oauth: { ...definition.oauth, clientSecret: e.target.value || undefined } })} placeholder="clientSecret / ${ENV_VAR}" className={cn(inputCls, 'font-mono text-[12px]')} />
              <input value={definition.oauth?.scope ?? ''} onChange={(e) => onPatch({ oauth: { ...definition.oauth, scope: e.target.value || undefined } })} placeholder="scope（空格分隔）" className={cn(inputCls, 'font-mono text-[12px]')} />
              <input value={definition.oauth?.clientName ?? ''} onChange={(e) => onPatch({ oauth: { ...definition.oauth, clientName: e.target.value || undefined } })} placeholder="clientName（可选）" className={cn(inputCls, 'font-mono text-[12px]')} />
              <input value={definition.oauth?.callbackPort ?? ''} onChange={(e) => onPatch({ oauth: { ...definition.oauth, callbackPort: e.target.value ? Number(e.target.value) : undefined } })} type="number" min={1} max={65535} placeholder="callbackPort" className={cn(inputCls, 'font-mono text-[12px]')} />
              <input value={definition.oauth?.callbackUrl ?? ''} onChange={(e) => onPatch({ oauth: { ...definition.oauth, callbackUrl: e.target.value || undefined } })} placeholder="callbackUrl（仅 localhost）" className={cn(inputCls, 'font-mono text-[12px]')} />
              <input value={definition.oauth?.authServerMetadataUrl ?? ''} onChange={(e) => onPatch({ oauth: { ...definition.oauth, authServerMetadataUrl: e.target.value || undefined } })} placeholder="authServerMetadataUrl" className={cn(inputCls, 'font-mono text-[12px]')} />
              <select value={definition.oauth?.clientRegistration ?? ''} onChange={(e) => onPatch({ oauth: { ...definition.oauth, clientRegistration: e.target.value === 'cimd' ? 'cimd' : undefined } })} className={cn(inputCls, 'text-[12px]')}>
                <option value="">动态注册（默认）</option>
                <option value="cimd">CIMD 客户端元数据</option>
              </select>
            </div>
          </Field>
        </>
      )}
      <Field label="工具披露模式" hint="决定模型如何发现该服务器的工具">
        <Segmented value={definition.exposure ?? 'codemode'} onChange={(value) => onPatch({ exposure: value as McpExposure })} options={exposureOptions} />
      </Field>
      <Field label="工具级披露覆盖" hint="每行 tool 名称或通配模式=codemode|deferred|direct|hidden">
        <textarea value={exposureMapToText(definition.toolExposure)} onChange={(e) => onPatch({ toolExposure: textToExposureMap(e.target.value) })} rows={3} placeholder={'search_code=direct\ndelete_*=hidden'} className="scroll-thin w-full resize-none rounded-xl border border-[var(--border-strong)] bg-transparent px-3 py-2 font-mono text-[12.5px] leading-6 text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--blue)]" />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="请求超时（秒）" hint="默认 60；进度通知会重置计时">
          <input type="number" min={1} value={definition.timeout ?? ''} onChange={(e) => onPatch({ timeout: e.target.value ? Number(e.target.value) : undefined })} placeholder="60" className={cn(inputCls, 'font-mono text-[12.5px]')} />
        </Field>
        <Field label="服务器描述" hint="会出现在系统提示词中">
          <input value={definition.description ?? ''} onChange={(e) => onPatch({ description: e.target.value || undefined })} placeholder="搜索并读取产品文档" className={cn(inputCls, 'text-[12.5px]')} />
        </Field>
      </div>
      {originPath && (
        <div className="rounded-xl bg-[var(--bg-hover)] px-3 py-2 text-[12px] text-[var(--text-3)]" title={originPath}>
          来源：{originPath}
          {ownedByWritable === false && ' · 定义在只读层，停用会写覆盖项'}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Btn onClick={onProbe} disabled={probing}>
          <Wrench size={13} /> {probing ? '探测中…' : '连通性探测'}
        </Btn>
        {transport === 'http' && onLogin && (
          <Btn onClick={onLogin} disabled={loggingIn}>
            <LogIn size={13} /> {loggingIn ? '等待授权…' : '使用 Pi 登录 OAuth'}
          </Btn>
        )}
        {onRemove && (
          <Btn variant="danger" onClick={onRemove}>
            <Trash2 size={13} /> {removeLabel ?? '删除'}
          </Btn>
        )}
      </div>
      {probe && (
        <div
          className={cn(
            'flex items-start gap-2 rounded-xl border px-3 py-2 text-[12.5px]',
            probe.ok ? 'border-[#3fb950]/40 text-[#3fb950]' : 'border-[#f85149]/40 text-[#f85149]',
          )}
        >
          {probe.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <XCircle size={14} className="mt-0.5 shrink-0" />}
          <div>
            {probe.ok ? '可达' : '不可达'}
            {probe.detail ? ` · ${probe.detail}` : probe.error ? ` · ${probe.error}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- 导入对话框 ---------- */

function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [scan, setScan] = useState<McpImportScan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const next = await mcpApi.importScan();
      setScan(next);
      // 默认选中全部可导入项（PiDeck 行为：可一键全选导入）。
      setSelected(new Set(next.candidates.filter((item) => item.importable).map((item) => item.name)));
    } catch (caught) {
      setError(adminErrorMessage(caught, '扫描常用目录失败'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = (name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const importable = scan?.candidates.filter((item) => item.importable) ?? [];
  const allSelected = importable.length > 0 && importable.every((item) => selected.has(item.name));

  const apply = async () => {
    if (!scan) return;
    setApplying(true);
    setError('');
    try {
      const entries = scan.candidates
        .filter((item) => selected.has(item.name) && item.importable && item.definition)
        .map((item) => [item.name, item.definition!] as [string, McpServerDefinition]);
      if (entries.length === 0) {
        setError('请至少选择一个要导入的服务器');
        return;
      }
      const result = await mcpApi.importApply(entries, overwrite);
      onImported();
      onClose();
      if (result.skipped.length > 0) window.setTimeout(() => setError(''), 0);
    } catch (caught) {
      setError(adminErrorMessage(caught, '导入失败'));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal title="从其他客户端导入 MCP" onClose={onClose} width={640}>
      <p className="mb-4 text-[12.5px] leading-5 text-[var(--text-2)]">
        扫描本机常用目录：Claude Desktop / Claude CLI（JSON）与 Codex（TOML）。探测只检查配置有效性，不会启动服务器。
      </p>
      {scan && (
        <div className="mb-4 space-y-1.5">
          {scan.sources.map((source) => (
            <div key={source.path} className="flex items-center gap-2 text-[12px]">
              <span className={cn('h-1.5 w-1.5 rounded-full', source.exists ? 'bg-[#3fb950]' : 'bg-[var(--text-3)]')} />
              <span className="text-[var(--text-2)]">{source.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-3)]" title={source.path}>{source.path}</span>
              {source.error ? (
                <span className="text-[#f85149]">{source.error}</span>
              ) : source.exists ? (
                <span className="text-[var(--text-3)]">{source.count ?? 0} 个</span>
              ) : (
                <span className="text-[var(--text-3)]">未找到</span>
              )}
            </div>
          ))}
        </div>
      )}
      {error && <div className="mb-3 rounded-xl border border-[#f85149]/40 px-3 py-2 text-[12.5px] text-[#f85149]">{error}</div>}
      {scan && scan.candidates.length > 0 && (
        <>
          <div className="mb-2 flex items-center gap-2">
            <button
              onClick={() => setSelected(allSelected ? new Set() : new Set(importable.map((item) => item.name)))}
              className="text-[12.5px] text-[var(--text-2)] hover:text-[var(--text)]"
            >
              {allSelected ? '取消全选' : '全选可导入项'}
            </button>
            <div className="flex-1" />
            <span className="text-[12px] text-[var(--text-3)]">已选 {selected.size} / {scan.candidates.length}</span>
          </div>
          <div className="scroll-thin max-h-[320px] space-y-1.5 overflow-y-auto pr-1">
            {scan.candidates.map((candidate) => (
              <div
                key={`${candidate.sourceLabel}:${candidate.name}`}
                className={cn(
                  'flex items-start gap-3 rounded-xl border px-3 py-2.5',
                  candidate.importable ? 'border-[var(--border)] bg-[var(--bg-card)]' : 'border-[var(--border)] opacity-60',
                )}
              >
                <input
                  type="checkbox"
                  checked={selected.has(candidate.name)}
                  disabled={!candidate.importable}
                  onChange={() => toggle(candidate.name)}
                  className="mt-1 h-3.5 w-3.5 shrink-0 accent-[var(--blue)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[13px] font-medium text-[var(--text)]">{candidate.name}</span>
                    {candidate.transport && <span className="rounded-md bg-[var(--bg-hover)] px-1.5 py-0.5 text-[11px] text-[var(--text-2)]">{candidate.transport}</span>}
                    <span className="text-[11px] text-[var(--text-3)]">{candidate.sourceLabel}</span>
                  </div>
                  {candidate.definition && (
                    <div className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--text-3)]">
                      {candidate.definition.command
                        ? `${candidate.definition.command} ${(candidate.definition.args ?? []).join(' ')}`
                        : candidate.definition.url ?? ''}
                    </div>
                  )}
                  {(candidate.blocker || candidate.warnings.length > 0) && (
                    <div className="mt-1 flex flex-col gap-0.5">
                      {candidate.blocker && <span className="flex items-center gap-1 text-[11.5px] text-[#f85149]"><AlertTriangle size={11} />{candidate.blocker}</span>}
                      {candidate.warnings.map((warning) => (
                        <span key={warning} className="flex items-center gap-1 text-[11.5px] text-[#d29922]"><AlertTriangle size={11} />{warning}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {scan && scan.candidates.length === 0 && !error && (
        <Card className="py-10 text-center text-[13px] text-[var(--text-3)]">常用目录里没有找到可导入的 MCP 配置</Card>
      )}
      {!scan && !error && <Card className="py-10 text-center text-[13px] text-[var(--text-3)]">正在扫描…</Card>}
      <div className="mt-5 flex items-center gap-3">
        <Toggle on={overwrite} onChange={setOverwrite} />
        <span className="text-[12.5px] text-[var(--text-2)]">同名时覆盖已有配置</span>
        <div className="flex-1" />
        <Btn variant="ghost" onClick={onClose}>取消</Btn>
        <Btn variant="primary" disabled={applying || selected.size === 0} onClick={apply}>
          <Download size={13} /> {applying ? '导入中…' : `导入 ${selected.size} 项`}
        </Btn>
      </div>
    </Modal>
  );
}

/* ---------- 主页面 ---------- */

export default function McpPage({ onToast }: { onToast: (s: string) => void }) {
  const [snapshot, setSnapshot] = useState<McpSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ name: string; definition: McpServerDefinition } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'list' | 'json'>('list');
  const [jsonDraft, setJsonDraft] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [probe, setProbe] = useState<McpProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [search, setSearch] = useState('');
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError('');
    try {
      const next = await mcpApi.snapshot();
      if (generation !== loadGeneration.current) return;
      setSnapshot(next);
      setDirty(false);
      setCreating(null);
      setProbe(null);
      const names = next.servers.map((item) => item.name);
      setSelected((current) => (current && names.includes(current) ? current : names[0] ?? null));
      setJsonDraft(next.writableRaw);
    } catch (caught) {
      if (generation === loadGeneration.current) setError(adminErrorMessage(caught, '读取 MCP 配置失败'));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  const servers = useMemo(() => {
    const list = snapshot?.servers ?? [];
    if (!search.trim()) return list;
    return list.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()));
  }, [snapshot, search]);

  const selectedItem: McpListItem | null = useMemo(
    () => servers.find((item) => item.name === selected) ?? null,
    [servers, selected],
  );

  const editingDef = creating ? creating.definition : selectedItem?.definition ?? blankDefinition('stdio');
  const transport = inferTransport(editingDef);

  const applyWritable = useCallback((mutate: (servers: Record<string, McpServerDefinition>) => Record<string, McpServerDefinition>) => {
    setSnapshot((current) => {
      if (!current) return current;
      const base = current.writableFile.mcpServers ?? {};
      return { ...current, writableFile: { ...current.writableFile, mcpServers: mutate({ ...base }) } };
    });
    setDirty(true);
  }, []);

  const upsert = useCallback(
    (name: string, definition: McpServerDefinition) => {
      applyWritable((servers) => ({ ...servers, [name]: definition }));
    },
    [applyWritable],
  );

  const patchEditing = (patch: Partial<McpServerDefinition>) => {
    if (creating) {
      setCreating({ ...creating, definition: { ...creating.definition, ...patch } });
      setDirty(true);
      return;
    }
    if (selected) upsert(selected, { ...editingDef, ...patch });
  };

  const switchTransport = (next: Transport) => {
    // 切换传输时保留启停与变量字段，清掉互斥的传输定义。
    const kept = {
      env: editingDef.env,
      headers: editingDef.headers,
      enabled: editingDef.enabled,
      disabled: editingDef.disabled,
      timeout: editingDef.timeout,
      exposure: editingDef.exposure,
      toolExposure: editingDef.toolExposure,
      description: editingDef.description,
    };
    const nextDef = { ...blankDefinition(next), ...kept };
    if (creating) {
      setCreating({ ...creating, definition: nextDef });
      setDirty(true);
      return;
    }
    if (selected) upsert(selected, nextDef);
  };

  const toggleDisabled = (item: McpListItem, disabled: boolean) => {
    const existing = snapshot?.writableFile.mcpServers?.[item.name];
    if (existing) {
      upsert(item.name, { ...existing, enabled: !disabled, disabled: disabled ? true : false });
      return;
    }
    // 只读层来源：仅写停用覆盖项，不复制传输定义。
    upsert(item.name, { enabled: !disabled, disabled });
  };

  const removeSelected = () => {
    if (!selected || !snapshot) return;
    applyWritable((servers) => {
      delete servers[selected];
      return servers;
    });
    const remaining = servers.filter((item) => item.name !== selected);
    setSelected(remaining[0]?.name ?? null);
    setProbe(null);
  };

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await mcpApi.probe(editingDef));
    } catch (caught) {
      setProbe({ ok: false, error: adminErrorMessage(caught, '探测失败') });
    } finally {
      setProbing(false);
    }
  };

  const login = async () => {
    if (!selected) return;
    setLoggingIn(true);
    try {
      await mcpApi.login(selected);
      onToast('Pi OAuth 登录完成');
    } catch (caught) {
      onToast(adminErrorMessage(caught, 'Pi OAuth 登录失败'));
    } finally {
      setLoggingIn(false);
    }
  };

  const save = async () => {
    if (!snapshot) return;
    if (snapshot.writableError) {
      setError('可写层 mcp.json 已损坏，请先在源文件页修复后再使用可视化编辑');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (tab === 'json') {
        // 源文件模式：直接采用文本框内容（后端会做完整校验）。
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonDraft);
        } catch (caught) {
          setJsonError('JSON 无效：' + (caught as Error).message);
          return;
        }
        await mcpApi.save(parsed);
        setJsonError('');
      } else {
        const toSave = { ...snapshot.writableFile };
        if (creating) {
          const name = creating.name.trim();
          if (!name) { setError('服务器名称不能为空'); return; }
          if (servers.some((item) => item.name === name) || snapshot.writableFile.mcpServers?.[name]) {
            setError(`服务器「${name}」已存在`);
            return;
          }
          toSave.mcpServers = { ...(toSave.mcpServers ?? {}), [name]: creating.definition };
        }
        await mcpApi.save(toSave);
      }
      await load();
      if (creating?.name.trim()) setSelected(creating.name.trim());
      onToast('MCP 配置已保存（重启会话后生效）');
    } catch (caught) {
      const message = adminErrorMessage(caught, '保存失败');
      if (tab === 'json') setJsonError(message);
      else setError(message);
    } finally {
      setSaving(false);
    }
  };

  const enabledCount = (snapshot?.servers ?? []).filter((item) => !isServerDisabled(item.definition)).length;

  return (
    <div className="scroll-thin min-w-0 flex-1 overflow-y-auto bg-[var(--bg-main)]">
      <div className="fade-in mx-auto max-w-[880px] px-10 pb-16 pt-12">
        <div className="mb-6 flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[28px] font-medium text-[var(--text)]">MCP 配置</h2>
            <p className="mt-2 max-w-[580px] text-[13.5px] leading-6 text-[var(--text-2)]">
              管理 Model Context Protocol 服务器。多来源配置按层级合并，修改写入 Pi 的 mcp.json，重启会话后生效。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-1">
            <Btn onClick={() => void load()} disabled={loading || saving}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> 刷新
            </Btn>
            <Btn onClick={() => setImportOpen(true)}>
              <Download size={14} /> 导入
            </Btn>
            <Btn variant="primary" onClick={() => { setCreating({ name: '', definition: blankDefinition('stdio') }); setSelected(null); setProbe(null); setTab('list'); }} disabled={!!creating || saving}>
              <Plus size={14} /> 新建
            </Btn>
          </div>
        </div>

        {/* 层级状态条：显示四层全局来源的存在性与可写性 */}
        {snapshot && (
          <div className="mb-4 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Layers size={13} className="text-[var(--text-3)]" />
              {snapshot.layers.map((layer) => (
                <span
                  key={layer.kind}
                  title={layer.path}
                  className={cn(
                    'rounded-md border px-1.5 py-0.5 text-[11px]',
                    layer.exists ? 'border-[var(--border-strong)] text-[var(--text-2)]' : 'border-dashed border-[var(--border)] text-[var(--text-3)]',
                  )}
                >
                  {layerLabels[layer.kind] ?? layer.kind}
                  {layer.writable ? ' · 可写' : ''}
                  {layer.exists ? '' : ' · 缺失'}
                </span>
              ))}
            </div>
            <div className="truncate font-mono text-[11.5px] text-[var(--text-3)]" title={snapshot.writablePath}>
              写入目标：{snapshot.writablePath}
            </div>
          </div>
        )}

        {error && <div className="mb-4 rounded-xl border border-[#f85149]/40 px-3 py-2 text-[13px] text-[#f85149]">{error}</div>}
        {snapshot?.writableError && (
          <div className="mb-4 rounded-xl border border-[#d29922]/40 bg-[#d29922]/10 px-3 py-2 text-[12.5px] text-[#d29922]">
            mcp.json 解析失败：{snapshot.writableError}——可视化保存已禁用，请切换到源文件页修复。
          </div>
        )}

        <div className="mb-4 flex items-center gap-3">
          <Segmented
            value={tab}
            onChange={(value) => { setTab(value); if (value === 'json' && snapshot) { setJsonDraft(snapshot.writableRaw); setJsonError(''); } }}
            options={[
              { value: 'list', label: '服务器' },
              { value: 'json', label: '源文件' },
            ]}
          />
          {tab === 'list' && (
            <div className="flex h-9 max-w-[240px] flex-1 items-center gap-2 rounded-full bg-[var(--bg-hover)] px-3.5">
              <Search size={14} className="text-[var(--text-2)]" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索服务器" className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]" />
            </div>
          )}
          <div className="flex-1" />
          {tab === 'list' && snapshot && (
            <span className="text-[12.5px] text-[var(--text-3)]">{enabledCount} / {snapshot.servers.length} 已启用</span>
          )}
          <Btn variant="primary" onClick={save} disabled={saving || (!dirty && !creating) || (!!snapshot && !!snapshot.writableError && tab === 'list')}>
            {saving ? '保存中…' : dirty || creating ? '保存' : '已保存'}
          </Btn>
        </div>

        {tab === 'list' ? (
          <div className="grid grid-cols-[minmax(240px,300px)_minmax(0,1fr)] gap-4">
            {/* 服务器列表 */}
            <Card className="flex max-h-[560px] flex-col overflow-hidden">
              <div className="scroll-thin flex-1 overflow-y-auto">
                {creating && (
                  <div className="border-b border-[var(--border)] bg-[var(--bg-hover)] px-4 py-3">
                    <div className="font-mono text-[13px] text-[var(--text)]">{creating.name || '新服务器…'}</div>
                    <div className="mt-0.5 text-[11.5px] text-[var(--text-3)]">尚未保存</div>
                  </div>
                )}
                {servers.length === 0 && !creating && (
                  <div className="px-4 py-10 text-center text-[13px] text-[var(--text-3)]">
                    {loading ? '加载中…' : !isDesktopRuntime() ? '需要桌面版运行' : '还没有 MCP 服务器'}
                  </div>
                )}
                {servers.map((item) => {
                  const itemTransport = inferTransport(item.definition);
                  const itemDisabled = isServerDisabled(item.definition);
                  return (
                    <button
                      key={item.name}
                      onClick={() => { setSelected(item.name); setProbe(null); }}
                      className={cn(
                        'block w-full border-b border-[var(--border)] px-4 py-3 text-left last:border-b-0 hover:bg-[var(--bg-hover)]',
                        selected === item.name && 'bg-[var(--bg-active)]',
                        itemDisabled && 'opacity-60',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', itemDisabled ? 'bg-[var(--text-3)]' : 'bg-[#3fb950]')} />
                        <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium text-[var(--text)]">{item.name}</span>
                        {itemTransport && <span className="shrink-0 text-[11px] text-[var(--text-3)]">{itemTransport}</span>}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--text-3)]">
                        {item.definition.command
                          ? `${item.definition.command} ${(item.definition.args ?? []).join(' ')}`
                          : item.definition.url ?? '（仅停用覆盖）'}
                      </div>
                    </button>
                  );
                })}
              </div>
            </Card>

            {/* 详情编辑区 */}
            <Card className="p-5">
              {!selected && !creating ? (
                <div className="py-16 text-center text-[13px] text-[var(--text-3)]">选择左侧的服务器查看详情，或点击「新建」</div>
              ) : (
                <div className="flex flex-col gap-4">
                  <ServerEditor
                    name={creating ? creating.name : selected ?? ''}
                    onNameChange={(value) => { if (creating) { setCreating({ ...creating, name: value }); setDirty(true); } }}
                    definition={editingDef}
                    onPatch={patchEditing}
                    transport={transport}
                    onTransportChange={switchTransport}
                    disabledName={!creating}
                    probe={probe}
                    probing={probing}
                    onProbe={runProbe}
                    onLogin={selected && transport === 'http' ? login : undefined}
                    loggingIn={loggingIn}
                    originPath={selectedItem?.originPath}
                    ownedByWritable={selectedItem?.ownedByWritable}
                    onRemove={creating ? undefined : removeSelected}
                    removeLabel={selectedItem?.ownedByWritable ? '删除' : '停用（只读层来源）'}
                  />
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] px-3 py-2.5">
                    <div>
                      <div className="text-[13px] font-medium text-[var(--text)]">启用</div>
                      <div className="mt-0.5 text-[11.5px] text-[var(--text-3)]">停用后 Pi 会话不再连接该服务器</div>
                    </div>
                    <Toggle
                      on={!isServerDisabled(editingDef)}
                      onChange={(value) => {
                        if (creating) patchEditing({ enabled: value, disabled: !value });
                        else if (selectedItem) toggleDisabled(selectedItem, !value);
                      }}
                    />
                  </div>
                  {creating && (
                    <div className="flex items-center justify-end gap-2">
                      <Btn variant="ghost" onClick={() => { setCreating(null); setSelected(servers[0]?.name ?? null); }}>
                        取消新建
                      </Btn>
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>
        ) : (
          <div>
            <textarea
              value={jsonDraft}
              spellCheck={false}
              onChange={(e) => { setJsonDraft(e.target.value); setDirty(true); }}
              className="scroll-thin h-[440px] w-full resize-none rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 font-mono text-[12.5px] leading-6 text-[var(--text)] outline-none focus:border-[var(--blue)]"
            />
            {jsonError && <div className="mt-2 text-[12.5px] text-[#f85149]">{jsonError}</div>}
            <div className="mt-3 flex items-center gap-2">
              <Btn variant="primary" onClick={save} disabled={saving || !dirty}>保存到磁盘</Btn>
              <Btn onClick={() => { if (snapshot) { setJsonDraft(snapshot.writableRaw); setDirty(false); setJsonError(''); } }}>重置</Btn>
              <span className="ml-2 text-[12px] text-[var(--text-3)]">直接编辑 mcp.json 全文，保存前会做完整校验。</span>
            </div>
          </div>
        )}
      </div>

      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onImported={() => { void load(); onToast('导入完成'); }} />}
    </div>
  );
}
