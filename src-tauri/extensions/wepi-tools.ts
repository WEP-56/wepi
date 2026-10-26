/**
 * WEPI Tools Extension
 *
 * 把 WEPI 桌面端工具桥（`WEPI_BRIDGE` 指向的回环 HTTP 端点）里的工具注册成
 * Pi 工具。工具实现在 Rust 侧，和面板共用同一份代码与坐标约定。
 *
 * 设计约束：
 * - 桥不在（用户单独用 pi、或 WEPI 版本较旧）时静默不注册，不报错、不阻塞启动。
 * - 自包含：只依赖 pi 的类型与 node 内置能力，不 import WEPI 源码。
 * - `WEPI_BRIDGE` 在读取后立刻删除：否则 bash 工具跑的子进程会继承到 bearer token。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Bridge = { url: string; token: string };
type BridgeTool = { name: string; description: string; inputSchema: Record<string, unknown> };
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export default async function (pi: ExtensionAPI) {
	const raw = process.env.WEPI_BRIDGE;
	if (!raw) return;
	delete process.env.WEPI_BRIDGE;

	let config: Bridge;
	try {
		config = JSON.parse(raw) as Bridge;
	} catch {
		return;
	}
	if (!config || typeof config.url !== "string" || typeof config.token !== "string") return;

	const request = async (method: string, params: unknown, signal?: AbortSignal): Promise<any> => {
		const response = await fetch(config.url, {
			method: "POST",
			signal,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		if (!response.ok) throw new Error(`WEPI 工具桥返回 ${response.status}`);
		const payload = await response.json();
		if (payload?.error) throw new Error(payload.error.message ?? "WEPI 工具桥错误");
		return payload?.result;
	};

	let tools: BridgeTool[] = [];
	try {
		const listed = await request("tools/list", {});
		tools = Array.isArray(listed?.tools) ? listed.tools : [];
	} catch {
		// 桥还没起来：这一轮没有桌面工具，Pi 照常工作。
		return;
	}

	for (const tool of tools) {
		if (!tool?.name || !tool.inputSchema) continue;
		pi.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
			async execute(_id: string, args: unknown, signal?: AbortSignal) {
				// cwd 用于解析 show 这类「相对会话工作目录」的产物路径；
				// 工具块参数仍只保留模型原始参数，不会多出这个字段。
				const result = await request("tools/call", { name: tool.name, arguments: args ?? {}, cwd: process.cwd() }, signal);
				const content = Array.isArray(result?.content) ? (result.content as Content[]) : [];
				if (result?.isError) {
					const text = content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
					throw new Error(text || "工具执行失败");
				}
				// details 是否落盘取决于 Pi 版本；前端卡片只从参数重建，
				// 这里转发是给未来需要结构化结果的工具留的口子。
				return { content, details: result?.details };
			},
		});
	}
}
