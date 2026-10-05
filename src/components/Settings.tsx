import { useEffect, useState, type ReactNode } from 'react';
import {
  Search,
  Settings as Cog,
  Sun,
  Keyboard,
  GitBranch,
  Archive,
  ChevronDown,
  Check,
  Moon,
  Monitor,
  Info,
  Trash2,
  GitCommitHorizontal,
  ExternalLink,
  CircleCheck,
  Minimize2,
  Boxes,
  Terminal,
  Cpu,
} from 'lucide-react';
import type { Thread } from '../data';
import { Toggle, Popover, MenuItem, Kbd, AppIcon } from './ui';
import { Btn, Modal } from './kit';
import { closeBehaviorApi, openExternal, type CloseBehavior, adminErrorMessage } from '../lib/piAdmin';
import { isDesktopRuntime } from '../lib/piRpc';
import { cn } from '../utils/cn';

export type ThemePref = 'dark' | 'light' | 'system';

interface GitPreferences {
  name: string;
  email: string;
  branch: string;
  autoFetch: boolean;
  rebase: boolean;
  signCommits: boolean;
  safeDirectory: boolean;
}

function GithubMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.64-1.25-1.64-1.02-.7.08-.69.08-.69 1.13.08 1.73 1.15 1.73 1.15 1 .1.64 1.91 3.64 1.23.1-.72.39-1.22.71-1.5-2.5-.29-5.13-1.25-5.13-5.57 0-1.23.44-2.23 1.16-3.02-.12-.29-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.15a10.8 10.8 0 0 1 5.64 0c2.15-1.45 3.1-1.15 3.1-1.15.61 1.55.23 2.69.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.33-2.63 5.28-5.14 5.56.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.77.54A11.25 11.25 0 0 0 12 .75Z" />
    </svg>
  );
}

const settingsItems = [
  ['常规', Cog],
  ['外观', Sun],
  ['键盘快捷键', Keyboard],
  ['GitHub', GithubMark],
  ['已归档任务', Archive],
  ['Git', GitBranch],
  ['关于', Info],
] as const;

function Select({ value, options, onChange, icon }: { value: string; options: string[]; onChange: (v: string) => void; icon?: ReactNode }) {
  return (
    <Popover
      align="right"
      width={190}
      trigger={(_, toggle) => (
        <button
          onClick={toggle}
          className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--border-strong)] px-2.5 text-[13px] text-[var(--text)] hover:bg-[var(--bg-hover)]"
        >
          {icon}
          {value}
          <ChevronDown size={14} className="text-[var(--text-2)]" />
        </button>
      )}
    >
      {(close) =>
        options.map((o) => (
          <MenuItem key={o} right={o === value ? <Check size={13} /> : undefined} onClick={() => { onChange(o); close(); }}>
            {o}
          </MenuItem>
        ))
      }
    </Popover>
  );
}

function Row({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 border-b border-[var(--border)] px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium text-[var(--text)]">{title}</div>
        {desc && <div className="mt-0.5 text-[12px] leading-[18px] text-[var(--text-2)]">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-10">
      <h3 className="mb-3 text-[14px] font-medium text-[var(--text)]">{title}</h3>
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)]">{children}</div>
    </section>
  );
}

const VSCode = () => (
  <svg width="16" height="16" viewBox="0 0 24 24"><path fill="#2489ca" d="M17.6 2 8.4 10.4 3.8 6.9 2 7.8v8.4l1.8.9 4.6-3.5L17.6 22 22 19.9V4.1L17.6 2Zm0 5.2v9.6L11.2 12l6.4-4.8ZM4 9.6 6.6 12 4 14.4V9.6Z" /></svg>
);

export default function Settings({
  theme,
  onTheme,
  archived,
  hiddenWorkspaces,
  onRestoreWorkspace,
  onRestore,
  onDelete,
  onToast,
}: {
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
  archived: Thread[];
  hiddenWorkspaces: string[];
  onRestoreWorkspace: (path: string) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onToast: (s: string) => void;
}) {
  const [page, setPage] = useState('常规');
  const [q, setQ] = useState('');
  const [githubLinked, setGithubLinked] = useState(() => localStorage.getItem('github-linked') === 'true');
  const [deleteTarget, setDeleteTarget] = useState<Thread | null>(null);
  const [gitState, setGitState] = useState<GitPreferences>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('git-preferences') ?? 'null') as Partial<GitPreferences> | null;
      return {
        name: 'Wepi User',
        email: 'dev@example.com',
        branch: 'main',
        autoFetch: true,
        rebase: false,
        signCommits: false,
        safeDirectory: true,
        ...saved,
      };
    } catch {
      return { name: 'Wepi User', email: 'dev@example.com', branch: 'main', autoFetch: true, rebase: false, signCommits: false, safeDirectory: true };
    }
  });
  const [s, setS] = useState({
    defaultPerm: true,
    fullAccess: true,
    fullView: false,
    editor: 'VS Code',
    shell: 'PowerShell',
    lang: '自动检测',
    confirmClose: 'Close shortcut only',
    notify: true,
    sound: false,
    fontSize: '14px',
    codeFont: 'Cascadia Code',
    translucent: true,
    autoUpdate: true,
  });
  const set = <K extends keyof typeof s>(k: K, v: (typeof s)[K]) => setS({ ...s, [k]: v });
  const setGit = <K extends keyof GitPreferences>(key: K, value: GitPreferences[K]) =>
    setGitState((current) => ({ ...current, [key]: value }));

  useEffect(() => localStorage.setItem('github-linked', String(githubLinked)), [githubLinked]);
  useEffect(() => localStorage.setItem('git-preferences', JSON.stringify(gitState)), [gitState]);

  /* 应用版本：运行时从 Tauri 读取（来源 tauri.conf.json 的 version，
     单一真实来源）；浏览器预览退回编译期注入的 package.json 版本。 */
  const [appVersion, setAppVersion] = useState(__APP_VERSION__);
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    import('@tauri-apps/api/app')
      .then((mod) => mod.getVersion())
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  /* 关闭行为（Rust 托管：窗口关闭事件在 Rust 层拦截，必须读写 Rust 侧状态） */
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>('quit');
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    closeBehaviorApi.get().then((r) => setCloseBehavior(r.behavior)).catch(() => {});
  }, []);
  const changeCloseBehavior = (behavior: CloseBehavior) => {
    setCloseBehavior(behavior);
    if (!isDesktopRuntime()) return;
    closeBehaviorApi.set(behavior).catch((error) => {
      onToast(adminErrorMessage(error, '保存关闭行为失败'));
      closeBehaviorApi.get().then((r) => setCloseBehavior(r.behavior)).catch(() => {});
    });
  };

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex w-[248px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-side)]">
        <div className="px-4 pb-3 pt-4 text-[17px] font-semibold text-[var(--text)]">设置</div>
        <div className="mx-2 mb-2 flex h-9 items-center gap-2 rounded-full bg-[var(--bg-hover)] px-3">
          <Search size={15} className="text-[var(--text-2)]" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]"
          />
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto px-2 pb-4">
          <div className="space-y-0.5">
            {settingsItems
              .filter(([n]) => n.toLowerCase().includes(q.toLowerCase()))
              .map(([n, I]) => (
                <button
                  key={n}
                  onClick={() => setPage(n)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-[13.5px] text-[var(--text)] hover:bg-[var(--bg-hover)]',
                    page === n && 'bg-[var(--bg-active)]',
                  )}
                >
                  <I size={15} className="text-[var(--text-2)]" />
                  {n}
                </button>
              ))}
          </div>
        </div>
      </div>

      <div className="scroll-thin min-w-0 flex-1 overflow-y-auto bg-[var(--bg-main)]">
        <div className="fade-in mx-auto max-w-[760px] px-10 pb-16 pt-12" key={page}>
          <h2 className="mb-10 text-[28px] font-medium text-[var(--text)]">{page}</h2>

          {page === '常规' && (
            <>
              <Section title="权限">
                <Row title="默认权限" desc="默认情况下，Agent 可以读取和编辑其工作空间中的文件。需要时，它可以请求额外访问权限">
                  <Toggle on={s.defaultPerm} onChange={(v) => set('defaultPerm', v)} />
                </Row>
                <Row
                  title="完整访问权限"
                  desc={
                    <>
                      当 Agent 以完整访问权限运行时，它无需你的批准即可编辑你电脑上的任何文件，并运行可访问网络的命令。这会显著增加数据丢失、泄露或意外行为的风险。
                      <a className="cursor-pointer text-[var(--blue)] hover:underline">了解更多</a>关于风险升高的信息。
                    </>
                  }
                >
                  <Toggle on={s.fullAccess} onChange={(v) => set('fullAccess', v)} />
                </Row>
              </Section>
              <Section title="常规">
                <Row title="无项目任务文件夹" desc="在项目外启动的任务默认存储数据的位置。">
                  <div className="flex items-center gap-2">
                    <span className="max-w-[200px] truncate font-mono text-[12px] text-[var(--text-2)]">C:\Users\dev\Documents\WEPI</span>
                    <button className="rounded-lg bg-[var(--bg-hover)] px-2.5 py-1 text-[13px] text-[var(--text)] hover:bg-[var(--bg-active)]">更改</button>
                  </div>
                </Row>
                <Row title="默认文件打开位置" desc="默认打开文件和文件夹的位置">
                  <Select value={s.editor} icon={s.editor === 'VS Code' ? <VSCode /> : undefined} options={['VS Code', 'Cursor', 'Zed', 'IntelliJ IDEA', '文件资源管理器']} onChange={(v) => set('editor', v)} />
                </Row>
                <Row title="集成终端 Shell" desc="选择要在集成终端中打开的 Shell。">
                  <Select value={s.shell} options={['PowerShell', 'Command Prompt', 'Git Bash', 'WSL']} onChange={(v) => set('shell', v)} />
                </Row>
                <Row title="语言" desc="应用界面语言">
                  <Select value={s.lang} options={['自动检测', '简体中文', 'English', '日本語']} onChange={(v) => set('lang', v)} />
                </Row>
                <Row title="Confirm before closing a window" desc="Warn when a tab-close shortcut would close the window">
                  <Select value={s.confirmClose} options={['Always', 'Close shortcut only', 'Never']} onChange={(v) => set('confirmClose', v)} />
                </Row>
                <Row title="默认采用完整视图" desc="开始新任务时，在同一标签页栏中显示聊天和内容">
                  <Toggle on={s.fullView} onChange={(v) => set('fullView', v)} />
                </Row>
              </Section>
              <Section title="窗口">
                <Row
                  title="关闭行为"
                  desc="点击窗口关闭按钮时的行为；选择「托盘运行」后，可从系统托盘图标重新打开 WEPI 或退出"
                >
                  <Select
                    value={closeBehavior === 'tray' ? '托盘运行' : '退出 WEPI'}
                    options={['退出 WEPI', '托盘运行']}
                    onChange={(v) => changeCloseBehavior(v === '托盘运行' ? 'tray' : 'quit')}
                  />
                </Row>
                {closeBehavior === 'tray' && (
                  <Row title="托盘菜单" desc="右键托盘图标：「打开 WEPI / 退出 WEPI」；左键单击直接显示主窗口">
                    <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-3)]">
                      <Minimize2 size={13} /> 后台运行中
                    </span>
                  </Row>
                )}
              </Section>
              <Section title="通知">
                <Row title="任务完成通知" desc="当后台任务完成或需要批准时发送系统通知">
                  <Toggle on={s.notify} onChange={(v) => set('notify', v)} />
                </Row>
                <Row title="提示音" desc="任务完成时播放提示音">
                  <Toggle on={s.sound} onChange={(v) => set('sound', v)} />
                </Row>
                <Row title="自动更新" desc="在后台下载并安装新版本">
                  <Toggle on={s.autoUpdate} onChange={(v) => set('autoUpdate', v)} />
                </Row>
              </Section>
            </>
          )}

          {page === '外观' && (
            <>
              <Section title="主题">
                <div className="grid grid-cols-3 gap-3 p-4">
                  {([
                    ['light', '浅色', Sun],
                    ['dark', '深色', Moon],
                    ['system', '跟随系统', Monitor],
                  ] as const).map(([id, label, I]) => (
                    <button
                      key={id}
                      onClick={() => onTheme(id)}
                      className={cn(
                        'overflow-hidden rounded-xl border-2 text-left transition-colors',
                        theme === id ? 'border-[var(--blue)]' : 'border-[var(--border)] hover:border-[var(--border-strong)]',
                      )}
                    >
                      <div
                        className="flex h-20 gap-1.5 p-2"
                        style={{
                          background:
                            id === 'light' ? '#f3f3f3' : id === 'dark' ? '#1f1f1f' : 'linear-gradient(135deg,#f3f3f3 50%,#1f1f1f 50%)',
                        }}
                      >
                        <div className="w-1/3 rounded-md" style={{ background: id === 'dark' ? '#2a2a2a' : '#e5e5e5' }} />
                        <div className="flex flex-1 flex-col justify-end rounded-md p-1.5" style={{ background: id === 'dark' ? '#181818' : '#fff' }}>
                          <div className="h-3 rounded-full" style={{ background: id === 'dark' ? '#303030' : '#ececec' }} />
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 px-3 py-2 text-[13px] text-[var(--text)]">
                        <I size={13} /> {label}
                      </div>
                    </button>
                  ))}
                </div>
              </Section>
              <Section title="文字">
                <Row title="界面字号" desc="调整聊天与界面文字大小">
                  <Select value={s.fontSize} options={['13px', '14px', '15px', '16px']} onChange={(v) => set('fontSize', v)} />
                </Row>
                <Row title="代码字体" desc="用于代码块、终端与差异视图">
                  <Select value={s.codeFont} options={['Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Consolas']} onChange={(v) => set('codeFont', v)} />
                </Row>
                <Row title="半透明窗口" desc="在支持的系统上使用 Mica / 毛玻璃效果">
                  <Toggle on={s.translucent} onChange={(v) => set('translucent', v)} />
                </Row>
              </Section>
            </>
          )}

          {page === '键盘快捷键' && (
            <Section title="快捷键">
              {[
                ['新聊天', 'Ctrl+N'], ['切换边栏', 'Ctrl+B'], ['搜索聊天', 'Ctrl+K'], ['打开设置', 'Ctrl+,'],
                ['变更', 'Ctrl+Shift+G'], ['终端', 'Ctrl+`'], ['文件', 'Ctrl+P'],
                ['重命名聊天', 'Alt+Ctrl+R'], ['置顶聊天', 'Alt+Ctrl+P'], ['标记为未读', 'Ctrl+Shift+U'], ['归档聊天', 'Ctrl+Shift+A'],
              ].map(([a, k]) => (
                <Row key={a} title={a}><Kbd>{k}</Kbd></Row>
              ))}
            </Section>
          )}

          {page === '已归档任务' && (
            <>
              <Section title={`已归档聊天（${archived.length}）`}>
                {archived.length === 0 && <div className="px-4 py-8 text-center text-[13px] text-[var(--text-3)]">没有已归档的聊天</div>}
                {archived.map((t) => (
                  <Row key={t.id} title={t.title} desc={`${t.messages.length} 条消息`}>
                    <div className="flex items-center gap-2">
                      <Btn onClick={() => { onRestore(t.id); onToast('已恢复聊天'); }}>恢复</Btn>
                      <Btn variant="danger" onClick={() => setDeleteTarget(t)}><Trash2 size={13} /> 删除</Btn>
                    </div>
                  </Row>
                ))}
              </Section>

              {/* 移除项目只是隐藏该工作区（Pi 会话文件仍在磁盘上），这里提供恢复入口 */}
              {hiddenWorkspaces.length > 0 && (
                <Section title={`已移除的工作区（${hiddenWorkspaces.length}）`}>
                  <div className="px-4 pt-3 text-[12.5px] text-[var(--text-3)]">
                    这些工作区已从侧边栏移除，其 Pi 会话文件仍保留在磁盘上。
                  </div>
                  {hiddenWorkspaces.map((path) => (
                    <Row key={path} title={path.split(/[\\/]/).filter(Boolean).pop() ?? path} desc={path}>
                      <Btn onClick={() => onRestoreWorkspace(path)}>恢复</Btn>
                    </Row>
                  ))}
                </Section>
              )}
            </>
          )}

          {page === 'GitHub' && (
            <>
              <Section title="GitHub 账号">
                {githubLinked ? (
                  <div className="flex items-center gap-3 p-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--bg-hover)] text-[var(--text)]">
                      <GithubMark size={24} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--text)]">
                        Wepi Demo <CircleCheck size={14} className="text-[#3fb950]" />
                      </div>
                      <div className="mt-0.5 text-[12.5px] text-[var(--text-3)]">@wepi-demo · 已连接</div>
                    </div>
                    <Btn
                      onClick={() => {
                        setGithubLinked(false);
                        onToast('已断开 GitHub 演示账号');
                      }}
                    >
                      断开连接
                    </Btn>
                  </div>
                ) : (
                  <div className="flex flex-col items-center px-8 py-9 text-center">
                    <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--bg-hover)] text-[var(--text)]">
                      <GithubMark size={25} />
                    </div>
                    <div className="text-[14px] font-medium text-[var(--text)]">连接 GitHub 账号</div>
                    <p className="mt-1.5 max-w-[390px] text-[12.5px] leading-5 text-[var(--text-3)]">
                      连接后可在桌面端查看仓库、分支和 Pull Request，并让 Agent 使用 GitHub 工具。
                    </p>
                    <Btn
                      variant="primary"
                      className="mt-4"
                      onClick={() => {
                        setGithubLinked(true);
                        onToast('已连接 GitHub 演示账号');
                      }}
                    >
                      <GithubMark size={15} /> 连接 GitHub
                    </Btn>
                  </div>
                )}
              </Section>
              <Section title="仓库访问">
                <Row title="访问范围" desc="实际连接后，将在 GitHub 授权流程中选择可访问的仓库。">
                  <span className="text-[12.5px] text-[var(--text-3)]">{githubLinked ? '按授权范围访问' : '尚未连接'}</span>
                </Row>
                <Row title="Pull Request 与 Issues" desc="用于浏览、创建与评论仓库协作项目。">
                  <span className="text-[12.5px] text-[var(--text-3)]">连接后可配置</span>
                </Row>
              </Section>
              <p className="text-[12px] leading-5 text-[var(--text-3)]">
                这是纯前端演示：连接按钮只保存本地演示状态，不会发起 OAuth、读取凭据或访问 GitHub。
              </p>
            </>
          )}

          {page === 'Git' && (
            <>
              <Section title="提交身份">
                <Row title="用户名" desc="用于新提交的 author name">
                  <input value={gitState.name} onChange={(e) => setGit('name', e.target.value)} className="h-8 w-[220px] rounded-lg border border-[var(--border-strong)] bg-transparent px-2.5 text-[13px] text-[var(--text)] outline-none focus:border-[var(--blue)]" />
                </Row>
                <Row title="电子邮件" desc="用于新提交的 author email">
                  <input type="email" value={gitState.email} onChange={(e) => setGit('email', e.target.value)} className="h-8 w-[220px] rounded-lg border border-[var(--border-strong)] bg-transparent px-2.5 text-[13px] text-[var(--text)] outline-none focus:border-[var(--blue)]" />
                </Row>
                <Row title="默认分支名称" desc="新建 Git 仓库时使用的初始分支">
                  <Select value={gitState.branch} options={['main', 'master', 'develop']} onChange={(v) => setGit('branch', v)} />
                </Row>
              </Section>
              <Section title="工作流">
                <Row title="自动获取远端更新" desc="打开项目后定期执行 git fetch，不会自动合并更改。">
                  <Toggle on={gitState.autoFetch} onChange={(v) => setGit('autoFetch', v)} />
                </Row>
                <Row title="拉取时使用 Rebase" desc="执行 pull 时优先变基，保持提交历史线性。">
                  <Toggle on={gitState.rebase} onChange={(v) => setGit('rebase', v)} />
                </Row>
                <Row title="签名提交" desc="使用本机 Git 配置的签名密钥为提交签名。">
                  <Toggle on={gitState.signCommits} onChange={(v) => setGit('signCommits', v)} />
                </Row>
                <Row title="信任已选择的工作区" desc="将项目目录加入 Git safe.directory，避免重复的所有权警告。">
                  <Toggle on={gitState.safeDirectory} onChange={(v) => setGit('safeDirectory', v)} />
                </Row>
              </Section>
              <div className="flex items-start gap-2 text-[12px] leading-5 text-[var(--text-3)]">
                <GitCommitHorizontal size={14} className="mt-0.5 shrink-0" />
                Git 偏好只保存在本机示例界面中；接入桌面后，由 Git integration 写入应用配置，不会直接修改全局 Git 配置。
              </div>
            </>
          )}

          {page === '关于' && (
            <>
              <div className="mb-10 flex flex-col items-center pt-4 text-center">
                <AppIcon size={84} className="drop-shadow-[0_6px_24px_rgba(59,130,246,0.25)]" />
                <div className="mt-4 text-[24px] font-semibold tracking-[0.18em] text-[var(--text)]">WEPI</div>
                <div className="mt-1.5 text-[13px] text-[var(--text-2)]">开源 AI Agent 桌面工作台</div>
                <div className="mt-3 flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1 text-[12px] text-[var(--text-2)]">
                  <span className="size-1.5 rounded-full bg-[#3fb950]" />
                  v{appVersion}
                </div>
              </div>

              <Section title="技术栈">
                <Row title="应用框架" desc="桌面容器与前端界面">
                  <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-2)]">
                    <Boxes size={14} /> Tauri 2 · React 19
                  </span>
                </Row>
                <Row title="Agent 运行时" desc="通过 stdio JSON-RPC 驱动 Pi Coding Agent">
                  <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-2)]">
                    <Cpu size={14} /> Pi RPC
                  </span>
                </Row>
                <Row title="内置工具" desc="文件浏览、变更审查、终端与网页标签页">
                  <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-2)]">
                    <Terminal size={14} /> 工作区面板
                  </span>
                </Row>
              </Section>

              <Section title="应用信息">
                <Row title="版本" desc="语义化版本，随发布递增">
                  <span className="font-mono text-[12.5px] text-[var(--text-2)]">{appVersion}</span>
                </Row>
                <Row title="构建方式" desc="Rust 后端 + 单文件前端产物">
                  <span className="font-mono text-[12.5px] text-[var(--text-2)]">Vite · singlefile</span>
                </Row>
                <Row title="开源许可" desc="本项目基于 MIT 许可开源">
                  <span className="text-[12.5px] text-[var(--text-2)]">MIT</span>
                </Row>
              </Section>

              <Section title="链接">
                <Row title="项目主页" desc="GitHub 仓库与源码">
                  <Btn onClick={() => openExternal('https://github.com/WEP-56/wepi', onToast)}><ExternalLink size={13} /> 项目主页</Btn>
                </Row>
                <Row title="反馈问题" desc="提交 Bug 报告与功能建议">
                  <Btn onClick={() => openExternal('https://github.com/WEP-56/wepi/issues', onToast)}><ExternalLink size={13} /> 报告问题</Btn>
                </Row>
                <Row title="Pi 文档" desc="Pi Coding Agent 的官方文档与配置说明">
                  <Btn onClick={() => openExternal('https://pi.dev', onToast)}><ExternalLink size={13} /> pi.dev</Btn>
                </Row>
              </Section>
            </>
          )}
        </div>
      </div>
      {deleteTarget && (
        <Modal title="永久删除已归档聊天？" onClose={() => setDeleteTarget(null)} width={440}>
          <p className="text-[13.5px] leading-6 text-[var(--text-2)]">
            「{deleteTarget.title}」将被永久删除，无法恢复。此操作不会影响项目文件。
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setDeleteTarget(null)}>取消</Btn>
            <Btn
              variant="danger"
              onClick={() => {
                onDelete(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              永久删除
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}
