import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKCustomToolContent } from "@cursor/sdk";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { createBridgePiHarness, createTestToolInfo } from "./helpers/pi-harness.js";
import {
	__testUtils,
	buildCursorPiToolBridgeSnapshot,
	resolveCursorPiToolBridgeTransport,
	type CursorPiToolBridgeRun,
} from "../src/cursor-pi-tool-bridge.js";
import { convertMcpResultToCustomToolResult, snapshotToCustomTools } from "../src/cursor-pi-tool-bridge-mcp.js";

function createToolInfo(name: string, description = `${name} description`, parameters: TSchema = Type.Object({})): ToolInfo {
	return createTestToolInfo(name, parameters, description);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQueuedRequests(run: CursorPiToolBridgeRun) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const requests = run.takeQueuedToolRequests();
		if (requests.length > 0) return requests;
		await sleep(10);
	}
	throw new Error("Timed out waiting for queued bridge request");
}

describe("resolveCursorPiToolBridgeTransport", () => {
	it("defaults to mcp when unset or blank", () => {
		expect(resolveCursorPiToolBridgeTransport({})).toBe("mcp");
		expect(resolveCursorPiToolBridgeTransport({ PI_CURSOR_PI_TOOL_TRANSPORT: "" })).toBe("mcp");
		expect(resolveCursorPiToolBridgeTransport({ PI_CURSOR_PI_TOOL_TRANSPORT: "  " })).toBe("mcp");
	});

	it("accepts the two explicit transports", () => {
		expect(resolveCursorPiToolBridgeTransport({ PI_CURSOR_PI_TOOL_TRANSPORT: "mcp" })).toBe("mcp");
		expect(resolveCursorPiToolBridgeTransport({ PI_CURSOR_PI_TOOL_TRANSPORT: "custom-tools" })).toBe("custom-tools");
	});

	it("throws on an unrecognized explicit value instead of falling back", () => {
		expect(() => resolveCursorPiToolBridgeTransport({ PI_CURSOR_PI_TOOL_TRANSPORT: "grpc" })).toThrow(
			/Invalid PI_CURSOR_PI_TOOL_TRANSPORT.*expected "mcp" or "custom-tools"/,
		);
	});
});

describe("convertMcpResultToCustomToolResult", () => {
	it("maps text blocks through unchanged", () => {
		const result = convertMcpResultToCustomToolResult({ content: [{ type: "text", text: "hello" }] } as CallToolResult);
		expect(result).toEqual({ content: [{ type: "text", text: "hello" }] });
	});

	it("maps image blocks through with data and mimeType", () => {
		const result = convertMcpResultToCustomToolResult({
			content: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
		} as CallToolResult);
		expect(result).toEqual({ content: [{ type: "image", data: "BASE64", mimeType: "image/png" }] });
	});

	it("stringifies unknown block types to text", () => {
		const result = convertMcpResultToCustomToolResult({
			content: [{ type: "resource", resource: { uri: "file://x", text: "data" } }],
		} as unknown as CallToolResult) as { content: SDKCustomToolContent[] };
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain("resource");
	});

	it("collapses empty content to a single empty text block", () => {
		const result = convertMcpResultToCustomToolResult({ content: [] } as CallToolResult);
		expect(result).toEqual({ content: [{ type: "text", text: "" }] });
	});

	it("preserves isError", () => {
		const result = convertMcpResultToCustomToolResult({
			content: [{ type: "text", text: "boom" }],
			isError: true,
		} as CallToolResult);
		expect(result).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
	});

	it("carries a valid structuredContent object through", () => {
		const result = convertMcpResultToCustomToolResult({
			content: [{ type: "text", text: "ok" }],
			structuredContent: { rows: 3, ok: true },
		} as CallToolResult);
		expect(result).toEqual({
			content: [{ type: "text", text: "ok" }],
			structuredContent: { rows: 3, ok: true },
		});
	});
});

describe("snapshotToCustomTools", () => {
	it("keys tools by mcpToolName and funnels execute through the invoker", async () => {
		const pi = createBridgePiHarness({
			active: ["read"],
			tools: [createToolInfo("read", "Read files", Type.Object({ path: Type.String() }))],
		});
		const snapshot = buildCursorPiToolBridgeSnapshot(pi, { exposeOverlappingBuiltins: true });
		const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }) as CallToolResult);
		const customTools = snapshotToCustomTools(snapshot, invoke);

		expect(Object.keys(customTools)).toEqual(snapshot.tools.map((tool) => tool.mcpToolName));
		const mcpToolName = snapshot.tools[0].mcpToolName;
		const result = await customTools[mcpToolName].execute({ path: "a.txt" }, { toolCallId: "c1" });

		expect(invoke).toHaveBeenCalledWith(mcpToolName, { path: "a.txt" }, { toolCallId: "c1" });
		expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
	});
});

describe("custom-tools transport run", () => {
	afterEach(async () => {
		await __testUtils.resetRegisteredBridgeForTests();
	});

	it("exposes customTools, sets no mcpServers, and never starts the loopback HTTP server", async () => {
		const registry = __testUtils.createRegistry(
			createBridgePiHarness({
				active: ["read"],
				tools: [createToolInfo("read", "Read files", Type.Object({ path: Type.String() }))],
			}),
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1", PI_CURSOR_PI_TOOL_TRANSPORT: "custom-tools" },
		);
		const registerRunSpy = vi.spyOn(registry, "registerRun");
		const run = await registry.createRun();
		try {
			expect(run.transport).toBe("custom-tools");
			expect(run.enabled).toBe(true);
			expect(run.mcpServers).toBeUndefined();
			expect(run.customTools).toBeDefined();
			expect(Object.keys(run.customTools!)).toEqual(run.snapshot.tools.map((tool) => tool.mcpToolName));
			expect(registerRunSpy).not.toHaveBeenCalled();
		} finally {
			await run.dispose();
		}
	});

	it("round-trips execute() through the shared dispatch with the SDK toolCallId as cursorMcpCallId", async () => {
		const registry = __testUtils.createRegistry(
			createBridgePiHarness({
				active: ["read"],
				tools: [createToolInfo("read", "Read files", Type.Object({ path: Type.String() }))],
			}),
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1", PI_CURSOR_PI_TOOL_TRANSPORT: "custom-tools" },
		);
		const run = await registry.createRun();
		try {
			const mcpToolName = run.snapshot.tools[0].mcpToolName;
			const executePromise = run.customTools![mcpToolName].execute({ path: "current.txt" }, { toolCallId: "sdk-call-1" });

			const [request] = await waitForQueuedRequests(run);
			expect(request.mcpToolName).toBe(mcpToolName);
			expect(request.cursorMcpCallId).toBe("sdk-call-1");
			expect(request.piToolCallId).toContain(run.id);

			const toolResults: ToolResultMessage[] = [
				{
					role: "toolResult",
					toolCallId: request.piToolCallId,
					toolName: "read",
					content: [{ type: "text", text: "current result" }],
					isError: false,
					timestamp: 1,
				},
			];
			await run.resolveToolResults(toolResults);

			await expect(executePromise).resolves.toEqual({ content: [{ type: "text", text: "current result" }] });
		} finally {
			await run.dispose();
		}
	});

	it("falls back to a synthetic cursorMcpCallId when the SDK provides no toolCallId", async () => {
		const registry = __testUtils.createRegistry(
			createBridgePiHarness({
				active: ["read"],
				tools: [createToolInfo("read", "Read files", Type.Object({ path: Type.String() }))],
			}),
			{ PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1", PI_CURSOR_PI_TOOL_TRANSPORT: "custom-tools" },
		);
		const run = await registry.createRun();
		try {
			const mcpToolName = run.snapshot.tools[0].mcpToolName;
			const executePromise = run.customTools![mcpToolName].execute({ path: "current.txt" }, {});
			const [request] = await waitForQueuedRequests(run);
			expect(request.cursorMcpCallId).toMatch(/^custom-[0-9a-f-]{36}$/);
			await run.resolveToolResults([
				{
					role: "toolResult",
					toolCallId: request.piToolCallId,
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 1,
				},
			]);
			await expect(executePromise).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
		} finally {
			await run.dispose();
		}
	});
});
