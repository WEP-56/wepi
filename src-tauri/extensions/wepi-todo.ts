/**
 * WEPI Todo Extension
 *
 * 管理分支级持久化的当前工作计划（对齐 PiDeck pi-deck-todo 的核心设计）：
 * - 计划只通过显式工具动作变更：replace 开新计划、restore 撤回上一次替换、
 *   clear 故意清空。完成、空闲、普通用户消息、会话启动都不推断计划边界。
 * - 动作集：list | add | update | delete | replace | restore | clear。
 * - 状态以 v3 custom 条目持久化（wepi-todo-state 的 TodoState），
 *   session_start / session_tree 时重建，切换会话分支恢复对应分支的计划。
 * - 零缓存失效设计：模型对计划的最新视图由最近一次变更的 toolResult 携带
 *   （append-only 历史，不打断提示前缀缓存）。压缩后由 before_agent_start
 *   检测并补注一条持久简报。
 * - widget 通过 ctx.ui.setWidget（string[] 形式，RPC 模式原生支持）发布，
 *   首行是机器可读的计划身份元数据行，WEPI 渲染层解析渲染 todo 条。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	decodeTodoState,
	emptyTodoState,
	formatTodoPlanModelText,
	formatTodoWidgetLine,
	reduceTodoState,
	TODO_BRIEF_ENTRY_TYPE,
	TODO_SNAPSHOT_ENTRY_TYPE,
	TODO_STATUSES,
	todoBriefNeededAfterCompaction,
	VALID_TODO_ACTIONS,
	type TodoPlan,
	type TodoState,
} from "./wepi-todo-state";

const WIDGET_KEY = "wepi-todo";
const ENTRY_TYPE = TODO_SNAPSHOT_ENTRY_TYPE;
const OWN_EXTENSION_FILE = "wepi-todo.ts";
// 旧版「每轮临时提醒」的类型。已停止生产；context 保留防御性剥离。
const TODO_CONTEXT_ENTRY_TYPE = "wepi-todo-context";
// WEPI 渲染层契约：widget 首行携带计划身份（分支 id + 计划 id）。
const PLAN_METADATA_PREFIX = "[[wepi:todo-plan:";
const PLAN_METADATA_SUFFIX = "]]";

const TodoParams = Type.Object(
	{
		action: StringEnum(VALID_TODO_ACTIONS),
		text: Type.Optional(Type.String({ description: "Todo text (for add / update)" })),
		status: Type.Optional(StringEnum(TODO_STATUSES)),
		id: Type.Optional(Type.Number({ description: "Todo ID (for update / delete)" })),
		items: Type.Optional(
			Type.Array(
				Type.Object({
					text: Type.String({ description: "Todo text in a replacement plan" }),
					status: Type.Optional(StringEnum(TODO_STATUSES)),
				}),
				{ description: "Complete replacement plan (required for replace)" },
			),
		),
	},
	{ additionalProperties: false },
);

type SuccessResult = Extract<ReturnType<typeof reduceTodoState>, { ok: true }>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTodoPlanContextMessage(message: unknown): boolean {
	return isRecord(message) && message.customType === TODO_CONTEXT_ENTRY_TYPE;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export default function wepiTodoExtension(pi: ExtensionAPI): void {
	// 内存单一真源：只读恢复（decode）与每次成功变更（reducer）都在这里。
	let state: TodoState = emptyTodoState();
	// 第三方 todo 工具接管名字后让位：停止发布 widget。
	let yielded = false;

	function resetState(): void {
		state = emptyTodoState();
	}

	function ownExtensionPath(): string {
		// pi 用 jiti 以 CommonJS 包装加载扩展：__filename 指向扩展自身文件。
		if (typeof __filename === "string" && __filename.length > 0) return __filename;
		return "";
	}

	function normalizeExtensionPath(value: string): string {
		return value.replace(/\\/g, "/").toLowerCase();
	}

	function basenameOf(normalized: string): string {
		const slash = normalized.lastIndexOf("/");
		return slash >= 0 ? normalized.slice(slash + 1) : normalized;
	}

	/** 工具归属精确比较：与自身路径规范化后相等，或 basename 恰好等于自身。 */
	function isOwnTodo(): boolean {
		const tool = pi.getAllTools().find((candidate) => candidate.name === "todo");
		const sourceInfo = isRecord(tool?.sourceInfo) ? tool.sourceInfo : undefined;
		const path = typeof sourceInfo?.path === "string" ? sourceInfo.path : "";
		if (!path) return false;
		const candidate = normalizeExtensionPath(path);
		const own = normalizeExtensionPath(ownExtensionPath());
		return own !== ""
			? candidate === own
			: basenameOf(candidate) === OWN_EXTENSION_FILE;
	}

	function clonePlan(plan: TodoPlan): TodoPlan {
		return { id: plan.id, todos: plan.todos.map((item) => ({ ...item })) };
	}

	function persistState(): void {
		pi.appendEntry(ENTRY_TYPE, {
			version: 3,
			...(state.activePlan ? { activePlan: clonePlan(state.activePlan) } : {}),
			...(state.previousPlan ? { previousPlan: clonePlan(state.previousPlan) } : {}),
			nextPlanId: state.nextPlanId,
			nextTodoId: state.nextTodoId,
		});
	}

	function planMetadataLine(scopeId: string | undefined, planId: number): string {
		const identity = scopeId ? `${encodeURIComponent(scopeId)}:${planId}` : String(planId);
		return `${PLAN_METADATA_PREFIX}${identity}${PLAN_METADATA_SUFFIX}`;
	}

	/** 扩展总是发布完整条目行；折叠/展开由 WEPI 渲染层负责。 */
	function updateWidget(ctx: ExtensionContext): void {
		const activePlan = state.activePlan;
		if (!activePlan) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, [
			planMetadataLine(nonEmptyString(ctx.sessionManager.getLeafId()), activePlan.id),
			...activePlan.todos.map((item) => formatTodoWidgetLine(item)),
		]);
	}

	/** 只恢复所选会话分支上最后一次的 v3 快照。 */
	function reconstructState(ctx: ExtensionContext): void {
		let lastData: unknown;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (!isRecord(entry)) continue;
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) lastData = entry.data;
		}
		// 只读 v3：旧格式/非法快照解码为 undefined → 无计划，不迁移、不写回。
		const decoded = decodeTodoState(lastData);
		state = decoded ?? emptyTodoState();
	}

	function restoreForCurrentBranch(ctx: ExtensionContext): void {
		if (!isOwnTodo()) {
			yielded = true;
			resetState();
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		yielded = false;
		reconstructState(ctx);
		updateWidget(ctx);
	}

	/** 压缩后补注的简报正文。 */
	function planBriefContent(plan: TodoPlan): string {
		return [
			`[CURRENT TODO PLAN #${plan.id}]`,
			"This is the current plan, not a history-based task boundary. Continue it with add/update while it still applies. Remove one obsolete item with action=delete and its id. For a new or materially re-scoped request, call action=replace with the complete new plan even if old items are unfinished. Do not clear because items are complete or because a new user message arrived. Use action=restore after an accidental replacement. If an id is uncertain, call action=list first.",
			"",
			formatTodoPlanModelText(plan),
		].join("\n");
	}

	function todoCountSuffix(count: number): string {
		return count === 1 ? " (1 todo in plan)" : ` (${count} todos in plan)`;
	}

	function todoResultText(action: string, result: SuccessResult): string {
		switch (action) {
			case "list":
				return formatTodoPlanModelText(state.activePlan);
			case "add":
				return `Added todo #${result.addedItem?.id}: ${result.addedItem?.text}${todoCountSuffix(result.todoCount)}`;
			case "update": {
				const item = result.updatedItem;
				const fields = result.updatedFields;
				if (fields && !fields.status && !fields.text) {
					return `Todo #${item?.id} already ${item?.status}${todoCountSuffix(result.todoCount)}`;
				}
				const changes: string[] = [];
				if (fields?.status) changes.push(`→ ${item?.status}`);
				if (fields?.text) changes.push(`text: ${item?.text}`);
				return `Updated todo #${item?.id} ${changes.join(", ")}${todoCountSuffix(result.todoCount)}`;
			}
			case "replace":
				return `Replaced the current plan with ${result.todoCount} todos`;
			case "delete":
				return `Deleted todo #${result.deletedItem?.id}: ${result.deletedItem?.text}${todoCountSuffix(result.todoCount)}`;
			case "restore":
				return `Restored todo plan #${result.activePlanId}${todoCountSuffix(result.todoCount)}`;
			default:
				return "Cleared the current todo plan";
		}
	}

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage the current todo plan. Actions: list, add, update (id + status/text), delete (id, removing a single item), replace (atomically begin a new plan), restore (undo the latest replacement), and clear (intentionally remove it).",
		promptSnippet: "List or change the current todo plan (list / add / update / delete / replace / restore / clear)",
		promptGuidelines: [
			"Maintain the actionable plan with the todo tool. After finishing an item, call action=update with its id and status=completed. Remove one obsolete item with action=delete and its id. Use action=replace only to rebuild the whole plan. If an id is uncertain, call action=list first.",
			"Start a new or materially re-scoped task with one action=replace call containing the complete new plan. Never infer that boundary from completed items, idle time, a user message, or session start.",
			"If a replacement was mistaken, call action=restore immediately. Use action=clear only when intentionally discarding the active plan.",
			"Todo state is per-branch: switching branches restores that branch's plan.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const mutation = {
				action: params.action,
				text: params.text,
				status: params.status,
				id: params.id,
				items: params.items,
			};
			const result = reduceTodoState(state, mutation);
			if (!result.ok) {
				// 校验失败抛错：不写快照、不改状态；由 pi 转 isError。
				throw new Error(result.error);
			}
			if (result.changed) {
				state = result.state;
				persistState();
			}
			updateWidget(ctx);
			// 模型可见的计划视图由最近一次变更的 toolResult 携带（append-only，
			// 前缀缓存零影响）：每次真实变更后附加计划全文。
			let text = todoResultText(params.action, result);
			if (result.changed && state.activePlan) {
				text += `\n\n${formatTodoPlanModelText(state.activePlan)}`;
			}
			return {
				content: [{ type: "text" as const, text }],
			};
		},
	});

	pi.registerCommand("todo", {
		description: "查看、清空或恢复当前分支待办计划",
		handler: async (args, ctx) => {
			if (!isOwnTodo()) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.notify("Todo 工具由其他扩展提供，请使用其对应命令查看。", "info");
				return;
			}
			const command = String(args ?? "").trim().toLowerCase();
			if (command === "clear") {
				const result = reduceTodoState(state, { action: "clear" });
				if (!result.ok || !result.changed) {
					ctx.ui.notify("当前没有待办计划可清空。", "info");
					return;
				}
				state = result.state;
				persistState();
				updateWidget(ctx);
				ctx.ui.notify("已清空当前待办计划。", "info");
				return;
			}
			if (command === "restore") {
				const result = reduceTodoState(state, { action: "restore" });
				if (!result.ok) {
					ctx.ui.notify("没有可恢复的被替换计划。", "info");
					return;
				}
				state = result.state;
				persistState();
				updateWidget(ctx);
				ctx.ui.notify(`已恢复待办计划 #${state.activePlan?.id}。`, "info");
				return;
			}
			if (!state.activePlan) {
				ctx.ui.notify("还没有待办计划，可以告诉 AI 添加或替换计划。", "info");
				return;
			}
			const todos = state.activePlan.todos;
			ctx.ui.notify(
				`Todos ${todos.filter((item) => item.status === "completed").length}/${todos.length}\n${todos.map((item) => formatTodoWidgetLine(item)).join("\n")}`,
				"info",
			);
		},
	});

	pi.on("context", async (event) => {
		// 不再注入任何每轮内容（零失效设计）；只做防御性剥离旧版提醒消息
		// 与第三方接管 todo 工具时的让位维护。
		const messages = event.messages.filter((message) => !isTodoPlanContextMessage(message));
		const removedLegacy = messages.length !== event.messages.length;

		if (!isOwnTodo()) {
			if (!yielded) {
				yielded = true;
				resetState();
			}
			return removedLegacy ? { messages } : undefined;
		}

		if (yielded) {
			// context 事件没有 ctx 可用于重建分支状态；只复位让位标记，
			// 状态由下一次 session_start / session_tree 正确重建。
			yielded = false;
		}
		return removedLegacy ? { messages } : undefined;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		// 压缩/分支摘要会冲掉历史里的计划视图，而该事件本身已使缓存全部
		// 失效——此刻持久追加一条简报是零缓存成本的，且幂等、下次压缩后自愈。
		if (!isOwnTodo()) return;
		if (!state.activePlan) return;
		if (!todoBriefNeededAfterCompaction(ctx.sessionManager.getBranch())) return;
		pi.appendEntry(TODO_BRIEF_ENTRY_TYPE, { reason: "post-compaction" });
		return {
			message: {
				customType: TODO_BRIEF_ENTRY_TYPE,
				content: planBriefContent(state.activePlan),
				display: false,
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreForCurrentBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreForCurrentBranch(ctx);
	});
}
