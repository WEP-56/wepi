import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Package,
  RefreshCw,
  Terminal,
  Pencil,
  Plus,
  Trash2,
  Store as StoreIcon,
  Search,
  Download,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Stethoscope,
} from 'lucide-react';
import { Btn, Modal, Field, inputCls, Segmented, Card } from '../kit';
import { Toggle } from '../ui';
import { cn } from '../../utils/cn';
import { isDesktopRuntime } from '../../lib/piRpc';
import {
  extensionsApi,
  runtimeApi,
  shellApi,
  adminErrorMessage,
  openExternal,
  type PiInstallation,
  type PiUpdateCheck,
  type PiUpdateResult,
  type ExtensionSummary,
  type CatalogItem,
  type DiagnosticsResult,
} from '../../lib/piAdmin';

/* ---------- Pi 版本与更新 ---------- */

function PiVersionSection({ onToast }: { onToast: (s: string) => void }) {
  const [installations, setInstallations] = useState<PiInstallation[]>([]);
  const [updateCheck, setUpdateCheck] = useState<PiUpdateCheck | null>(null);
  const [updateResult, setUpdateResult] = useState<PiUpdateResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draftPath, setDraftPath] = useState('');
  const [applying, setApplying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await runtimeApi.installations();
      setInstallations(result.installations);
    } catch {
      setInstallations([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const checkUpdate = async () => {
    setChecking(true);
    try {
      setUpdateCheck(await runtimeApi.checkUpdate());
    } catch (caught) {
      onToast(adminErrorMessage(caught, '检查更新失败'));
    } finally {
      setChecking(false);
    }
  };

  const updatePi = async () => {
    setUpdating(true);
    setUpdateResult(null);
    try {
      setUpdateResult(await runtimeApi.updatePi());
      await load();
    } catch (caught) {
      onToast(adminErrorMessage(caught, '更新失败'));
    } finally {
      setUpdating(false);
    }
  };

  const addPath = async () => {
    const trimmed = draftPath.trim();
    if (!trimmed) return;
    setApplying(trimmed);
    try {
      await runtimeApi.addPath(trimmed);
      onToast(`已添加 Pi 命令来源（v${'…'}）`);
      setDraftPath('');
      setAdding(false);
      await load();
    } catch (caught) {
      onToast(`添加失败：${adminErrorMessage(caught, '路径无效')}`);
    } finally {
      setApplying(null);
    }
  };

  const removePath = async (path: string) => {
    try {
      await runtimeApi.removePath(path);
      await load();
    } catch (caught) {
      onToast(adminErrorMessage(caught, '移除失败'));
    }
  };

  const detected = installations.filter((item) => item.source !== '我添加的路径');
  const userAdded = installations.filter((item) => item.source === '我添加的路径');
  const hasNewest = installations.some((item) => item.isNewest);

  const row = (item: PiInstallation) => {
    const editable = item.source === '我添加的路径';
    const missing = item.missing;
    return (
      <div key={item.path} className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-[var(--text-2)]">{item.source}</span>
            {item.isNewest && (
              <span className="inline-flex items-center gap-1 rounded-md bg-[#3fb950]/15 px-1.5 py-0.5 text-[11px] text-[#3fb950]">
                <CheckCircle2 size={11} /> 较新
              </span>
            )}
            {!item.isNewest && hasNewest && item.version && (
              <span className="text-[11px] text-[var(--text-3)]">有更新版本可用</span>
            )}
            {missing && <span className="text-[11px] text-[#f85149]">文件不存在</span>}
          </div>
          <code className="mt-0.5 block truncate font-mono text-[12px] text-[var(--text)]" title={item.path}>{item.path}</code>
          <div className="mt-0.5 text-[11px] text-[var(--text-3)]">{item.version ? `v${item.version}` : '版本未知'}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1 self-center">
          {editable && (
            <>
              <button
                onClick={() => { setAdding(true); setDraftPath(item.path); }}
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                title="编辑路径"
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={() => void removePath(item.path)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[#f85149]"
                title="移除"
              >
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Terminal size={16} className="text-[var(--text)]" />
        <h3 className="text-[14px] font-medium text-[var(--text)]">Pi 版本与命令来源</h3>
        <div className="flex-1" />
        <Btn onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> 重新扫描
        </Btn>
        <Btn onClick={() => setAdding((current) => !current)}>
          <Plus size={13} /> 添加路径
        </Btn>
      </div>

      {adding && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] px-3.5 py-3">
          <Field label="Pi 可执行文件路径" hint="例如 C:\\Users\\you\\.pi\\agent\\bin\\pi.cmd；添加前会运行 --version 校验">
            <input autoFocus value={draftPath} onChange={(e) => setDraftPath(e.target.value)} className={cn(inputCls, 'font-mono text-[12.5px]')} />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => { setAdding(false); setDraftPath(''); }}>取消</Btn>
            <Btn variant="primary" disabled={!draftPath.trim() || applying === draftPath.trim()} onClick={() => void addPath()}>
              {applying === draftPath.trim() ? '校验中…' : '校验并添加'}
            </Btn>
          </div>
        </div>
      )}

      {detected.length > 0 && <div className="text-[11.5px] text-[var(--text-3)]">自动检测到的安装</div>}
      <div className="space-y-1.5">{detected.map(row)}</div>
      {userAdded.length > 0 && <div className="pt-1 text-[11.5px] text-[var(--text-3)]">我添加的路径</div>}
      <div className="space-y-1.5">{userAdded.map(row)}</div>
      {installations.length === 0 && !loading && (
        <Card className="py-8 text-center text-[13px] text-[var(--text-3)]">
          {!isDesktopRuntime() ? '需要桌面版运行' : '未检测到 Pi 安装，可手动添加路径'}
        </Card>
      )}
      {loading && <Card className="py-8 text-center text-[13px] text-[var(--text-3)]">扫描中…</Card>}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
        <Btn onClick={() => void checkUpdate()} disabled={checking || updating}>
          <RefreshCw size={13} className={checking ? 'animate-spin' : ''} /> 检查 Pi 更新
        </Btn>
        <Btn
          variant="primary"
          onClick={() => void updatePi()}
          disabled={updating || (updateCheck ? !updateCheck.hasUpdate : false)}
        >
          <Download size={13} /> {updating ? '更新中…' : '更新 Pi'}
        </Btn>
        {updateCheck?.error && <span className="text-[11.5px] text-[#d29922]">{updateCheck.error}</span>}
        {updateCheck?.hasUpdate && (
          <span className="text-[11.5px] text-[var(--text-2)]">
            {updateCheck.currentVersion ?? '未知'} → {updateCheck.latestVersion}
          </span>
        )}
        {updateCheck && !updateCheck.hasUpdate && !updateCheck.error && (
          <span className="text-[11.5px] text-[#3fb950]">已是最新（{updateCheck.latestVersion}）</span>
        )}
      </div>
      {updateResult && (
        <pre className="scroll-thin max-h-[200px] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 font-mono text-[11.5px] leading-5 text-[var(--text-2)]">
          {`${updateResult.command}\n${updateResult.output}`}
        </pre>
      )}
    </section>
  );
}

/* ---------- 环境诊断 ---------- */

function DiagnosticsSection({ onToast }: { onToast: (s: string) => void }) {
  const [result, setResult] = useState<DiagnosticsResult | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    try {
      setResult(await runtimeApi.diagnostics());
    } catch (caught) {
      onToast(adminErrorMessage(caught, '诊断失败'));
    } finally {
      setRunning(false);
    }
  }, [onToast]);

  useEffect(() => { void run(); }, [run]);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Stethoscope size={16} className="text-[var(--text)]" />
        <h3 className="text-[14px] font-medium text-[var(--text)]">环境诊断</h3>
        <div className="flex-1" />
        <Btn onClick={() => void run()} disabled={running}>
          <RefreshCw size={13} className={running ? 'animate-spin' : ''} /> 重新诊断
        </Btn>
      </div>
      {result ? (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {result.checks.map((check) => (
              <div key={check.name} className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-3.5 py-2.5">
                {check.ok ? <CheckCircle2 size={16} className="shrink-0 text-[#3fb950]" /> : <AlertTriangle size={16} className="shrink-0 text-[#d29922]" />}
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-[var(--text)]">{check.name}</div>
                  <div className="truncate text-[11.5px] text-[var(--text-3)]">{check.purpose}</div>
                </div>
                <span className={cn('shrink-0 text-[11.5px]', check.ok ? 'text-[#3fb950]' : 'text-[#d29922]')}>{check.ok ? '可用' : '未找到'}</span>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-3.5 py-3 text-[12px] text-[var(--text-2)]">
            <div className="mb-1 font-medium text-[var(--text)]">Pi 配置目录</div>
            <code className="block break-all font-mono text-[11.5px] text-[var(--text-3)]">{result.agentDir}</code>
            <div className="mt-2 flex flex-wrap gap-2 text-[11.5px]">
              <span className={result.agentDirExists ? 'text-[#3fb950]' : 'text-[var(--text-3)]'}>● 目录{result.agentDirExists ? '存在' : '不存在'}</span>
              <span className={result.modelsConfigExists ? 'text-[#3fb950]' : 'text-[#d29922]'}>● models.json{result.modelsConfigExists ? '' : ' 缺失'}</span>
              <span className={result.mcpConfigExists ? 'text-[#3fb950]' : 'text-[var(--text-3)]'}>● mcp.json{result.mcpConfigExists ? '' : ' 未创建'}</span>
              <span className={result.skillsDirExists ? 'text-[#3fb950]' : 'text-[var(--text-3)]'}>● skills/{result.skillsDirExists ? '' : ' 不存在'}</span>
            </div>
          </div>
        </>
      ) : (
        <Card className="py-8 text-center text-[13px] text-[var(--text-3)]">{running ? '诊断中…' : '需要桌面版运行'}</Card>
      )}
    </section>
  );
}

/* ---------- 扩展商店 ---------- */

function ExtensionStorePanel({
  installedSources,
  onInstalled,
  onToast,
}: {
  installedSources: Set<string>;
  onInstalled: () => void;
  onToast: (s: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [kind, setKind] = useState('');
  const [sort, setSort] = useState<'downloads' | 'recent'>('downloads');
  const [page, setPage] = useState(1);
  const [catalog, setCatalog] = useState<{ items: CatalogItem[]; page: number; total: number; lastPage: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async (targetPage: number, refresh = false) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError('');
    try {
      const result = await extensionsApi.catalog({ page: targetPage, query: submitted, kind, sort, refresh });
      if (seq !== requestSeq.current) return;
      setCatalog(result);
      setPage(result.page);
    } catch (caught) {
      if (seq !== requestSeq.current) return;
      setError(adminErrorMessage(caught, '扩展商店加载失败（pi.dev 可能不可达）'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [submitted, kind, sort]);

  // 过滤条件变化回到第一页重新加载；submitted 由搜索触发。
  useEffect(() => { void load(1); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [submitted, kind, sort]);

  const submitSearch = (refresh = false) => {
    if (query.trim() === submitted) void load(1, refresh);
    else setSubmitted(query.trim());
  };

  const install = async (item: CatalogItem) => {
    if (installing) return;
    setInstalling(item.installSource);
    try {
      await extensionsApi.install(item.installSource);
      onToast(`已安装 ${item.name}`);
      onInstalled();
    } catch (caught) {
      onToast(`安装失败：${adminErrorMessage(caught, 'pi install 出错')}`);
    } finally {
      setInstalling(null);
    }
  };

  const formatDownloads = (count?: number) => {
    if (count === undefined) return '';
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
    return String(count);
  };

  const formatPublished = (timestamp?: number) => {
    if (!timestamp) return '';
    const days = Math.floor((Date.now() - timestamp) / 86_400_000);
    if (days < 1) return '今天';
    if (days < 30) return `${days} 天前`;
    if (days < 365) return `${Math.floor(days / 30)} 个月前`;
    return `${Math.floor(days / 365)} 年前`;
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-full bg-[var(--bg-hover)] px-3.5">
          <Search size={14} className="text-[var(--text-2)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitSearch(); }}
            placeholder="搜索 pi.dev 扩展包"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]"
          />
        </div>
        <Segmented
          value={kind}
          onChange={(value) => setKind(value)}
          options={[
            { value: '', label: '全部' },
            { value: 'extension', label: '扩展' },
            { value: 'skill', label: '技能' },
            { value: 'prompt', label: '提示词' },
            { value: 'theme', label: '主题' },
          ]}
        />
        <Segmented
          value={sort}
          onChange={(value) => setSort(value)}
          options={[
            { value: 'downloads', label: '按下载量' },
            { value: 'recent', label: '按最新' },
          ]}
        />
      </div>
      {error && <div className="mb-3 rounded-xl border border-[#f85149]/40 px-3 py-2 text-[12.5px] text-[#f85149]">{error}</div>}
      {loading && !catalog ? (
        <Card className="py-12 text-center text-[13px] text-[var(--text-3)]">加载商店中…</Card>
      ) : catalog && catalog.items.length > 0 ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {catalog.items.map((item) => {
              const installed = installedSources.has(item.installSource);
              return (
                <Card key={item.installSource} className="flex flex-col p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-hover)] text-[var(--text)]">
                      <Package size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[13.5px] font-medium text-[var(--text)]">{item.name}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-3)]">
                        {item.types.slice(0, 3).map((type) => (
                          <span key={type} className="rounded-md bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--text-2)]">{type}</span>
                        ))}
                        {item.author && <span className="truncate">{item.author}</span>}
                      </div>
                    </div>
                  </div>
                  <p className="mt-2.5 line-clamp-2 min-h-[36px] text-[12.5px] leading-5 text-[var(--text-2)]">
                    {item.description || <span className="text-[var(--text-3)]">（无描述）</span>}
                  </p>
                  <div className="mt-3 flex items-center gap-1">
                    <button
                      onClick={() => void install(item)}
                      disabled={installing !== null || installed}
                      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40"
                    >
                      <Download size={12} /> {installed ? '已安装' : installing === item.installSource ? '安装中…' : '安装'}
                    </button>
                    <button
                      onClick={() => openExternal(item.pageUrl, onToast)}
                      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                    >
                      <ExternalLink size={12} /> 详情
                    </button>
                    <div className="flex-1" />
                    <span className="shrink-0 text-[10.5px] text-[var(--text-3)]">
                      {formatDownloads(item.downloadsPerMonth)}
                      {item.publishedAt ? ` · ${formatPublished(item.publishedAt)}` : ''}
                    </span>
                  </div>
                </Card>
              );
            })}
          </div>
          <div className="mt-5 flex items-center justify-center gap-3">
            <Btn disabled={page <= 1 || loading} onClick={() => void load(page - 1)}>
              <ArrowLeft size={13} /> 上一页
            </Btn>
            <span className="text-[12.5px] text-[var(--text-3)]">
              第 {catalog.page} / {catalog.lastPage} 页 · 共 {catalog.total} 个包
            </span>
            <Btn disabled={page >= catalog.lastPage || loading} onClick={() => void load(page + 1)}>
              下一页 <ArrowRight size={13} />
            </Btn>
          </div>
        </>
      ) : (
        <Card className="py-12 text-center text-[13px] text-[var(--text-3)]">
          {submitted ? `没有匹配「${submitted}」的包` : '商店数据为空（pi.dev 可能不可达）'}
        </Card>
      )}
    </div>
  );
}

/* ---------- 扩展管理 ---------- */

function ExtensionsSection({ onToast }: { onToast: (s: string) => void }) {
  const [tab, setTab] = useState<'installed' | 'store'>('installed');
  const [extensions, setExtensions] = useState<ExtensionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busySource, setBusySource] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ExtensionSummary | null>(null);
  const [updateOutput, setUpdateOutput] = useState<{ command: string; output: string } | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);
  const loadGeneration = useRef(0);

  const load = useCallback(async (forceRefresh = false) => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const result = await extensionsApi.list(forceRefresh);
      if (generation !== loadGeneration.current) return;
      setExtensions(result.extensions);
    } catch {
      if (generation === loadGeneration.current) setExtensions([]);
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); return () => { loadGeneration.current += 1; }; }, [load]);

  const setEnabled = async (extension: ExtensionSummary, enabled: boolean) => {
    if (busySource) return;
    setBusySource(extension.source);
    try {
      await extensionsApi.setEnabled(extension.source, enabled);
      setExtensions((current) => current.map((item) => (item.source === extension.source ? { ...item, enabled } : item)));
      onToast(enabled ? `已启用 ${extension.source}` : `已禁用 ${extension.source}（下次会话生效）`);
    } catch (caught) {
      onToast(adminErrorMessage(caught, '操作失败'));
    } finally {
      setBusySource(null);
    }
  };

  const updateOne = async (extension: ExtensionSummary) => {
    if (busySource) return;
    setBusySource(extension.source);
    setUpdateOutput(null);
    try {
      const result = await extensionsApi.updateOne(extension.source);
      setUpdateOutput({ command: result.command, output: result.output });
      onToast(`已更新 ${extension.source}`);
      void load(true);
    } catch (caught) {
      onToast(adminErrorMessage(caught, '更新失败'));
    } finally {
      setBusySource(null);
    }
  };

  const updateAll = async () => {
    setUpdatingAll(true);
    setUpdateOutput(null);
    try {
      const result = await extensionsApi.updateAll();
      setUpdateOutput({ command: result.command, output: result.output });
      void load(true);
    } catch (caught) {
      onToast(adminErrorMessage(caught, '批量更新失败'));
    } finally {
      setUpdatingAll(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    setBusySource(target.source);
    try {
      await extensionsApi.uninstall(target.source);
      onToast(`已卸载 ${target.source}`);
      void load(true);
    } catch (caught) {
      onToast(adminErrorMessage(caught, '卸载失败'));
    } finally {
      setBusySource(null);
    }
  };

  const installedSources = useMemo(() => new Set(extensions.map((item) => item.source)), [extensions]);
  const npmCount = extensions.filter((item) => item.source.startsWith('npm:')).length;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Package size={16} className="text-[var(--text)]" />
        <h3 className="text-[14px] font-medium text-[var(--text)]">扩展管理</h3>
        <div className="flex-1" />
        {tab === 'installed' ? (
          <>
            <Btn onClick={() => void load(true)} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> 刷新（含版本）
            </Btn>
            <Btn onClick={() => void updateAll()} disabled={updatingAll || busySource !== null || npmCount === 0}>
              <Download size={13} /> {updatingAll ? '更新中…' : '全部更新'}
            </Btn>
          </>
        ) : null}
      </div>

      <Segmented
        value={tab}
        onChange={(value) => setTab(value)}
        options={[
          { value: 'installed', label: `已安装（${extensions.length}）` },
          { value: 'store', label: '扩展商店' },
        ]}
      />

      {updateOutput && (
        <pre className="scroll-thin max-h-[160px] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 font-mono text-[11.5px] leading-5 text-[var(--text-2)]">
          {`${updateOutput.command}\n${updateOutput.output}`}
        </pre>
      )}

      {tab === 'store' ? (
        <ExtensionStorePanel installedSources={installedSources} onInstalled={() => void load(true)} onToast={onToast} />
      ) : loading ? (
        <Card className="py-12 text-center text-[13px] text-[var(--text-3)]">加载扩展列表中…</Card>
      ) : extensions.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-12 text-[var(--text-3)]">
          <Package size={28} />
          <div className="text-[13.5px]">{!isDesktopRuntime() ? '需要桌面版运行' : '还没有安装扩展，可从扩展商店安装'}</div>
          <Btn onClick={() => setTab('store')}><StoreIcon size={13} /> 去商店看看</Btn>
        </Card>
      ) : (
        <div className="space-y-1.5">
          {extensions.map((extension) => {
            const shortName = extension.source
              .replace(/^(?:npm|file|github|git|https?):/i, '')
              .replace(/\.ts$/, '')
              .replace(/@[^/]+\//, '');
            return (
              <div key={extension.id} className={cn('flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3', !extension.enabled && 'opacity-70')}>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-hover)] text-[var(--text-2)]">
                  <Package size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-[13px] font-medium text-[var(--text)]" title={extension.source}>{shortName}</span>
                    <span className="rounded-md bg-[var(--bg-hover)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-2)]">{extension.scope === 'project' ? '项目' : extension.scope === 'user' ? '用户' : extension.scope}</span>
                    {extension.builtIn && <span className="rounded-md bg-[#3fb950]/15 px-1.5 py-0.5 text-[10.5px] text-[#3fb950]">内置</span>}
                    {extension.filtered && <span className="rounded-md bg-[var(--bg-hover)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-3)]">过滤安装</span>}
                    {extension.hasUpdate && (
                      <span className="text-[11px] text-[#d29922]">
                        {extension.currentVersion} → {extension.latestVersion}
                      </span>
                    )}
                    {!extension.hasUpdate && extension.currentVersion && (
                      <span className="text-[11px] text-[var(--text-3)]">v{extension.currentVersion}</span>
                    )}
                  </div>
                  {extension.path && (
                    <code className="mt-0.5 block truncate font-mono text-[11px] text-[var(--text-3)]" title={extension.path}>{extension.path}</code>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {extension.hasUpdate && (
                    <button
                      onClick={() => void updateOne(extension)}
                      disabled={busySource !== null}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40"
                      title="更新此扩展"
                    >
                      <RefreshCw size={13} className={busySource === extension.source ? 'animate-spin' : ''} />
                    </button>
                  )}
                  {extension.path && (
                    <button
                      onClick={() => {
                        shellApi.showInExplorer(extension.path!)
                          .catch((error) => onToast(adminErrorMessage(error, '无法打开目录')));
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                      title="打开所在目录"
                    >
                      <ExternalLink size={13} />
                    </button>
                  )}
                  <button
                    onClick={() => setPendingDelete(extension)}
                    disabled={busySource !== null}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[#f85149] disabled:opacity-40"
                    title="卸载"
                  >
                    <Trash2 size={13} />
                  </button>
                  <Toggle on={extension.enabled} disabled={busySource !== null} onChange={(value) => void setEnabled(extension, value)} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pendingDelete && (
        <Modal title={`卸载扩展「${pendingDelete.source}」？`} onClose={() => setPendingDelete(null)} width={500}>
          <p className="text-[13px] leading-6 text-[var(--text-2)]">
            将执行 <code className="rounded bg-[var(--bg-hover)] px-1 py-0.5 font-mono text-[12px]">pi remove {pendingDelete.source}</code>
            {pendingDelete.path && (
              <>
                <br />或删除本地文件：<br />
                <span className="break-all font-mono text-[12px] text-[var(--text-3)]">{pendingDelete.path}</span>
              </>
            )}
            。此操作无法撤销。
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setPendingDelete(null)}>取消</Btn>
            <Btn variant="danger" onClick={() => void confirmDelete()}>卸载</Btn>
          </div>
        </Modal>
      )}
    </section>
  );
}

/* ---------- 主页面 ---------- */

export default function ManagementPage({ onToast }: { onToast: (s: string) => void }) {
  const [tab, setTab] = useState<'pi' | 'extensions'>('pi');
  return (
    <div className="scroll-thin min-w-0 flex-1 overflow-y-auto bg-[var(--bg-main)]">
      <div className="fade-in mx-auto max-w-[820px] px-10 pb-16 pt-12">
        <div className="mb-6">
          <h2 className="text-[28px] font-medium text-[var(--text)]">Pi 高级管理</h2>
          <p className="mt-2 max-w-[580px] text-[13.5px] leading-6 text-[var(--text-2)]">
            Pi 版本更新、命令来源检测、环境诊断与扩展（插件）管理。
          </p>
        </div>
        <div className="mb-6">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'pi', label: 'Pi 管理' },
              { value: 'extensions', label: '扩展管理' },
            ]}
          />
        </div>
        {tab === 'pi' ? (
          <div className="space-y-10">
            <PiVersionSection onToast={onToast} />
            <DiagnosticsSection onToast={onToast} />
          </div>
        ) : (
          <ExtensionsSection onToast={onToast} />
        )}
      </div>
    </div>
  );
}
