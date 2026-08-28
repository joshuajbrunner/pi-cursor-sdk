import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CURSOR_EXECUTOR_DESCRIPTOR_DIR_ENV,
	CURSOR_EXECUTOR_INTEGRATION_SLUG_ENV,
	CURSOR_PI_TOOL_TRANSPORT_ENV,
	cleanupOwnedCursorExecutorDescriptorsSync,
	removeCursorExecutorBridgeDescriptor,
	resolveCursorExecutorDescriptorDirectory,
	resolveCursorExecutorIntegrationSlug,
	resolveCursorPiToolTransport,
	writeCursorExecutorBridgeDescriptor,
} from "../src/cursor-executor-transport.js";

const snapshot = {
	tools: [
		{
			piToolName: "intercom",
			mcpToolName: "pi__intercom",
			description: "Message another pi session",
			inputSchema: { type: "object" as const },
			sourceInfo: { source: "extension", path: "test", scope: "temporary" as const, origin: "top-level" as const },
		},
	],
	mcpToolNameToPiToolName: new Map([["pi__intercom", "intercom"]]),
	piToolNameToMcpToolName: new Map([["intercom", "pi__intercom"]]),
};

describe("cursor Executor transport", () => {
	it("defaults safely to Cursor MCP and resolves explicit Executor settings", () => {
		expect(resolveCursorPiToolTransport({})).toBe("mcp");
		expect(resolveCursorPiToolTransport({ [CURSOR_PI_TOOL_TRANSPORT_ENV]: "unexpected" })).toBe("mcp");
		expect(resolveCursorPiToolTransport({ [CURSOR_PI_TOOL_TRANSPORT_ENV]: " EXECUTOR " })).toBe("executor");
		expect(resolveCursorExecutorDescriptorDirectory({})).toBeUndefined();
		expect(resolveCursorExecutorDescriptorDirectory({ [CURSOR_EXECUTOR_DESCRIPTOR_DIR_ENV]: " /tmp/bridges " })).toBe("/tmp/bridges");
		expect(resolveCursorExecutorIntegrationSlug({})).toBe("pi");
		expect(resolveCursorExecutorIntegrationSlug({ [CURSOR_EXECUTOR_INTEGRATION_SLUG_ENV]: " workspace-pi " })).toBe("workspace-pi");
	});

	it("rejects an existing descriptor directory accessible by group or others", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-executor-mode-test-"));
		const directory = join(root, "shared");
		try {
			await mkdir(directory, { mode: 0o755 });
			await expect(writeCursorExecutorBridgeDescriptor({
				directory,
				runId: "run-shared",
				endpointUrl: "http://127.0.0.1:43210/cursor-pi-tool-bridge/token/mcp",
				integrationSlug: "pi",
				snapshot,
			})).rejects.toThrow(`Executor descriptor directory ${directory} has mode 755`);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reaps dead-process descriptors and cleans owned descriptors synchronously", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-executor-sweep-test-"));
		const directory = join(root, "private");
		const stalePath = join(directory, "executor-bridge-999999-stale.json");
		try {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await writeFile(stalePath, JSON.stringify({ pid: 999999, pidStartedAt: "2000-01-01T00:00:00.000Z" }));
			const ownedPath = await writeCursorExecutorBridgeDescriptor({
				directory,
				runId: "run-owned",
				endpointUrl: "http://127.0.0.1:43210/cursor-pi-tool-bridge/token/mcp",
				integrationSlug: "pi",
				snapshot,
			});
			await expect(stat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
			cleanupOwnedCursorExecutorDescriptorsSync();
			await expect(stat(ownedPath)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("atomically writes private run-scoped descriptors and removes only the requested file", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cursor-executor-test-"));
		const directory = join(root, "private");
		try {
			const firstPath = await writeCursorExecutorBridgeDescriptor({
				directory,
				runId: "run-a",
				endpointUrl: "http://127.0.0.1:43210/cursor-pi-tool-bridge/token/mcp",
				integrationSlug: "pi",
				snapshot,
			});
			const secondPath = await writeCursorExecutorBridgeDescriptor({
				directory,
				runId: "run-b",
				endpointUrl: "http://127.0.0.1:43211/cursor-pi-tool-bridge/other/mcp",
				integrationSlug: "pi",
				snapshot,
			});

			expect(firstPath).not.toBe(secondPath);
			const descriptor = JSON.parse(await readFile(firstPath, "utf8")) as Record<string, unknown>;
			expect(descriptor).toMatchObject({
				version: 1,
				transport: "executor",
				pid: process.pid,
				runId: "run-a",
				mcpServerName: "pi_tools",
				integrationSlug: "pi",
				tools: [{ piToolName: "intercom", mcpToolName: "pi__intercom" }],
			});
			expect(descriptor.pidStartedAt).toEqual(expect.any(String));
			expect((await stat(firstPath)).mode & 0o777).toBe(0o600);
			expect((await stat(directory)).mode & 0o777).toBe(0o700);

			await removeCursorExecutorBridgeDescriptor(firstPath);
			await expect(stat(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
			expect(JSON.parse(await readFile(secondPath, "utf8"))).toMatchObject({ runId: "run-b" });
			await removeCursorExecutorBridgeDescriptor(secondPath);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
