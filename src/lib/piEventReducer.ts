import type { Step } from '../data';
import type { PiRpcEvent } from './piRpc';

/**
 * Pi 事件 → 单个回合渲染状态的纯函数归约器。
 *
 * 这段逻辑此前内联在 App 的事件回调里，并直接改 ref（React 的 state updater
 * 在 StrictMode 下会被调用两次，属于不纯操作），已经两次导致正文丢失。
 * 抽成纯函数后可脱离 UI 回放真实事件流做验证。
 */

export interface PiTurnState {
  /** 已累积的正文（跨回合内多条 Pi assistant 消息） */
  content: string;
  thinkingContent: string;
  steps: Step[];
  thinking: boolean;
  streaming: boolean;
  /** 回合耗时（秒），仅在收到 agent_settled 后写入 */
  duration?: number;
  /** 当前 Pi assistant 消息在 content 中的起始位置，用于段落级校正 */
  segmentStart: number;
  startedAt: number;
  /** 是否已收到 agent_settled（回合彻底结束） */
  finished: boolean;
}

export function createTurnState(startedAt: number): PiTurnState {
  return {
    content: '',
    thinkingContent: '',
    steps: [],
    thinking: true,
    streaming: true,
    segmentStart: 0,
    startedAt,
    finished: false,
  };
}

const textFromContent = (value: unknown): string =>
  Array.isArray(value)
    ? value
        .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object' && block.type === 'text')
        .map((block) => (typeof block.text === 'string' ? block.text : ''))
        .join('')
    : typeof value === 'string'
      ? value
      : '';

function stepIcon(toolName: string): Step['icon'] {
  if (toolName === 'bash' || toolName === 'powershell' || toolName === 'shell') return 'command';
  if (toolName === 'read' || toolName === 'ls' || toolName === 'find') return 'file';
  if (toolName === 'edit' || toolName === 'write') return 'edit';
  if (toolName === 'grep') return 'search';
  return 'agent';
}

function describeTool(toolName: string, args: Record<string, unknown> | undefined): string {
  if (typeof args?.command === 'string') return args.command;
  if (typeof args?.path === 'string') return `${toolName} ${args.path}`;
  if (typeof args?.pattern === 'string') return `${toolName} ${args.pattern}`;
  if (typeof args?.file_path === 'string') return `${toolName} ${args.file_path}`;
  return `${toolName}…`;
}

/**
 * 应用一条事件，返回新的回合状态。
 * 未识别的（或与回合无关的）事件原样返回，保证调用方可安全地按引用比较。
 */
export function applyPiEvent(state: PiTurnState, event: PiRpcEvent, now: number): PiTurnState {
  if (state.finished) return state;
  const type = event.type;
  switch (type) {
    case 'assistant_text_delta': {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (!delta) return state;
      return { ...state, thinking: false, streaming: true, content: state.content + delta };
    }
    case 'assistant_thinking_start':
      return { ...state, thinking: true, streaming: true };
    case 'assistant_thinking_delta': {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (!delta) return state;
      return { ...state, thinking: true, streaming: true, thinkingContent: state.thinkingContent + delta };
    }
    case 'assistant_thinking_end':
      return { ...state, thinking: false, streaming: true };
    case 'assistant_message_start':
      // Pi 在工具循环中会写多条 assistant 消息；记下本段起点，
      // 段落结束时可只替换本段而不影响前面的内容。
      return { ...state, thinking: true, streaming: true, segmentStart: state.content.length };
    case 'user_message_start':
      // 本地乐观消息为准，忽略 Pi 对用户消息的回显。
      return state;
    case 'message_update': {
      // 兜底分支：Rust 未识别的 assistantMessageEvent 会原样透传。
      const inner = (event.assistantMessageEvent ?? {}) as Record<string, unknown>;
      const delta = typeof inner.delta === 'string' ? inner.delta : '';
      if (inner.type === 'text_delta' && delta) {
        return { ...state, thinking: false, streaming: true, content: state.content + delta };
      }
      if (inner.type === 'thinking_delta' && delta) {
        return { ...state, thinking: true, streaming: true, thinkingContent: state.thinkingContent + delta };
      }
      if (inner.type === 'thinking_start') return { ...state, thinking: true, streaming: true };
      if (inner.type === 'thinking_end') return { ...state, thinking: false, streaming: true };
      return state;
    }
    case 'assistant_message_end':
    case 'message_end': {
      const message = event.message as Record<string, unknown> | undefined;
      // 只接受 assistant 消息；system/user 的 message_end 不能改写助手正文。
      if (message && message.role !== undefined && message.role !== 'assistant') return state;
      const finalText = textFromContent(message?.content);
      if (!finalText) return { ...state, thinking: false, streaming: true };
      // 段落级校正：用 Pi 落盘的该段最终文本替换本段，既不重复也不丢字。
      const head = state.content.slice(0, state.segmentStart);
      return { ...state, thinking: false, streaming: true, content: head + finalText, segmentStart: head.length + finalText.length };
    }
    case 'tool_execution_start': {
      const toolName = typeof event.toolName === 'string' ? event.toolName : '工具';
      const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : `tool-${state.steps.length}`;
      const args = event.args as Record<string, unknown> | undefined;
      const label = describeTool(toolName, args);
      const icon = stepIcon(toolName);
      return {
        ...state,
        thinking: false,
        streaming: true,
        steps: [
          ...state.steps,
          {
            id: toolCallId,
            kind: 'action',
            icon,
            label: `${icon === 'command' ? '已运行' : '已调用'} ${label}`,
            detail: { kind: 'command', command: label, lines: [] },
          },
        ],
      };
    }
    case 'tool_execution_update': {
      const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
      const output = textFromContent((event.partialResult as Record<string, unknown> | undefined)?.content ?? event.partialResult);
      if (!toolCallId || !output) return state;
      const lines = output.split('\n').map((s) => ({ s }));
      return {
        ...state,
        steps: state.steps.map((step) =>
          step.id !== toolCallId || step.detail?.kind !== 'command' ? step : { ...step, detail: { ...step.detail, lines } },
        ),
      };
    }
    case 'tool_execution_end': {
      const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
      if (!toolCallId) return state;
      const result = event.result as Record<string, unknown> | undefined;
      const output = textFromContent(result?.content ?? result);
      if (!output) return state;
      const isError = event.isError === true;
      return {
        ...state,
        steps: state.steps.map((step) => {
          if (step.id !== toolCallId || step.detail?.kind !== 'command') return step;
          return {
            ...step,
            detail: { ...step.detail, lines: output.split('\n').map((s) => ({ s, ...(isError ? { t: 'err' as const } : {}) })) },
          };
        }),
      };
    }
    case 'agent_settled':
      // 只有 settled 代表回合彻底结束；agent_end 仅是元数据，提前收尾会截断正文。
      return {
        ...state,
        thinking: false,
        streaming: false,
        finished: true,
        duration: Math.max(1, Math.round((now - state.startedAt) / 1000)),
      };
    default:
      return state;
  }
}

/** 回合结束后的呈现文本：有正文用正文，否则给出明确提示。 */
export function displayContent(state: PiTurnState): string {
  if (state.content) return state.content;
  return state.finished ? '（Pi 未返回文本）' : '';
}
