import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { resolveCursorMcpToolTimeoutMs } from "./cursor-mcp-timeout-override.js";

export const CURSOR_PI_TOOL_BRIDGE_ENV = "PI_CURSOR_PI_TOOL_BRIDGE";
export const CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV = "PI_CURSOR_EXPOSE_BUILTIN_TOOLS";
export const CURSOR_PI_TOOL_BRIDGE_CALL_TIMEOUT_MS_ENV = "PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS";
export const CURSOR_PI_TOOL_TRANSPORT_ENV = "PI_CURSOR_PI_TOOL_TRANSPORT";

/**
 * Bridge transport for exposing pi tools to the Cursor agent:
 * - "mcp": loopback HTTP MCP server the SDK connects out to (default).
 * - "custom-tools": in-process `local.customTools`, no outbound server, so it
 *   survives environments that block external MCP server connections.
 */
export type CursorPiToolBridgeTransport = "mcp" | "custom-tools";
export const CURSOR_PI_TOOL_BRIDGE_TRANSPORTS: readonly CursorPiToolBridgeTransport[] = ["mcp", "custom-tools"];

export function resolveCursorPiToolBridgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_PI_TOOL_BRIDGE_ENV], true);
}

export function resolveCursorPiToolBridgeBuiltinsEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV], false);
}

export function resolveCursorPiToolBridgeCallTimeoutMs(env: Record<string, string | undefined> = process.env): number {
	const mcpToolTimeoutMs = resolveCursorMcpToolTimeoutMs(env);
	const parsed = Number(env[CURSOR_PI_TOOL_BRIDGE_CALL_TIMEOUT_MS_ENV]?.trim());
	if (!Number.isFinite(parsed) || parsed <= 0) return mcpToolTimeoutMs;
	return Math.min(Math.max(Math.trunc(parsed), 1), mcpToolTimeoutMs);
}

/**
 * Resolves the bridge transport. Absence (or empty string) defaults to "mcp";
 * an explicit unrecognized value throws rather than silently falling back, so
 * a misconfigured deployment fails loudly instead of quietly using MCP.
 */
export function resolveCursorPiToolBridgeTransport(
	env: Record<string, string | undefined> = process.env,
): CursorPiToolBridgeTransport {
	const raw = env[CURSOR_PI_TOOL_TRANSPORT_ENV]?.trim();
	if (raw === undefined || raw === "") return "mcp";
	if ((CURSOR_PI_TOOL_BRIDGE_TRANSPORTS as readonly string[]).includes(raw)) {
		return raw as CursorPiToolBridgeTransport;
	}
	throw new Error(
		`Invalid ${CURSOR_PI_TOOL_TRANSPORT_ENV}: ${JSON.stringify(raw)} (expected "mcp" or "custom-tools")`,
	);
}
