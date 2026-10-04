import type { TurnBlock } from '../data';
import type { PiRpcEvent } from './piRpc';

/**
 * Pi 事件 → 回合渲染状态（blocks 模型）的纯函数归约器。
 *
 * 设计对齐 pilo 的 conversation-reducer / chat-activity-state，并针对
 * 实测的 Pi RPC 事件序列做了 turn 边界处理：
 *
 * 实测序列（带工具的多 turn 任务）：
 *   agent_start → turn_start
 *     msg_start(assistant) toolcall_start/end msg_end(text="")   ← 决策消息
 *     tool_execution_start/end                                  ← 工具执行
 *     msg_start(toolResult) msg_end(toolResult)
 *   turn_end
 *   turn_start
 *     msg_start(assistant) text_start/delta/end msg_end(text=全文) ← 叙述/最终
 *   turn_end
 *   agent_settled
 *
 * 关键规则：
 * - **narration 降级**：`turn_end` 时若回合内产出过工具调用，该回合的
 *   text 属于「过程叙述」（"好的，让我先深入研究……"），降级为 narration
 *   块折进时间线；只有最后一个 turn（其后无更多工具）的 text 才是最终
 *   回答，渲染为正文。
 * - **流式去重**：text 以 delta 流式拼接为准；`msg_end` 只做「段落级
 *   校正」——仅当该段落流式期间一个 delta 都没收到时才用落盘全文补齐，
 *   避免同一文本渲染两遍（delta 拼接 + message_end 全文 = 双份）。
 * - 归约器保持纯函数：不碰 ref、不依赖 React 生命周期，可脱离 UI
 *   回放真实事件流做验证。
 */

export type TextBlock = Extract<TurnBlock, { kind: 'text' }> & { narration?: boolean };

export interface PiTurnState {
  blocks: TurnBlock[];
  streaming: boolean;
  /** 回合开始时间戳（ms），settled 时换算 duration */
  startedAt: number;
  finished: boolean;
  duration?: number;
  /** 结束原因：aborted / error 时 UI 有专门呈现 */
  stopReason?: string | null;
  errorMessage?: string | null;
  /** 自动重试进度展示 */
  retrying?: { attempt: number; maxAttempts: number } | null;
  /** 压缩上下文进行中的提示块 id */
  compactionId?: string | null;
  /**
   * 当前 turn 内是否见过工具调用：turn_end 时据此判定该 turn 的 text
   * 是过程叙述（降级 narration）还是最终回答（保持正文）。
   */
  turnHasTools: boolean;
  /** 当前 text 段是否收到过流式 delta（去重：msg_end 不再重复补全文） */
  textStreamed: boolean;
  /** 已完成的 turn 数（>1 时 UI 显示 turn 分隔） */
  turns: number;
}

let blockSeq = 0;
const nextBlockId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(blockSeq++).toString(36)}`;

export function createTurnState(startedAt: number): PiTurnState {
  return {
    blocks: [],
    streaming: true,
    startedAt,
    finished: false,
    retrying: null,
    turnHasTools: false,
    textStreamed: false,
    turns: 0,
  };
}

const lastOf = <T>(list: T[]): T | undefined => list[list.length - 1];

const textFromContent = (value: unknown): string =>
  Array.isArray(value)
    ? value
        .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object' && block.type === 'text')
        .map((block) => (typeof block.text === 'string' ? block.text : ''))
        .join('')
    : typeof value === 'string'
      ? value
      : '';

/** 事件自带的 sessionKey 用于路由，不参与归约。 */
export function applyPiEvent(state: PiTurnState, event: PiRpcEvent, now: number): PiTurnState {
  if (state.finished) return state;
  const type = event.type;
  switch (type) {
    /* ---------- Pi turn 边界 ---------- */
    case 'turn_start': {
      // 新 turn 开启：重置 per-turn 标记（叙述降级判定用）。
      return { ...state, turnHasTools: false, textStreamed: false, streaming: true };
    }
    case 'turn_end': {
      // turn 结束：若本 turn 用过工具，其中的 text 是过程叙述 → 降级。
      const blocks = state.blocks.map((block) => {
        if (block.kind !== 'text') return block;
        if (state.turnHasTools && !isFinalTurnText(state, block)) {
          return { ...block, narration: true } as TurnBlock;
        }
        return block;
      });
      return { ...state, blocks, turns: state.turns + 1 };
    }

    /* ---------- 思考 ---------- */
    case 'assistant_thinking_start': {
      const blocks = state.blocks.map((block) => (block.kind === 'thinking' && block.running ? { ...block, running: false } : block));
      blocks.push({ kind: 'thinking', id: nextBlockId('think'), text: '', running: true });
      return { ...state, blocks, streaming: true };
    }
    case 'assistant_thinking_delta': {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (!delta) return state;
      const last = lastOf(state.blocks);
      if (last?.kind === 'thinking' && last.running) {
        const blocks = [...state.blocks];
        blocks[blocks.length - 1] = { ...last, text: last.text + delta };
        return { ...state, blocks, streaming: true };
      }
      return {
        ...state,
        streaming: true,
        blocks: [...state.blocks, { kind: 'thinking', id: nextBlockId('think'), text: delta, running: true }],
      };
    }
    case 'assistant_thinking_end': {
      const blocks = state.blocks.map((block) => (block.kind === 'thinking' ? { ...block, running: false } : block));
      return { ...state, blocks, streaming: true };
    }

    /* ---------- 正文 ---------- */
    case 'assistant_text_start':
      return { ...state, textStreamed: false, streaming: true };
    case 'assistant_text_delta': {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (!delta) return state;
      const last = lastOf(state.blocks);
      const blocks = [...state.blocks];
      if (last?.kind === 'text') {
        blocks[blocks.length - 1] = { ...last, text: last.text + delta };
      } else {
        blocks.push({ kind: 'text', id: nextBlockId('text'), text: delta });
      }
      return { ...state, blocks, streaming: true, textStreamed: true };
    }
    case 'assistant_text_end':
      return state;

    case 'assistant_message_start': {
      // 新 assistant 消息：收掉进行中的思考块；文本段落由后续 delta 决定。
      const blocks = state.blocks.map((block) => (block.kind === 'thinking' && block.running ? { ...block, running: false } : block));
      return { ...state, blocks, textStreamed: false, streaming: true };
    }
    case 'assistant_message_end': {
      // 消息落盘：仅在「整段一个 delta 都没收到」时用落盘全文补齐（防
      // 上游关闭增量），否则保持 delta 拼接结果——避免双份文本。
      const message = event.message as { content?: unknown } | undefined;
      const settledText = textFromContent(message?.content);
      const blocks = state.blocks.map((block) => (block.kind === 'thinking' && block.running ? { ...block, running: false } : block));
      if (!settledText) return { ...state, blocks };
      if (state.textStreamed) return { ...state, blocks };
      const last = lastOf(blocks);
      if (last?.kind === 'text') {
        const next = [...blocks];
        next[next.length - 1] = { ...last, text: settledText };
        return { ...state, blocks: next };
      }
      return { ...state, blocks: [...blocks, { kind: 'text', id: nextBlockId('text'), text: settledText }] };
    }
    case 'user_message_start':
      return state; // 本地乐观消息为准

    /* ---------- 工具 ---------- */
    case 'tool_execution_start': {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId : nextBlockId('tool');
      const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
      const exists = state.blocks.some((block) => block.kind === 'tool' && block.id === id);
      const blocks = exists
        ? state.blocks.map((block) => (block.kind === 'tool' && block.id === id ? { ...block, running: true } : block))
        : [...state.blocks, { kind: 'tool' as const, id, toolName, args: event.arguments ?? event.args, running: true }];
      // 本 turn 出现工具 → turn_end 时前面的 text 全部按叙述处理。
      return { ...state, blocks, streaming: true, turnHasTools: true };
    }
    case 'tool_execution_update': {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId : '';
      if (!id) return state;
      const blocks = state.blocks.map((block) =>
        block.kind === 'tool' && block.id === id
          ? { ...block, args: event.arguments ?? event.args ?? block.args, result: event.partialResult ?? block.result }
          : block,
      );
      return { ...state, blocks };
    }
    case 'tool_execution_end': {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId : '';
      if (!id) return state;
      const isError = event.isError === true;
      const blocks = state.blocks.map((block) =>
        block.kind === 'tool' && block.id === id
          ? { ...block, running: false, result: event.result, isError, args: event.arguments ?? event.args ?? block.args }
          : block,
      );
      return { ...state, blocks };
    }

    /* ---------- agent 回合结束 ---------- */
    case 'agent_settled': {
      const blocks = state.blocks.map((block) =>
        block.kind === 'thinking' || block.kind === 'tool' ? { ...block, running: false } : block,
      );
      return {
        ...state,
        blocks,
        streaming: false,
        finished: true,
        duration: Math.max(0, Math.round((now - state.startedAt) / 1000)),
      };
    }

    /* ---------- 重试 / 压缩 ---------- */
    case 'auto_retry_start':
      return {
        ...state,
        retrying: {
          attempt: typeof event.attempt === 'number' ? event.attempt : 1,
          maxAttempts: typeof event.maxAttempts === 'number' ? event.maxAttempts : 1,
        },
      };
    case 'auto_retry_end':
      return { ...state, retrying: event.success === true ? null : state.retrying };
    case 'compaction_start': {
      const id = nextBlockId('compact');
      return {
        ...state,
        compactionId: id,
        blocks: [...state.blocks, { kind: 'tool', id, toolName: '__compaction__', running: true }],
      };
    }
    case 'compaction_end': {
      const target = state.compactionId;
      const aborted = event.aborted === true;
      const willRetry = event.willRetry === true;
      const blocks = state.blocks.map((block) =>
        block.kind === 'tool' && block.id === target
          ? { ...block, running: false, result: { note: aborted ? '已取消' : willRetry ? '完成，即将重试' : '完成' } }
          : block,
      );
      return { ...state, blocks, compactionId: null };
    }

    /* ---------- 兜底：Rust 未识别的原样事件 ---------- */
    case 'message_update': {
      const inner = (event.assistantMessageEvent ?? {}) as Record<string, unknown>;
      const innerType = typeof inner.type === 'string' ? inner.type : '';
      const delta = typeof inner.delta === 'string' ? inner.delta : '';
      if (innerType === 'text_delta' && delta) {
        return applyPiEvent(state, { type: 'assistant_text_delta', delta }, now);
      }
      if (innerType === 'text_start') return { ...state, textStreamed: false };
      if (innerType === 'text_end') return state;
      if (innerType === 'thinking_delta' && delta) {
        return applyPiEvent(state, { type: 'assistant_thinking_delta', delta }, now);
      }
      return state;
    }
    default:
      return state;
  }
}

/**
 * 判断某个 text 块是否「最终回答」：它后面不再有工具块。
 * turn_end 时前面的叙述据此与最终回答区分。
 */
function isFinalTurnText(state: PiTurnState, block: TurnBlock): boolean {
  const index = state.blocks.indexOf(block);
  if (index < 0) return true;
  return !state.blocks.slice(index + 1).some((later) => later.kind === 'tool');
}

/** 回合结束后用于正文展示的 text：只取非 narration 块。 */
export function displayContent(state: PiTurnState): string {
  const text = state.blocks
    .filter((block) => block.kind === 'text' && !(block as TextBlock).narration)
    .map((block) => (block as TextBlock).text)
    .join('');
  if (text) return text;
  return state.finished ? '（Pi 未返回文本）' : '';
}

/** 时间线展示的块：activity（思考/工具）+ narration 文本。 */
export function activityBlocks(state: PiTurnState): TurnBlock[] {
  return state.blocks.filter(
    (block) => block.kind !== 'text' || (block as TextBlock).narration === true,
  );
}

/** 流式状态标签（pilo 的 getAssistantStreamingState 同款语义）。 */
export function streamingLabel(state: PiTurnState): 'starting' | 'thinking' | 'processing' | null {
  if (!state.streaming || state.finished) return null;
  if (state.blocks.length === 0) return 'starting';
  if (state.blocks.some((block) => block.kind === 'thinking' && block.running)) return 'thinking';
  return 'processing';
}
