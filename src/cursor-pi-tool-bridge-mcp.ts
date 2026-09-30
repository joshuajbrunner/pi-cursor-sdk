import { createHash } from "node:crypto";
import type { SDKCustomTool, SDKCustomToolContent, SDKCustomToolContext, SDKCustomToolResult, SDKJsonValue } from "@cursor/sdk";
import type { Context, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { buildCursorPiBridgeMcpToolDescription, CURSOR_PI_BRIDGE_MCP_TOOL_PREFIX } from "./cursor-bridge-contract.js";
import type { CursorPiBridgeToolDefinition, CursorPiMcpInputSchema, CursorPiToolBridgeSnapshot } from "./cursor-pi-tool-bridge-types.js";
import { asRecord, stringifyUnknown } from "./cursor-record-utils.js";

export function normalizeMcpInputSchema(schema: unknown): CursorPiMcpInputSchema {
	const record = asRecord(schema);
	if (record?.type === "object") return record as CursorPiMcpInputSchema;
	return { type: "object", properties: {} };
}

export function normalizeMcpArgs(args: unknown): Record<string, unknown> {
	const record = asRecord(args);
	return record ? { ...record } : {};
}

export function waitForProtocolFlush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function sanitizeMcpToolNameStem(toolName: string): string {
	const stem = toolName
		.trim()
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return stem || "tool";
}

export function stableNameHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function createMcpToolName(piToolName: string, usedMcpToolNames: Set<string>): string {
	const baseName = `${CURSOR_PI_BRIDGE_MCP_TOOL_PREFIX}${sanitizeMcpToolNameStem(piToolName)}`;
	if (!usedMcpToolNames.has(baseName)) {
		usedMcpToolNames.add(baseName);
		return baseName;
	}

	const hashedName = `${baseName}__${stableNameHash(piToolName)}`;
	if (!usedMcpToolNames.has(hashedName)) {
		usedMcpToolNames.add(hashedName);
		return hashedName;
	}

	let counter = 2;
	let candidate = `${hashedName}_${counter}`;
	while (usedMcpToolNames.has(candidate)) {
		counter += 1;
		candidate = `${hashedName}_${counter}`;
	}
	usedMcpToolNames.add(candidate);
	return candidate;
}

export function snapshotToolToMcpTool(tool: CursorPiBridgeToolDefinition): Tool {
	return {
		name: tool.mcpToolName,
		description: buildCursorPiBridgeMcpToolDescription({
			piToolName: tool.piToolName,
			mcpToolName: tool.mcpToolName,
			piToolDescription: tool.description,
			piToolPromptGuidelines: tool.promptGuidelines,
		}),
		inputSchema: tool.inputSchema,
		_meta: { piToolName: tool.piToolName },
	};
}

/**
 * Invokes a bridge tool by its MCP tool name and resolves to the same
 * `CallToolResult` the HTTP-MCP transport produces. In custom-tools mode the
 * bridge run supplies its own `enqueueToolRequest` here, so both transports
 * share one dispatch path.
 */
export type CursorPiBridgeCustomToolInvoker = (
	mcpToolName: string,
	args: Record<string, unknown>,
	context: SDKCustomToolContext,
) => Promise<CallToolResult>;

/** Reinterprets the normalized MCP JSON Schema as the SDK JSON-valued schema. */
function toCustomToolInputSchema(schema: CursorPiMcpInputSchema): Record<string, SDKJsonValue> {
	return schema as Record<string, SDKJsonValue>;
}

/**
 * Builds `local.customTools` using the existing MCP tool names (`pi__*`) so
 * both transports share tool recognition and dispatch.
 */
export function snapshotToCustomTools(
	snapshot: CursorPiToolBridgeSnapshot,
	invoke: CursorPiBridgeCustomToolInvoker,
): Record<string, SDKCustomTool> {
	const customTools: Record<string, SDKCustomTool> = {};
	for (const tool of snapshot.tools) {
		const mcpToolName = tool.mcpToolName;
		customTools[mcpToolName] = {
			description: buildCursorPiBridgeMcpToolDescription({
				piToolName: tool.piToolName,
				mcpToolName,
				piToolDescription: tool.description,
				piToolPromptGuidelines: tool.promptGuidelines,
			}),
			inputSchema: toCustomToolInputSchema(tool.inputSchema),
			execute: async (args, context) =>
				convertMcpResultToCustomToolResult(await invoke(mcpToolName, args, context)),
		};
	}
	return customTools;
}

/**
 * Converts a bridge `CallToolResult` into the SDK custom-tool result shape.
 * MCP text/image blocks map directly; anything else is stringified to text.
 * An empty result collapses to a single empty text block so the model always
 * receives well-formed content. A valid `structuredContent` object is carried
 * through so structured tool output survives the custom-tools transport.
 */
export function convertMcpResultToCustomToolResult(result: CallToolResult): SDKCustomToolResult {
	const content: SDKCustomToolContent[] = [];
	for (const block of result.content ?? []) {
		const record = asRecord(block);
		if (record?.type === "text" && typeof record.text === "string") {
			content.push({ type: "text", text: record.text });
			continue;
		}
		if (record?.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
			content.push({ type: "image", data: record.data, mimeType: record.mimeType });
			continue;
		}
		content.push({ type: "text", text: stringifyUnknown(block) });
	}
	const structuredContent = asRecord(result.structuredContent);
	return {
		content: content.length > 0 ? content : [{ type: "text", text: "" }],
		...(result.isError ? { isError: true } : {}),
		...(structuredContent ? { structuredContent: structuredContent as Record<string, SDKJsonValue> } : {}),
	};
}

export function convertPiContentToMcpContent(content: unknown): CallToolResult["content"] {
	if (!Array.isArray(content)) {
		return [{ type: "text", text: stringifyUnknown(content) }];
	}

	const mcpContent: CallToolResult["content"] = [];
	for (const block of content) {
		const record = asRecord(block);
		if (record?.type === "text" && typeof record.text === "string") {
			mcpContent.push({ type: "text", text: record.text });
			continue;
		}
		if (record?.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
			mcpContent.push({ type: "image", data: record.data, mimeType: record.mimeType });
			continue;
		}
		mcpContent.push({ type: "text", text: stringifyUnknown(block) });
	}

	return mcpContent.length > 0 ? mcpContent : [{ type: "text", text: "" }];
}

export function asToolResultMessage(value: Context["messages"][number]): ToolResultMessage | undefined {
	return value.role === "toolResult" ? value : undefined;
}

export function containsKnownMcpToolName(value: unknown, knownMcpToolNames: ReadonlySet<string>, depth = 0): boolean {
	if (depth > 4) return false;
	if (Array.isArray(value)) return value.some((entry) => containsKnownMcpToolName(entry, knownMcpToolNames, depth + 1));
	const record = asRecord(value);
	if (!record) return false;

	for (const field of ["tool", "toolName", "name", "mcpToolName", "serverToolName"]) {
		const fieldValue = record[field];
		if (typeof fieldValue === "string" && knownMcpToolNames.has(fieldValue)) return true;
	}

	for (const nestedField of ["args", "arguments", "input"]) {
		if (containsKnownMcpToolName(record[nestedField], knownMcpToolNames, depth + 1)) return true;
	}

	return false;
}
