import type { AgentTab, SessionSummary } from "../../shared/types";

const DEFAULT_VISIBLE_PROJECT_CHILD_LIMIT = 5;

export type ProjectChildItem =
	| {
			type: "agent";
			key: string;
			agent: AgentTab;
			sortAt: number;
	  }
	| {
			type: "session";
			key: string;
			session: SessionSummary;
			sortAt: number;
	  };

export type ProjectAgentSessionDisplay = {
	children: ProjectChildItem[];
	visibleChildren: ProjectChildItem[];
	hiddenChildCount: number;
};

// 会话文件路径可能来自扫描器或 Agent 状态回写，比较时统一分隔符和大小写，避免同一历史会话重复显示/重复激活。
export function normalizeSessionPathForCompare(sessionPath?: string) {
	return sessionPath?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isSameSessionPath(left?: string, right?: string) {
	const normalizedLeft = normalizeSessionPathForCompare(left);
	const normalizedRight = normalizeSessionPathForCompare(right);
	return Boolean(
		normalizedLeft && normalizedRight && normalizedLeft === normalizedRight,
	);
}

function getSessionKey(sessionPath?: string) {
	return normalizeSessionPathForCompare(sessionPath);
}

function getAgentSortAt(agent: AgentTab, sessionByKey: Map<string, SessionSummary>) {
	const sessionKey = getSessionKey(agent.sessionPath);
	// 历史会话激活成 Agent 后仍按原会话更新时间排序；全新 Agent 没有历史文件时按创建时间排到最新。
	return sessionKey ? (sessionByKey.get(sessionKey)?.updatedAt ?? agent.createdAt) : agent.createdAt;
}

function chooseAgentForSession(current: AgentTab, candidate: AgentTab) {
	// 如果异常状态下同一个 sessionPath 已经产生多个 Agent，UI 只保留一个：优先保留更新创建的运行态，避免继续暴露重复入口。
	if (candidate.createdAt !== current.createdAt) {
		return candidate.createdAt > current.createdAt ? candidate : current;
	}
	return candidate.status === "running" ? candidate : current;
}

export function getProjectAgentSessionDisplay({
	agents,
	sessions,
	visibleChildCount,
}: {
	agents: AgentTab[];
	sessions: SessionSummary[];
	visibleChildCount?: number;
}): ProjectAgentSessionDisplay {
	const sessionByKey = new Map<string, SessionSummary>();
	const unkeyedSessions: SessionSummary[] = [];
	for (const session of sessions) {
		const sessionKey = getSessionKey(session.filePath);
		if (sessionKey) sessionByKey.set(sessionKey, session);
		else unkeyedSessions.push(session);
	}

	const agentBySessionKey = new Map<string, AgentTab>();
	const unkeyedAgents: AgentTab[] = [];
	for (const agent of agents) {
		const sessionKey = getSessionKey(agent.sessionPath);
		if (!sessionKey) {
			unkeyedAgents.push(agent);
			continue;
		}
		const current = agentBySessionKey.get(sessionKey);
		agentBySessionKey.set(
			sessionKey,
			current ? chooseAgentForSession(current, agent) : agent,
		);
	}

	const children: ProjectChildItem[] = [
		...unkeyedAgents.map<ProjectChildItem>((agent) => ({
			type: "agent",
			key: `agent:${agent.id}`,
			agent,
			sortAt: agent.createdAt,
		})),
		...[...agentBySessionKey.entries()].map<ProjectChildItem>(
			([sessionKey, agent]) => ({
				type: "agent",
				key: `session-agent:${sessionKey}`,
				agent,
				sortAt: getAgentSortAt(agent, sessionByKey),
			}),
		),
		...[...sessionByKey.entries()]
			.filter(([sessionKey]) => !agentBySessionKey.has(sessionKey))
			.map<ProjectChildItem>(([sessionKey, session]) => ({
				type: "session",
				key: `session:${sessionKey}`,
				session,
				sortAt: session.updatedAt,
			})),
		...unkeyedSessions.map<ProjectChildItem>((session) => ({
			type: "session",
			key: `session-file:${session.filePath}`,
			session,
			sortAt: session.updatedAt,
		})),
	].sort((left, right) => right.sortAt - left.sortAt);

	const limit = visibleChildCount ?? DEFAULT_VISIBLE_PROJECT_CHILD_LIMIT;
	const visibleChildren = children.slice(0, limit);
	return {
		children,
		visibleChildren,
		hiddenChildCount: Math.max(0, children.length - visibleChildren.length),
	};
}
