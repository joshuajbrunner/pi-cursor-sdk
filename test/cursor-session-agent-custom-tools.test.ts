import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { createBridgePiHarness, createTestToolInfo } from "./helpers/pi-harness.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { acquireSessionCursorAgent, __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as bridgeTestUtils, registerCursorPiToolBridge } from "../src/cursor-pi-tool-bridge.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";

function createToolInfo(name: string, description = `${name} description`, parameters: TSchema = Type.Object({})): ToolInfo {
	return createTestToolInfo(name, parameters, description);
}

describe("cursor-session-agent custom-tools plumbing", () => {
	beforeEach(async () => {
		installCursorSessionStoreMock();
		cursorSessionScopeTestUtils.reset();
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
		vi.clearAllMocks();
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		process.env.PI_CURSOR_PI_TOOL_TRANSPORT = "custom-tools";
	});

	afterEach(async () => {
		await bridgeTestUtils.resetRegisteredBridgeForTests();
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
		delete process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS;
		delete process.env.PI_CURSOR_PI_TOOL_TRANSPORT;
	});

	it("passes bridge tools to Agent.create as local.customTools and omits bridge mcpServers", async () => {
		registerCursorPiToolBridge(
			createBridgePiHarness({
				active: ["read"],
				tools: [createToolInfo("read", "Read files", Type.Object({ path: Type.String() }))],
			}),
		);
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-custom-tools",
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/custom-tools.jsonl");

		const lease = await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		});

		// The bridge run selected the custom-tools transport.
		expect(lease.bridgeRun?.transport).toBe("custom-tools");
		expect(lease.bridgeRun?.customTools).toBeDefined();

		// buildAgentOptions() is shared by both Agent.create and Agent.resume, so
		// this create-path assertion covers the resume seam too.
		const options = createAgent.mock.calls[0][0];
		expect(options.local?.customTools).toBeDefined();
		expect(Object.keys(options.local.customTools)).toEqual(
			lease.bridgeRun!.snapshot.tools.map((tool) => tool.mcpToolName),
		);
		expect(Object.keys(options.local.customTools)).toContain("pi__read");

		// No loopback MCP server is injected by the bridge in custom-tools mode.
		expect(options.mcpServers).toBeUndefined();
	});
});
