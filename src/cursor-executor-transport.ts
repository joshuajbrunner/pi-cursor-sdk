import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CursorPiToolBridgeSnapshot } from "./cursor-pi-tool-bridge-types.js";

export const CURSOR_PI_TOOL_TRANSPORT_ENV = "PI_CURSOR_PI_TOOL_TRANSPORT";
export const CURSOR_EXECUTOR_DESCRIPTOR_DIR_ENV = "PI_CURSOR_EXECUTOR_DESCRIPTOR_DIR";
export const CURSOR_EXECUTOR_INTEGRATION_SLUG_ENV = "PI_CURSOR_EXECUTOR_INTEGRATION_SLUG";

export type CursorPiToolTransport = "mcp" | "executor";

export interface CursorExecutorBridgeDescriptor {
	version: 1;
	transport: "executor";
	pid: number;
	pidStartedAt: string;
	runId: string;
	createdAt: string;
	endpointUrl: string;
	mcpServerName: "pi_tools";
	integrationSlug: string;
	tools: Array<{ piToolName: string; mcpToolName: string }>;
}

const ownedDescriptorPaths = new Set<string>();
let exitCleanupInstalled = false;

export function resolveCursorPiToolTransport(
	env: Record<string, string | undefined> = process.env,
): CursorPiToolTransport {
	return env[CURSOR_PI_TOOL_TRANSPORT_ENV]?.trim().toLowerCase() === "executor" ? "executor" : "mcp";
}

export function resolveCursorExecutorDescriptorDirectory(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const value = env[CURSOR_EXECUTOR_DESCRIPTOR_DIR_ENV]?.trim();
	return value || undefined;
}

export function resolveCursorExecutorIntegrationSlug(
	env: Record<string, string | undefined> = process.env,
): string {
	return env[CURSOR_EXECUTOR_INTEGRATION_SLUG_ENV]?.trim() || "pi";
}

export function getCurrentCursorExecutorDescriptorPath(): string | undefined {
	return [...ownedDescriptorPaths].at(-1);
}

export function cleanupOwnedCursorExecutorDescriptorsSync(): void {
	for (const path of ownedDescriptorPaths) {
		try {
			unlinkSync(path);
		} catch {
			// Signal and process-exit cleanup are best effort.
		}
	}
	ownedDescriptorPaths.clear();
}

function installExitCleanup(): void {
	if (exitCleanupInstalled) return;
	exitCleanupInstalled = true;
	process.once("exit", cleanupOwnedCursorExecutorDescriptorsSync);
}

async function isCursorExecutorDescriptorEndpointLive(endpointUrl: string): Promise<boolean | undefined> {
	let response: Response;
	try {
		response = await fetch(endpointUrl, { method: "GET", signal: AbortSignal.timeout(500) });
	} catch (error) {
		const causeCode = error && typeof error === "object" && "cause" in error
			&& error.cause && typeof error.cause === "object" && "code" in error.cause
			? error.cause.code
			: undefined;
		return causeCode === "ECONNREFUSED" ? false : undefined;
	}
	if (response.status !== 400) return false;
	try {
		const body = await response.json() as { error?: { code?: number } };
		return body.error?.code === -32000;
	} catch {
		return undefined;
	}
}

async function sweepStaleCursorExecutorDescriptors(directory: string): Promise<void> {
	const names = await readdir(directory).catch(() => [] as string[]);
	const currentPidStartedAt = Date.now() - process.uptime() * 1_000;
	await Promise.all(names
		.filter((name) => name.startsWith("executor-bridge-") && name.endsWith(".json"))
		.map(async (name) => {
			const path = join(directory, name);
			if (ownedDescriptorPaths.has(path)) return;
			let descriptor: { pid?: number; pidStartedAt?: string; endpointUrl?: string };
			try {
				descriptor = JSON.parse(await readFile(path, "utf8")) as typeof descriptor;
			} catch {
				return;
			}
			const pid = descriptor.pid;
			if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return;
			let alive = true;
			try {
				process.kill(pid!, 0);
			} catch (error) {
				alive = !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
			}
			if (pid === process.pid && descriptor.pidStartedAt) {
				const recordedStart = Date.parse(descriptor.pidStartedAt);
				if (Number.isFinite(recordedStart) && Math.abs(recordedStart - currentPidStartedAt) > 2_000) alive = false;
			} else if (alive && typeof descriptor.endpointUrl === "string") {
				const endpointLive = await isCursorExecutorDescriptorEndpointLive(descriptor.endpointUrl);
				if (endpointLive === false) alive = false;
			}
			if (!alive) await unlink(path).catch(() => undefined);
		}));
}

export async function writeCursorExecutorBridgeDescriptor(options: {
	directory: string;
	runId: string;
	endpointUrl: string;
	integrationSlug: string;
	snapshot: CursorPiToolBridgeSnapshot;
}): Promise<string> {
	const descriptor: CursorExecutorBridgeDescriptor = {
		version: 1,
		transport: "executor",
		pid: process.pid,
		pidStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
		runId: options.runId,
		createdAt: new Date().toISOString(),
		endpointUrl: options.endpointUrl,
		mcpServerName: "pi_tools",
		integrationSlug: options.integrationSlug,
		tools: options.snapshot.tools.map(({ piToolName, mcpToolName }) => ({ piToolName, mcpToolName })),
	};
	await mkdir(options.directory, { recursive: true, mode: 0o700 });
	const directoryMode = (await stat(options.directory)).mode & 0o777;
	if ((directoryMode & 0o077) !== 0) {
		throw new Error(`Executor descriptor directory ${options.directory} has mode ${directoryMode.toString(8)}; group and other access must be disabled`);
	}
	await sweepStaleCursorExecutorDescriptors(options.directory);
	const path = join(options.directory, `executor-bridge-${process.pid}-${options.runId}.json`);
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	const handle = await open(temporaryPath, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporaryPath, path);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
	ownedDescriptorPaths.add(path);
	installExitCleanup();
	return path;
}

export async function removeCursorExecutorBridgeDescriptor(path: string): Promise<void> {
	await unlink(path).catch((error: unknown) => {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		if (code !== "ENOENT") throw error;
	});
	ownedDescriptorPaths.delete(path);
}
