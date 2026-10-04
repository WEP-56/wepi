export type Role = 'user' | 'assistant';

export interface FileEdit {
  file: string;
  add: number;
  del: number;
}

export interface DiffLine {
  t: '+' | '-' | ' ';
  s: string;
}

export interface TermLine {
  t?: 'cmd' | 'add' | 'del' | 'err';
  s: string;
}

export type StepDetail =
  | { kind: 'command'; command: string; lines: TermLine[] }
  | { kind: 'read'; file: string; lines: TermLine[] }
  | { kind: 'edit'; file: string; add: number; del: number; diff: DiffLine[] }
  | { kind: 'note'; text: string };

/** 时间线中的一段：叙述文字，或一个可展开的动作 */
export interface Step {
  id?: string;
  kind: 'text' | 'action';
  text?: string;
  label?: string;
  icon?: 'file' | 'command' | 'edit' | 'search' | 'agent' | 'retry';
  detail?: StepDetail;
  /** 仍在进行中（如自动重试等待中）：渲染为旋转指示 */
  pending?: boolean;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  duration?: number;
  edits?: FileEdit[];
  steps?: Step[];
  streaming?: boolean;
  thinking?: boolean;
  thinkingContent?: string;
}

export interface Thread {
  id: string;
  title: string;
  /** 会话绑定的项目，null 表示「不在项目中工作」 */
  projectId: string | null;
  messages: Message[];
  pinned?: boolean;
  unread?: boolean;
  archived?: boolean;
  /** Pi 会话文件绝对路径（~/.pi/agent/sessions/.../*.jsonl）；存在即代表可恢复 */
  piSessionPath?: string | null;
  /** Pi 侧工作目录（启动 RPC 进程时作为 cwd） */
  piCwd?: string | null;
  /** 该会话的 RPC 进程键（内部使用） */
  rpcKey?: string | null;
  /** 上次同步到的文件大小，用于检测 Pi 侧追加 */
  piFileSize?: number;
  /** 最近一次 Agent 回合的文件快照标识 */
  lastTurnId?: string | null;
}

export interface Project {
  id: string;
  name: string;
  /** 本地目录（桌面版为绝对路径） */
  path: string;
  branch: string;
  pinned?: boolean;
}

export interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  url: string;
  env: string;
  enabled: boolean;
  status: 'connected' | 'connecting' | 'error' | 'disabled';
  tools: string[];
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: '内置' | '用户' | '项目';
  enabled: boolean;
  content: string;
}

export interface Provider {
  id: string;
  name: string;
  kind: 'openai' | 'anthropic' | 'google' | 'deepseek' | 'ollama' | 'custom';
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models: string[];
  api?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  modelDetails?: Record<string, ModelDetails>;
  custom?: boolean;
}

export interface ModelDetails {
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  [key: string]: unknown;
}

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export const initialProjects: Project[] = [
  { id: 'demo-web', name: 'demo-web', path: 'C:\\Users\\you\\code\\demo-web', branch: 'main' },
  { id: 'demo-api', name: 'demo-api', path: 'C:\\Users\\you\\code\\demo-api', branch: 'develop' },
];

const validateSteps: Step[] = [
  {
    kind: 'text',
    text: '我先梳理登录表单的现状、现有的表单工具函数和测试结构，再把校验放到合适的一层，并让错误提示落在输入框下方。',
  },
  {
    kind: 'action',
    icon: 'file',
    label: '已读取文件 src/pages/Login.tsx',
    detail: {
      kind: 'read',
      file: 'src/pages/Login.tsx',
      lines: [
        { s: "import { useState } from 'react';" },
        { s: '' },
        { s: 'export function LoginForm({ onSubmit }: Props) {' },
        { s: "  const [email, setEmail] = useState('');" },
        { s: "  const [password, setPassword] = useState('');" },
        { s: '' },
        { s: '  return (' },
        { s: '    <form onSubmit={() => onSubmit(email, password)}>' },
      ],
    },
  },
  {
    kind: 'action',
    icon: 'search',
    label: '已搜索 validate|validators',
    detail: {
      kind: 'command',
      command: 'rg -n "validate|validators" src tests',
      lines: [{ t: 'err', s: '（无匹配）' }],
    },
  },
  {
    kind: 'text',
    text: '项目里目前没有统一的校验层，表单直接把输入值交给 `onSubmit`。我会在 `src/utils/` 下新增纯函数校验，表单在提交前调用并把错误渲染到对应输入框下方，这样后续注册页也能复用。',
  },
  {
    kind: 'action',
    icon: 'edit',
    label: '已编辑 validate.ts',
    detail: {
      kind: 'edit',
      file: 'src/utils/validate.ts',
      add: 18,
      del: 0,
      diff: [
        { t: '+', s: 'export function validateEmail(value: string) {' },
        { t: '+', s: '  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value.trim());' },
        { t: '+', s: '}' },
        { t: '+', s: '' },
        { t: '+', s: 'export function validatePassword(value: string) {' },
        { t: '+', s: '  return value.length >= 8 && value.length <= 64;' },
        { t: '+', s: '}' },
      ],
    },
  },
  {
    kind: 'action',
    icon: 'edit',
    label: '已编辑 Login.tsx',
    detail: {
      kind: 'edit',
      file: 'src/pages/Login.tsx',
      add: 24,
      del: 3,
      diff: [
        { t: ' ', s: '  const handleSubmit = () => {' },
        { t: '-', s: '    onSubmit(email, password);' },
        { t: '+', s: "    if (!validateEmail(email)) return setError('请输入有效的邮箱地址');" },
        { t: '+', s: "    if (!validatePassword(password)) return setError('密码长度需为 8–64 位');" },
        { t: '+', s: "    setError('');" },
        { t: '+', s: '    onSubmit(email, password);' },
        { t: ' ', s: '  };' },
      ],
    },
  },
  {
    kind: 'action',
    icon: 'command',
    label: '已运行 npm test',
    detail: {
      kind: 'command',
      command: 'npm test',
      lines: [
        { t: 'cmd', s: '$ npm test' },
        { t: 'add', s: ' PASS  tests/validate.test.ts' },
        { t: 'add', s: ' PASS  tests/login.test.ts' },
        { s: '' },
        { s: 'Tests:       12 passed, 12 total' },
        { s: 'Time:        1.84 s' },
      ],
    },
  },
];

const testSteps: Step[] = [
  {
    kind: 'text',
    text: '我先确认这两个校验函数的边界条件，再补齐测试用例，重点覆盖空值、非法格式和长度边界。',
  },
  {
    kind: 'action',
    icon: 'edit',
    label: '已编辑 validate.test.ts',
    detail: {
      kind: 'edit',
      file: 'tests/validate.test.ts',
      add: 46,
      del: 0,
      diff: [
        { t: '+', s: "describe('validateEmail', () => {" },
        { t: '+', s: "  it('拒绝空值与非法格式', () => {" },
        { t: '+', s: "    expect(validateEmail('')).toBe(false);" },
        { t: '+', s: "    expect(validateEmail('a@b')).toBe(false);" },
        { t: '+', s: '  });' },
        { t: '+', s: '});' },
      ],
    },
  },
  {
    kind: 'action',
    icon: 'command',
    label: '已运行 npm test',
    detail: {
      kind: 'command',
      command: 'npm test -- validate',
      lines: [
        { t: 'cmd', s: '$ npm test -- validate' },
        { t: 'add', s: ' PASS  tests/validate.test.ts' },
        { s: '' },
        { s: 'Tests:       6 passed, 6 total' },
      ],
    },
  },
];

const contrastSteps: Step[] = [
  {
    kind: 'text',
    text: '我把深色主题下所有按钮相关的颜色变量收集出来，对比一下前景色和背景色的对比度。',
  },
  {
    kind: 'action',
    icon: 'command',
    label: '已运行对比度检查',
    detail: {
      kind: 'command',
      command: 'node scripts/contrast.mjs src/styles/theme.css',
      lines: [
        { t: 'cmd', s: '$ node scripts/contrast.mjs src/styles/theme.css' },
        { t: 'err', s: ' --btn-secondary-bg / --btn-secondary-fg   1.9:1  FAIL' },
        { t: 'add', s: ' --btn-primary-bg   / --btn-primary-fg    8.4:1  PASS' },
      ],
    },
  },
  {
    kind: 'action',
    icon: 'edit',
    label: '已编辑 theme.css',
    detail: {
      kind: 'edit',
      file: 'src/styles/theme.css',
      add: 6,
      del: 4,
      diff: [
        { t: ' ', s: '[data-theme="dark"] {' },
        { t: '-', s: '  --btn-secondary-bg: #2b2b2b;' },
        { t: '+', s: '  --btn-secondary-bg: rgba(255, 255, 255, 0.08);' },
        { t: '-', s: '  --btn-secondary-fg: #7a7a7a;' },
        { t: '+', s: '  --btn-secondary-fg: var(--text);' },
        { t: ' ', s: '}' },
      ],
    },
  },
];

const apiTestSteps: Step[] = [
  {
    kind: 'text',
    text: '我先看路由定义和现有的鉴权中间件，确认权限校验发生在哪一层，再按这个结构补测试。',
  },
  {
    kind: 'action',
    icon: 'file',
    label: '已读取文件 src/routes/users.ts',
    detail: {
      kind: 'read',
      file: 'src/routes/users.ts',
      lines: [
        { s: 'router.get("/users", auth.required, adminOnly, listUsers);' },
        { s: 'router.get("/users/:id", auth.required, canRead, getUser);' },
        { s: 'router.patch("/users/:id", auth.required, canWrite, updateUser);' },
      ],
    },
  },
  {
    kind: 'action',
    icon: 'edit',
    label: '已编辑 users.test.ts',
    detail: {
      kind: 'edit',
      file: 'tests/users.test.ts',
      add: 88,
      del: 0,
      diff: [
        { t: '+', s: "it('未登录访问返回 401', async () => {" },
        { t: '+', s: '  const res = await request(app).get("/users");' },
        { t: '+', s: '  expect(res.status).toBe(401);' },
        { t: '+', s: '});' },
        { t: '+', s: '' },
        { t: '+', s: "it('普通用户访问他人资料返回 403', async () => {" },
        { t: '+', s: '  expect(res.status).toBe(403);' },
        { t: '+', s: '});' },
      ],
    },
  },
  {
    kind: 'action',
    icon: 'command',
    label: '已运行 npm test',
    detail: {
      kind: 'command',
      command: 'npm test -- users',
      lines: [
        { t: 'cmd', s: '$ npm test -- users' },
        { t: 'add', s: ' PASS  tests/users.test.ts' },
        { s: '' },
        { s: 'Tests:       9 passed, 9 total' },
        { s: 'Time:        2.31 s' },
      ],
    },
  },
];

const readmeSteps: Step[] = [
  {
    kind: 'text',
    text: '我先对照当前的目录结构和环境变量清单，再重写 README，最后补上 Docker 部署步骤。',
  },
  {
    kind: 'action',
    icon: 'command',
    label: '已运行列出项目结构',
    detail: {
      kind: 'command',
      command: 'rg --files -g "!node_modules" | head -30',
      lines: [
        { t: 'cmd', s: '$ rg --files -g "!node_modules" | head -30' },
        { s: 'src/index.ts' },
        { s: 'src/routes/users.ts' },
        { s: 'src/middleware/auth.ts' },
        { s: 'Dockerfile' },
        { s: '.env.example' },
      ],
    },
  },
  {
    kind: 'text',
    text: '`Dockerfile` 已经存在且可用，README 只需要说明构建与运行方式，不需要改镜像本身。',
  },
  {
    kind: 'action',
    icon: 'edit',
    label: '已编辑 README.md',
    detail: {
      kind: 'edit',
      file: 'README.md',
      add: 72,
      del: 35,
      diff: [
        { t: '+', s: '## 快速开始' },
        { t: '+', s: '```bash' },
        { t: '+', s: 'npm ci && npm run dev' },
        { t: '+', s: '```' },
        { t: '+', s: '' },
        { t: '+', s: '## Docker 部署' },
        { t: '+', s: 'docker build -t demo-api .' },
        { t: '+', s: 'docker run -p 3000:3000 --env-file .env demo-api' },
      ],
    },
  },
];

export const initialThreads: Thread[] = [
  {
    id: 'web-1',
    title: '为登录页添加表单校验',
    projectId: 'demo-web',
    messages: [
      {
        id: 'w1-1',
        role: 'user',
        content: '登录页现在没有任何校验，帮我加上邮箱格式和密码长度的前端校验，错误提示放在输入框下方',
      },
      {
        id: 'w1-2',
        role: 'assistant',
        duration: 1047,
        content:
          '已为登录页添加校验：\n- 新增 `src/utils/validate.ts`，提供 `validateEmail` 与 `validatePassword`\n- `LoginForm` 在提交前进行校验，错误信息显示在对应输入框下方\n- 密码长度要求为 8–64 位\n\n可以运行 `npm run dev` 在浏览器中验证。',
        edits: [
          { file: 'src/pages/Login.tsx', add: 24, del: 3 },
          { file: 'src/utils/validate.ts', add: 18, del: 0 },
        ],
        steps: validateSteps,
      },
      { id: 'w1-3', role: 'user', content: '再补一组单元测试，覆盖这两个校验函数' },
      {
        id: 'w1-4',
        role: 'assistant',
        duration: 322,
        content:
          '**已完成：**\n- 新增 `tests/validate.test.ts`，共 6 个用例\n- 覆盖空值、非法格式、边界长度等场景\n- `npm test` 全部通过（12 passed）',
        edits: [{ file: 'tests/validate.test.ts', add: 46, del: 0 }],
        steps: testSteps,
      },
    ],
  },
  {
    id: 'web-2',
    title: '修复深色模式下的按钮对比度',
    projectId: 'demo-web',
    messages: [
      { id: 'w2-1', role: 'user', content: '深色模式下次要按钮几乎看不清，帮我检查一下颜色变量' },
      {
        id: 'w2-2',
        role: 'assistant',
        duration: 128,
        content:
          '问题出在 `--btn-secondary-bg` 在深色主题下与背景色过于接近。\n\n已调整：\n- 深色主题下次要按钮背景改为 `rgba(255,255,255,0.08)`\n- 悬停态提升至 `0.12`\n- 文字颜色统一使用 `--text`，对比度达到 4.6:1',
        edits: [{ file: 'src/styles/theme.css', add: 6, del: 4 }],
        steps: contrastSteps,
      },
    ],
  },
  {
    id: 'api-1',
    title: '补充用户接口的单元测试',
    projectId: 'demo-api',
    messages: [
      { id: 'a1-1', role: 'user', content: '`/users` 相关接口还没有测试，帮我补一下，重点覆盖权限校验' },
      {
        id: 'a1-2',
        role: 'assistant',
        duration: 758,
        content:
          '已补充 `tests/users.test.ts`：\n- 未登录访问返回 401\n- 普通用户访问他人资料返回 403\n- 管理员可列出全部用户\n- 更新资料时的字段校验\n\n共 9 个用例，全部通过。',
        edits: [{ file: 'tests/users.test.ts', add: 88, del: 0 }],
        steps: apiTestSteps,
      },
    ],
  },
  {
    id: 'api-2',
    title: '整理 README 并添加部署说明',
    projectId: 'demo-api',
    messages: [
      { id: 'a2-1', role: 'user', content: 'README 太旧了，按现在的项目结构重写一下，并补充 Docker 部署步骤' },
      {
        id: 'a2-2',
        role: 'assistant',
        duration: 264,
        content:
          '已重写 README：\n- 更新目录结构与环境变量说明\n- 新增「快速开始」与「Docker 部署」两节\n- 补充常见问题\n\n`Dockerfile` 已存在，无需改动。',
        edits: [{ file: 'README.md', add: 72, del: 35 }],
        steps: readmeSteps,
      },
    ],
  },
];

export const initialProviders: Provider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-demo-xxxxxxxxxxxxxxxx',
    enabled: true,
    models: ['gpt-5', 'gpt-5-mini', 'o4-mini'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-demo-xxxxxxxx',
    enabled: true,
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: '',
    enabled: false,
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    enabled: false,
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    kind: 'ollama',
    baseUrl: 'http://localhost:11434',
    apiKey: '',
    enabled: true,
    models: ['qwen3:8b', 'llama3.1:8b'],
  },
];

export const initialMcp: McpServer[] = [
  {
    id: 'mcp-fs',
    name: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-filesystem C:\\Users\\dev\\code',
    url: '',
    env: '',
    enabled: true,
    status: 'connected',
    tools: ['read_file', 'write_file', 'list_directory', 'search_files', 'move_file'],
  },
  {
    id: 'mcp-gh',
    name: 'github',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-github',
    url: '',
    env: 'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxxxxxxx',
    enabled: true,
    status: 'connected',
    tools: ['create_issue', 'list_pull_requests', 'get_file_contents', 'search_code'],
  },
  {
    id: 'mcp-pw',
    name: 'playwright',
    transport: 'stdio',
    command: 'npx',
    args: '@playwright/mcp@latest',
    url: '',
    env: '',
    enabled: true,
    status: 'connected',
    tools: ['browser_navigate', 'browser_click', 'browser_type', 'browser_snapshot'],
  },
  {
    id: 'mcp-docs',
    name: 'remote-docs',
    transport: 'http',
    command: '',
    args: '',
    url: 'https://mcp.example.com/sse',
    env: '',
    enabled: false,
    status: 'disabled',
    tools: [],
  },
];

export const initialSkills: Skill[] = [
  {
    id: 'sk-review',
    name: 'code-review',
    description: '审查代码变更：检查边界条件、错误处理、可读性与测试覆盖，并按严重程度分级输出。',
    source: '内置',
    enabled: true,
    content:
      '# 代码审查\n\n在审查代码变更时：\n1. 先阅读 diff，理解改动目的\n2. 检查边界条件、错误处理与并发问题\n3. 指出可读性与测试覆盖问题\n4. 按「严重 / 建议 / 可选」分级输出',
  },
  {
    id: 'sk-commit',
    name: 'commit-message',
    description: '根据暂存区改动生成符合 Conventional Commits 规范的提交信息。',
    source: '内置',
    enabled: true,
    content: '# 提交信息\n\n1. 运行 `git diff --staged`\n2. 总结改动意图\n3. 输出 `type(scope): subject`，正文说明动机与影响',
  },
  {
    id: 'sk-frontend',
    name: 'frontend-design',
    description: '创建美观、一致的前端界面，遵循设计系统与无障碍规范。',
    source: '用户',
    enabled: true,
    content: '# 前端设计\n\n- 优先复用现有组件与设计令牌\n- 保持间距、字号、色彩一致\n- 为交互状态提供 hover / focus / disabled 样式',
  },
  {
    id: 'sk-pdf',
    name: 'pdf-processing',
    description: '读取、合并、拆分 PDF，并提取文本与表格。',
    source: '用户',
    enabled: false,
    content: '# PDF 处理\n\n使用 `pdfplumber` 提取文本与表格；使用 `pypdf` 合并与拆分。',
  },
  {
    id: 'sk-conv',
    name: 'project-conventions',
    description: '当前项目的代码风格、目录结构与提交约定。',
    source: '项目',
    enabled: true,
    content: '# 项目约定\n\n- 源码位于 `src/`，测试位于 `tests/`\n- 提交前运行 `npm run lint && npm test`\n- 分支命名：`feat/*`、`fix/*`',
  },
];

export function buildModelOptions(providers: Provider[]): ModelOption[] {
  return providers
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.map((m) => ({ id: `${p.id}:${m}`, name: m, provider: p.name })));
}

// Pi 原生 thinking level。旧版 WEPI 的 ultra 已移除，避免把 Pi 不认识的档位发给 RPC。
export const efforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof efforts)[number];

export const accessModes = [
  { id: 'full', name: '完全访问', desc: '无需批准即可编辑任何文件并运行联网命令', danger: true },
  { id: 'default', name: '默认权限', desc: '可读取和编辑工作区文件，需要时请求批准', danger: false },
  { id: 'readonly', name: '只读', desc: '只能读取文件，所有修改都需要批准', danger: false },
];

const replies: { content: string; edits?: FileEdit[]; steps: Step[] }[] = [
  {
    content:
      '已完成分析，主要改动如下：\n- 在 `src/agent/runner.ts` 中新增任务队列\n- 修复了 `session.resume()` 在断线后未重连的问题\n- 补充了 3 个单元测试，全部通过\n\n可以运行 `npm test` 验证。',
    edits: [
      { file: 'src/agent/runner.ts', add: 42, del: 7 },
      { file: 'tests/runner.test.ts', add: 58, del: 0 },
    ],
    steps: [
      { kind: 'text', text: '我先定位会话恢复与任务调度相关的模块，确认断线后的状态流转，再动手修改。' },
      {
        kind: 'action',
        icon: 'search',
        label: '已搜索 session.resume',
        detail: {
          kind: 'command',
          command: 'rg -n "session.resume|runner" src',
          lines: [
            { t: 'cmd', s: '$ rg -n "session.resume|runner" src' },
            { s: 'src/agent/runner.ts:18:export function createRunner()' },
            { s: 'src/agent/session.ts:74:  resume(): Promise<void>' },
          ],
        },
      },
      {
        kind: 'action',
        icon: 'file',
        label: '已读取文件 src/agent/session.ts',
        detail: {
          kind: 'read',
          file: 'src/agent/session.ts',
          lines: [
            { s: '  async resume() {' },
            { s: '    this.status = "running";' },
            { s: '    await this.transport.connect();' },
            { s: '  }' },
          ],
        },
      },
      {
        kind: 'action',
        icon: 'edit',
        label: '已编辑 runner.ts',
        detail: {
          kind: 'edit',
          file: 'src/agent/runner.ts',
          add: 42,
          del: 7,
          diff: [
            { t: '+', s: 'export interface TaskQueue {' },
            { t: '+', s: '  push(task: Task): void;' },
            { t: '+', s: '  next(): Task | undefined;' },
            { t: '+', s: '}' },
            { t: '-', s: '  if (this.status === "closed") return;' },
            { t: '+', s: '  if (this.status === "closed") await this.reconnect();' },
          ],
        },
      },
      {
        kind: 'action',
        icon: 'command',
        label: '已运行 npm test',
        detail: {
          kind: 'command',
          command: 'npm test',
          lines: [
            { t: 'cmd', s: '$ npm test' },
            { t: 'add', s: ' PASS  tests/runner.test.ts' },
            { s: '' },
            { s: 'Tests:       3 passed, 3 total' },
            { s: 'Time:        1.12 s' },
          ],
        },
      },
    ],
  },
  {
    content:
      '我查看了仓库结构，这是一个基于 **TypeScript** 的 Agent 项目：\n- `core/` 负责模型调用与工具编排\n- `cli/` 是命令行入口\n- `tools/` 包含文件、终端、浏览器等工具\n\n建议桌面端通过 `core` 暴露的 RPC 接口接入，避免重复实现。',
    steps: [
      { kind: 'text', text: '我先看一下仓库的目录结构和入口文件，确认各模块的职责边界。' },
      {
        kind: 'action',
        icon: 'command',
        label: '已运行列出项目结构',
        detail: {
          kind: 'command',
          command: 'rg --files -g "!node_modules" | head -40',
          lines: [
            { t: 'cmd', s: '$ rg --files -g "!node_modules" | head -40' },
            { s: 'core/index.ts' },
            { s: 'core/runner.ts' },
            { s: 'cli/main.ts' },
            { s: 'tools/files.ts' },
            { s: 'tools/terminal.ts' },
          ],
        },
      },
      {
        kind: 'action',
        icon: 'file',
        label: '已读取文件 core/index.ts',
        detail: {
          kind: 'read',
          file: 'core/index.ts',
          lines: [
            { s: 'export { createRunner } from "./runner";' },
            { s: 'export type { AgentEvent } from "./events";' },
            { s: 'export const VERSION = "0.4.1";' },
          ],
        },
      },
    ],
  },
  {
    content:
      '已更新配置：\n- 默认模型切换为 `gpt-5`\n- 开启流式输出\n\n后续如需回滚，执行 `git revert HEAD` 即可。',
    edits: [{ file: 'config/default.json', add: 3, del: 2 }],
    steps: [
      { kind: 'text', text: '我先读取当前配置，确认字段结构后再修改，避免破坏其他选项。' },
      {
        kind: 'action',
        icon: 'file',
        label: '已读取文件 config/default.json',
        detail: {
          kind: 'read',
          file: 'config/default.json',
          lines: [
            { s: '{' },
            { s: '  "model": "gpt-4o",' },
            { s: '  "stream": false' },
            { s: '}' },
          ],
        },
      },
      {
        kind: 'action',
        icon: 'edit',
        label: '已编辑 default.json',
        detail: {
          kind: 'edit',
          file: 'config/default.json',
          add: 3,
          del: 2,
          diff: [
            { t: '-', s: '  "model": "gpt-4o",' },
            { t: '+', s: '  "model": "gpt-5",' },
            { t: '-', s: '  "stream": false' },
            { t: '+', s: '  "stream": true' },
          ],
        },
      },
    ],
  },
];

export const pickReply = () => replies[Math.floor(Math.random() * replies.length)];
