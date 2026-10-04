import { useState } from 'react';
import { Plus, Pencil, Trash2, RefreshCw, ChevronRight, ChevronDown, Plug, Wrench } from 'lucide-react';
import { uid, type McpServer } from '../../data';
import { PageShell, Btn, Modal, Field, inputCls, Segmented, Card } from '../kit';
import { Toggle } from '../ui';
import { cn } from '../../utils/cn';

const statusMap = {
  connected: { color: '#3fb950', label: '已连接' },
  connecting: { color: '#d29922', label: '连接中…' },
  error: { color: '#f85149', label: '连接失败' },
  disabled: { color: 'var(--text-3)', label: '已停用' },
} as const;

const demoTools = (name: string) => [`${name}_list`, `${name}_get`, `${name}_search`];

const parseEnv = (env: string) =>
  Object.fromEntries(
    env
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );

const toJson = (servers: McpServer[]) =>
  JSON.stringify(
    {
      mcpServers: Object.fromEntries(
        servers.map((s) => {
          const env = parseEnv(s.env);
          const base =
            s.transport === 'stdio'
              ? {
                  command: s.command,
                  args: s.args.split(/\s+/).filter(Boolean),
                  ...(Object.keys(env).length ? { env } : {}),
                }
              : { url: s.url };
          return [s.name, s.enabled ? base : { ...base, disabled: true }];
        }),
      ),
    },
    null,
    2,
  );

function ServerForm({
  initial,
  onClose,
  onSave,
}: {
  initial: McpServer | null;
  onClose: () => void;
  onSave: (s: McpServer) => void;
}) {
  const [d, setD] = useState<McpServer>(
    initial ?? {
      id: uid(),
      name: '',
      transport: 'stdio',
      command: 'npx',
      args: '',
      url: '',
      env: '',
      enabled: true,
      status: 'connecting',
      tools: [],
    },
  );
  const set = (p: Partial<McpServer>) => setD((x) => ({ ...x, ...p }));
  const valid = d.name.trim() && (d.transport === 'stdio' ? d.command.trim() : /^https?:\/\//.test(d.url.trim()));
  return (
    <Modal title={initial ? '编辑 MCP 服务器' : '添加 MCP 服务器'} onClose={onClose} width={540}>
      <Field label="名称">
        <input autoFocus value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="例如 filesystem" className={inputCls} />
      </Field>
      <Field label="传输方式">
        <Segmented
          value={d.transport}
          onChange={(v) => set({ transport: v })}
          options={[
            { value: 'stdio', label: '本地进程 (stdio)' },
            { value: 'http', label: '远程 (HTTP / SSE)' },
          ]}
        />
      </Field>
      {d.transport === 'stdio' ? (
        <>
          <Field label="命令">
            <input value={d.command} onChange={(e) => set({ command: e.target.value })} placeholder="npx / uvx / node" className={cn(inputCls, 'font-mono text-[12.5px]')} />
          </Field>
          <Field label="参数" hint="以空格分隔">
            <input value={d.args} onChange={(e) => set({ args: e.target.value })} placeholder="-y @modelcontextprotocol/server-filesystem ." className={cn(inputCls, 'font-mono text-[12.5px]')} />
          </Field>
          <Field label="环境变量" hint="每行一个 KEY=VALUE">
            <textarea
              value={d.env}
              onChange={(e) => set({ env: e.target.value })}
              rows={3}
              placeholder="API_KEY=xxxx"
              className="scroll-thin w-full resize-none rounded-xl border border-[var(--border-strong)] bg-transparent px-3 py-2 font-mono text-[12.5px] leading-6 text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--blue)]"
            />
          </Field>
        </>
      ) : (
        <Field label="服务器 URL" hint="需以 http:// 或 https:// 开头">
          <input value={d.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://example.com/mcp" className={cn(inputCls, 'font-mono text-[12.5px]')} />
        </Field>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>
          取消
        </Btn>
        <Btn variant="primary" disabled={!valid} onClick={() => onSave({ ...d, name: d.name.trim() })}>
          保存
        </Btn>
      </div>
    </Modal>
  );
}

export default function McpPage({
  servers,
  setServers,
  onToast,
}: {
  servers: McpServer[];
  setServers: React.Dispatch<React.SetStateAction<McpServer[]>>;
  onToast: (s: string) => void;
}) {
  const [tab, setTab] = useState<'list' | 'json'>('list');
  const [editing, setEditing] = useState<McpServer | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [json, setJson] = useState('');
  const [jsonErr, setJsonErr] = useState('');

  const patch = (id: string, p: Partial<McpServer>) => setServers((ss) => ss.map((s) => (s.id === id ? { ...s, ...p } : s)));

  const connect = (s: McpServer) => {
    patch(s.id, { status: 'connecting' });
    setTimeout(() => {
      const bad = s.transport === 'http' && /example\.com/.test(s.url);
      const tools = s.tools.length ? s.tools : demoTools(s.name);
      setServers((ss) =>
        ss.map((x) => (x.id === s.id ? (bad ? { ...x, status: 'error', tools: [] } : { ...x, status: 'connected', tools }) : x)),
      );
      onToast(bad ? `${s.name} 连接失败：无法访问 ${s.url}` : `${s.name} 已连接，${tools.length} 个工具可用`);
    }, 900);
  };

  const toggle = (s: McpServer, on: boolean) => {
    if (on) {
      patch(s.id, { enabled: true });
      connect({ ...s, enabled: true });
    } else {
      patch(s.id, { enabled: false, status: 'disabled' });
    }
  };

  const save = (s: McpServer) => {
    const exists = servers.some((x) => x.id === s.id);
    const next: McpServer = { ...s, status: s.enabled ? 'connecting' : 'disabled' };
    setServers((ss) => (exists ? ss.map((x) => (x.id === s.id ? next : x)) : [...ss, next]));
    setEditing(null);
    if (s.enabled) connect(next);
  };

  const applyJson = () => {
    try {
      const obj = JSON.parse(json);
      const root = obj.mcpServers ?? obj;
      if (typeof root !== 'object' || root === null || Array.isArray(root)) throw new Error('缺少 mcpServers 对象');
      const next: McpServer[] = Object.entries(root as Record<string, Record<string, unknown>>).map(([name, c]) => {
        if (typeof c !== 'object' || c === null) throw new Error(`「${name}」的配置必须是对象`);
        const old = servers.find((s) => s.name === name);
        const http = typeof c.url === 'string';
        const enabled = !c.disabled;
        return {
          id: old?.id ?? uid(),
          name,
          transport: http ? 'http' : 'stdio',
          command: (c.command as string) ?? '',
          args: Array.isArray(c.args) ? (c.args as string[]).join(' ') : '',
          url: (c.url as string) ?? '',
          env: Object.entries((c.env as Record<string, string>) ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join('\n'),
          enabled,
          status: enabled ? old?.status ?? 'connecting' : 'disabled',
          tools: old?.tools ?? [],
        };
      });
      setServers(next);
      setJsonErr('');
      onToast(`已应用 ${next.length} 个服务器配置`);
      next.filter((s) => s.enabled && !servers.some((o) => o.id === s.id)).forEach(connect);
    } catch (e) {
      setJsonErr('JSON 无效：' + (e as Error).message);
    }
  };

  return (
    <PageShell
      title="MCP 配置"
      desc="管理 Agent 可使用的 Model Context Protocol 服务器，为 Agent 连接外部工具与数据源。"
      actions={
        <Btn variant="primary" onClick={() => setEditing('new')}>
          <Plus size={14} /> 添加服务器
        </Btn>
      }
    >
      <div className="mb-4 flex items-center">
        <Segmented
          value={tab}
          onChange={(v) => {
            setTab(v);
            if (v === 'json') {
              setJson(toJson(servers));
              setJsonErr('');
            }
          }}
          options={[
            { value: 'list', label: '服务器' },
            { value: 'json', label: 'JSON 配置' },
          ]}
        />
        <div className="flex-1" />
        <span className="text-[12.5px] text-[var(--text-3)]">
          {servers.filter((s) => s.enabled).length} / {servers.length} 已启用
        </span>
      </div>

      {tab === 'list' ? (
        servers.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 py-14 text-[var(--text-3)]">
            <Plug size={30} />
            <div className="text-[13.5px]">还没有 MCP 服务器</div>
            <Btn onClick={() => setEditing('new')}>添加第一个服务器</Btn>
          </Card>
        ) : (
          <Card>
            {servers.map((s) => {
              const st = statusMap[s.status];
              const isOpen = open === s.id;
              return (
                <div key={s.id} className="border-b border-[var(--border)] last:border-b-0">
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    <button onClick={() => setOpen(isOpen ? null : s.id)} className="text-[var(--text-3)] hover:text-[var(--text)]">
                      {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    </button>
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', s.status === 'connecting' && 'animate-pulse')} style={{ background: st.color }} title={st.label} />
                    <div className="min-w-0 flex-1 cursor-default" onClick={() => setOpen(isOpen ? null : s.id)}>
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] font-medium text-[var(--text)]">{s.name}</span>
                        <span className="rounded-md bg-[var(--bg-hover)] px-1.5 py-0.5 text-[11px] text-[var(--text-2)]">{s.transport === 'stdio' ? 'stdio' : 'HTTP'}</span>
                        <span className="text-[12px]" style={{ color: st.color }}>
                          {st.label}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[12px] text-[var(--text-3)]">
                        {s.transport === 'stdio' ? `${s.command} ${s.args}` : s.url}
                      </div>
                    </div>
                    <button title="重新连接" disabled={!s.enabled} onClick={() => connect(s)} className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-30 disabled:hover:bg-transparent">
                      <RefreshCw size={14} className={s.status === 'connecting' ? 'animate-spin' : ''} />
                    </button>
                    <button title="编辑" onClick={() => setEditing(s)} className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                      <Pencil size={14} />
                    </button>
                    <button
                      title="删除"
                      onClick={() => {
                        setServers((ss) => ss.filter((x) => x.id !== s.id));
                        onToast(`已删除 ${s.name}`);
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[#f85149]"
                    >
                      <Trash2 size={14} />
                    </button>
                    <Toggle on={s.enabled} onChange={(v) => toggle(s, v)} />
                  </div>
                  {isOpen && (
                    <div className="fade-in border-t border-[var(--border)] px-4 py-3 pl-[52px]">
                      <div className="mb-2 flex items-center gap-1.5 text-[12px] text-[var(--text-3)]">
                        <Wrench size={12} /> 提供的工具（{s.tools.length}）
                      </div>
                      {s.tools.length === 0 ? (
                        <div className="text-[12.5px] text-[var(--text-3)]">{s.enabled ? '暂无可用工具，请检查连接。' : '启用后将自动发现工具。'}</div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {s.tools.map((t) => (
                            <span key={t} className="rounded-md bg-[var(--bg-hover)] px-2 py-1 font-mono text-[12px] text-[var(--text)]">
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        )
      ) : (
        <div>
          <textarea
            value={json}
            spellCheck={false}
            onChange={(e) => setJson(e.target.value)}
            className="scroll-thin h-[380px] w-full resize-none rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 font-mono text-[12.5px] leading-6 text-[var(--text)] outline-none focus:border-[var(--blue)]"
          />
          {jsonErr && <div className="mt-2 text-[12.5px] text-[#f85149]">{jsonErr}</div>}
          <div className="mt-3 flex items-center gap-2">
            <Btn variant="primary" onClick={applyJson}>
              应用配置
            </Btn>
            <Btn
              onClick={() => {
                setJson(toJson(servers));
                setJsonErr('');
              }}
            >
              重置
            </Btn>
            <span className="ml-2 text-[12px] text-[var(--text-3)]">兼容通用的 mcpServers 配置格式，可直接粘贴其他客户端的配置。</span>
          </div>
        </div>
      )}

      {editing && <ServerForm initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSave={save} />}
    </PageShell>
  );
}
