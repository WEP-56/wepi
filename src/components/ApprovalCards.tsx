import { ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ExtensionUiRequest } from '../lib/piRpc';
import { respondExtensionUi } from '../lib/piRpc';
import { parseSecurityConfirmTitle } from '../lib/extensionUi';
import { Btn } from './kit';

/** 审批选项文案：与扩展侧 UI_ALLOW/UI_DENY 字面值一致——响应按选项
 *  字符串原样回传（select 语义），文案就是两端契约，改一处必须同步另一处。 */
const ALLOW_VALUE = '允许执行';

/** 审批超时：与 PiDeck 的安全门一致，30 秒未批准自动拒绝（fail-safe）。 */
const APPROVAL_TIMEOUT_MS = 30_000;

/** 安全工具中文名（未知工具兜底显示原始工具名）。 */
const TOOL_LABELS: Record<string, string> = {
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  bash: '执行命令',
  grep: '搜索内容',
  find: '查找文件',
  ls: '列目录',
};

function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

/**
 * 安全确认审批卡（wepi-security-gate 扩展拦截「ask」动作时使用）。
 *
 * 与普通 select 卡的区别：把工具名 / 等级 / 详情拆成独立区块，命令或文件路径
 * 用等宽块完整展示（超长滚动），用户能看清「审批什么」再决定。
 * 响应经 extension_ui_response 回传 pi（select 语义 = 选项字符串）；
 * 取消 / 超时 / 关闭一律拒绝（fail-safe，与 PiDeck 行为一致）。
 */
export function SecurityConfirmCard({ request, sessionKey, onSettled }: { request: ExtensionUiRequest; sessionKey: string; onSettled?: () => void }) {
  const info = parseSecurityConfirmTitle(request.title);
  const [responding, setResponding] = useState(false);
  // 超时定时器用 ref 持有：组件卸载（切换会话）时清理，避免对已卸载组件 setState。
  const timerRef = useRef<number>(0);
  const settledRef = useRef(false);
  // onSettled 走 ref：父组件每次渲染产生新箭头函数，若进 effect 依赖会
  // 不断重建 30s 定时器（重置倒计时），ref 捕获最新回调且不触发重建。
  const settledCbRef = useRef(onSettled);
  settledCbRef.current = onSettled;
  useEffect(() => {
    settledRef.current = false;
    timerRef.current = window.setTimeout(() => {
      // 超时未批准 → 自动拒绝（扩展把非「允许执行」一律视为拒绝）。
      if (settledRef.current) return;
      settledRef.current = true;
      void respondExtensionUi(sessionKey, request.id, { value: '' }).finally(() => settledCbRef.current?.());
    }, APPROVAL_TIMEOUT_MS);
    return () => window.clearTimeout(timerRef.current);
  }, [request.id, sessionKey]);
  if (!info) return null;

  const respond = async (value: string) => {
    if (responding || settledRef.current) return;
    settledRef.current = true;
    window.clearTimeout(timerRef.current);
    setResponding(true);
    try {
      await respondExtensionUi(sessionKey, request.id, { value });
    } catch {
      // 回复失败（进程退出等）：pi 侧等待方随进程状态解除，这里静默。
    } finally {
      setResponding(false);
      settledCbRef.current?.();
    }
  };

  return (
    <div className="mx-auto mb-1.5 w-full rounded-[22px] border border-[var(--border-strong)] bg-[var(--bg-elev)] p-4 shadow-2xl shadow-black/30">
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--bg-hover)] px-2 py-1 text-[11.5px] font-medium text-[var(--text-2)]">
          <ShieldAlert size={13} className="shrink-0 text-[var(--orange)]" />
          <span className="shrink-0">审批</span>
          <span className="font-semibold text-[var(--text)]">{toolLabel(info.tool)}</span>
        </span>
        {info.level ? (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--bg-hover)] px-2 py-1 text-[11.5px] font-medium text-[var(--text-2)]">
            <span className="shrink-0">等级</span>
            <span className="font-semibold text-[var(--text)]">{info.level}</span>
          </span>
        ) : null}
      </div>

      <div className="mb-3.5 rounded-xl bg-[var(--bg-hover)] px-3 py-2.5">
        <div className="mb-1 text-[11px] font-semibold text-[var(--text-3)]">详情</div>
        {info.detail ? (
          <pre className="scroll-thin max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-[var(--text)]">{info.detail}</pre>
        ) : (
          <div className="text-[11.5px] text-[var(--text-3)]">（无详情）</div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Btn variant="ghost" onClick={() => void respond('')} disabled={responding}>
          拒绝
        </Btn>
        <Btn variant="primary" onClick={() => void respond(ALLOW_VALUE)} disabled={responding}>
          {responding ? '…' : '允许执行'}
        </Btn>
      </div>
    </div>
  );
}

/**
 * 通用对话卡（select/confirm/input/editor 的非安全确认兜底渲染）。
 * 目前只处理 select / confirm / input；editor 暂以文本输入呈现。
 */
export function DialogRequestCard({ request, sessionKey, onSettled }: { request: ExtensionUiRequest; sessionKey: string; onSettled?: () => void }) {
  const [responding, setResponding] = useState(false);
  const [text, setText] = useState('');

  const respond = async (outcome: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
    if (responding) return;
    setResponding(true);
    try {
      await respondExtensionUi(sessionKey, request.id, outcome);
    } catch {
      // pi 侧超时兜底。
    } finally {
      setResponding(false);
      onSettled?.();
    }
  };

  const title = typeof request.title === 'string' && request.title ? request.title : 'Pi 请求输入';

  return (
    <div className="mx-auto mb-1.5 w-full rounded-[22px] border border-[var(--border-strong)] bg-[var(--bg-elev)] p-4 shadow-2xl shadow-black/30">
      <div className="mb-1.5 text-[13.5px] font-semibold text-[var(--text)]">{title}</div>
      {request.message ? <div className="mb-3 whitespace-pre-wrap text-[12.5px] leading-5 text-[var(--text-2)]">{request.message}</div> : null}

      {request.method === 'select' && Array.isArray(request.options) ? (
        <div className="mb-3 flex flex-col gap-1">
          {request.options.map((option) => (
            <button
              key={option}
              className="rounded-lg bg-[var(--bg-hover)] px-3 py-2 text-left text-[12.5px] text-[var(--text)] transition-colors hover:bg-[var(--bg-active)] disabled:opacity-50"
              disabled={responding}
              onClick={() => void respond({ value: option })}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}

      {request.method === 'confirm' ? (
        <div className="mb-3 flex items-center justify-end gap-2">
          <Btn variant="ghost" onClick={() => void respond({ confirmed: false })} disabled={responding}>
            否
          </Btn>
          <Btn variant="primary" onClick={() => void respond({ confirmed: true })} disabled={responding}>
            是
          </Btn>
        </div>
      ) : null}

      {(request.method === 'input' || request.method === 'editor') && (
        <div className="mb-3 flex items-center gap-2">
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={typeof request.placeholder === 'string' ? request.placeholder : '输入…'}
            className="min-w-0 flex-1 rounded-xl border border-[var(--border-strong)] bg-transparent px-3 py-2 text-[12.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--blue)]"
            disabled={responding}
          />
          <Btn variant="primary" onClick={() => void respond({ value: text })} disabled={responding}>
            提交
          </Btn>
        </div>
      )}

      <div className="flex justify-end">
        <Btn variant="ghost" onClick={() => void respond({ cancelled: true })} disabled={responding}>
          取消
        </Btn>
      </div>
    </div>
  );
}
