import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServerConfig } from "@cursor/sdk";
import type { Context, ToolResultMessage } from "@earendil-works/pi-ai";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	isInitializeRequest,
	type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { bridgeToolExecutionAbortTracker } from "./cursor-pi-tool-bridge-abort.js";
import { MCP_ENDPOINT_ROOT, MCP_SERVER_NAME } from "./cursor-pi-tool-bridge-constants.js";
import {
	type CursorPiToolBridgeDiagnosticEvent,
	type CursorPiToolBridgeLifecycleDiagnosticFields,
	type CursorPiToolBridgeRejectionKind,
	type CursorPiToolBridgeRequestDiagnosticFields,
	writeCursorPiToolBridgeDiagnostic,
} from "./cursor-pi-tool-bridge-diagnostics.js";
import { resolveCursorPiToolBridgeCallTimeoutMs } from "./cursor-pi-tool-bridge-env.js";
import {
	removeCursorExecutorBridgeDescriptor,
	type CursorExecutorTransportSettings,
	writeCursorExecutorBridgeDescriptor,
} from "./cursor-executor-transport.js";
import type {
	CursorPiBridgeToolRequest,
	CursorPiToolBridgeRun,
	CursorPiToolBridgeRunOptions,
	CursorPiToolBridgeSnapshot,
} from "./cursor-pi-tool-bridge-types.js";
import {
	asToolResultMessage,
	containsKnownMcpToolName,
	convertPiContentToMcpContent,
	normalizeMcpArgs,
	snapshotToolToMcpTool,
	waitForProtocolFlush,
} from "./cursor-pi-tool-bridge-mcp.js";
import { asRecord, getFirstStringByKeys } from "./cursor-record-utils.js";

export interface CursorPiToolBridgeRunHost {
	registerRun(pathname: string, run: CursorPiToolBridgeRunImpl): Promise<string>;
	unregisterRun(pathname: string, run: CursorPiToolBridgeRunImpl): Promise<void>;
}

const MCP_SERVER_VERSION = "0.1.0";

interface McpProtocolSession {
	server: McpProtocolServer;
	transport: StreamableHTTPServerTransport;
	activeRequestCount: number;
}

const EXECUTOR_MCP_MAX_SESSIONS = 8;
const EXECUTOR_MCP_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

class McpSessionLimitError extends Error {}

class McpRequestBodyError extends Error {
	constructor(
		message: string,
		readonly jsonRpcCode: number,
	) {
		super(message);
	}
}

async function readJsonRequestBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > EXECUTOR_MCP_MAX_REQUEST_BYTES) {
			throw new McpRequestBodyError("Cursor pi tool bridge request body exceeds 16 MiB", -32000);
		}
		chunks.push(buffer);
	}
	if (chunks.length === 0) return undefined;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new McpRequestBodyError("Parse error", -32700);
	}
}

interface PendingBridgeCall {
	request: CursorPiBridgeToolRequest;
	resolve: (result: CallToolResult) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	timeout?: ReturnType<typeof setTimeout>;
	settled: boolean;
}

export class CursorPiToolBridgeRunImpl implements CursorPiToolBridgeRun {
	readonly id: string;
	readonly enabled: boolean;
	readonly snapshot: CursorPiToolBridgeSnapshot;
	readonly transport: CursorExecutorTransportSettings["transport"];
	mcpServers?: Record<string, McpServerConfig>;

	private readonly registry: CursorPiToolBridgeRunHost;
	private readonly env: Record<string, string | undefined>;
	private readonly endpointPath: string;
	private readonly callTimeoutMs: number;
	private readonly knownMcpToolNames: ReadonlySet<string>;
	private readonly executorSettings: CursorExecutorTransportSettings;
	private executorDescriptorPath?: string;
	private readonly knownCursorMcpCallIds = new Set<string>();
	private readonly queuedRequests: CursorPiBridgeToolRequest[] = [];
	private readonly pendingByPiToolCallId = new Map<string, PendingBridgeCall>();
	private readonly pendingByBridgeCallId = new Map<string, PendingBridgeCall>();
	private readonly pendingByCursorMcpCallId = new Map<string, PendingBridgeCall>();
	private onToolRequest?: (request: CursorPiBridgeToolRequest) => void;
	private debugRecorder: CursorPiToolBridgeRunOptions["debugRecorder"];
	private liveRunHandlerDetached = false;
	private readonly mcpSessions = new Map<string, McpProtocolSession>();
	private mcpServer?: McpProtocolServer;
	private mcpTransport?: StreamableHTTPServerTransport;
	private toolCallCounter = 0;
	private disposed = false;

	constructor(
		registry: CursorPiToolBridgeRunHost,
		env: Record<string, string | undefined>,
		executorSettings: CursorExecutorTransportSettings,
		snapshot: CursorPiToolBridgeSnapshot,
		enabled: boolean,
		options: CursorPiToolBridgeRunOptions = {},
	) {
		this.registry = registry;
		this.env = env;
		this.snapshot = snapshot;
		this.enabled = enabled;
		this.onToolRequest = options.onToolRequest;
		this.debugRecorder = options.debugRecorder;
		this.id = `cursor-pi-bridge-run-${randomUUID()}`;
		this.endpointPath = `${MCP_ENDPOINT_ROOT}/${randomUUID()}/mcp`;
		this.callTimeoutMs = resolveCursorPiToolBridgeCallTimeoutMs(env);
		this.knownMcpToolNames = new Set(snapshot.tools.map((tool) => tool.mcpToolName));
		this.executorSettings = executorSettings;
		this.transport = executorSettings.transport;
	}

	async start(): Promise<void> {
		if (!this.enabled) return;
		if (this.transport === "mcp") await this.createSingleClientMcpServer();
		const endpointUrl = await this.registry.registerRun(this.endpointPath, this);
		this.mcpServers = { [MCP_SERVER_NAME]: { type: "http", url: endpointUrl } };
		if (this.transport !== "executor") return;
		try {
			this.executorDescriptorPath = await writeCursorExecutorBridgeDescriptor({
				directory: this.executorSettings.descriptorDirectory,
				runId: this.id,
				endpointUrl,
				integrationSlug: this.executorSettings.integrationSlug,
				snapshot: this.snapshot,
			});
		} catch (error) {
			await this.dispose().catch(() => undefined);
			throw error;
		}
	}

	emitStartDiagnostics(bridgeEnabled: boolean): void {
		const base = this.lifecycleDiagnosticFields();
		this.emitDiagnostic({ event: "run_created", ...base });
		if (!this.enabled) {
			this.emitDiagnostic({
				event: "run_skipped",
				...base,
				reason: bridgeEnabled ? "no_exposed_tools" : "disabled",
			});
			return;
		}
		this.emitDiagnostic({
			event: "tools_exposed",
			...base,
			pairs: this.snapshot.tools.map((tool) => ({
				piToolName: tool.piToolName,
				mcpToolName: tool.mcpToolName,
			})),
		});
	}

	async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (this.disposed) {
			res.writeHead(410, { "content-type": "application/json" }).end(JSON.stringify({ error: "Cursor pi tool bridge run is disposed" }));
			return;
		}
		if (this.transport === "mcp") {
			if (!this.mcpTransport) throw new Error("Cursor pi tool bridge MCP transport is unavailable");
			await this.mcpTransport.handleRequest(req, res);
			return;
		}
		await this.handleReconnectableMcpRequest(req, res);
	}

	takeQueuedToolRequests(): CursorPiBridgeToolRequest[] {
		return this.queuedRequests.splice(0);
	}

	setOnToolRequest(handler?: (request: CursorPiBridgeToolRequest) => void): void {
		if (!handler) {
			this.liveRunHandlerDetached = true;
			this.rejectQueuedToolRequestsWithoutHandler("Cursor pi tool bridge has no active live run");
		} else {
			this.liveRunHandlerDetached = false;
		}
		this.onToolRequest = handler;
		if (handler) {
			for (const request of this.queuedRequests.splice(0)) {
				const pending = this.pendingByPiToolCallId.get(request.piToolCallId);
				if (pending) this.dispatchPendingToolRequest(pending, handler);
			}
		}
	}

	setDebugRecorder(recorder?: CursorPiToolBridgeRunOptions["debugRecorder"]): void {
		this.debugRecorder = recorder;
	}

	private recordBridgeRaw(
		payload: Parameters<NonNullable<CursorPiToolBridgeRunOptions["debugRecorder"]>["recordBridgeRaw"]>[0],
	): void {
		try {
			this.debugRecorder?.recordBridgeRaw(payload);
		} catch {
			// Debug capture must never block or strand a bridge call.
		}
	}

	async resolveToolResults(toolResults: readonly ToolResultMessage[]): Promise<void> {
		let resolvedCount = 0;
		for (const toolResult of toolResults) {
			const pending = this.pendingByPiToolCallId.get(toolResult.toolCallId);
			if (!pending || pending.settled) continue;
			this.resolvePending(pending, {
				content: convertPiContentToMcpContent(toolResult.content),
				isError: toolResult.isError || undefined,
			});
			resolvedCount += 1;
		}
		if (resolvedCount > 0) await waitForProtocolFlush();
	}

	async resolveToolResultsFromContext(context: Context): Promise<void> {
		await this.resolveToolResults(context.messages.map(asToolResultMessage).filter((message): message is ToolResultMessage => message !== undefined));
	}

	hasPendingPiToolCallId(piToolCallId: string): boolean {
		return this.pendingByPiToolCallId.has(piToolCallId);
	}

	cancelPendingPiToolCallId(piToolCallId: string, reason: string): boolean {
		const pending = this.pendingByPiToolCallId.get(piToolCallId);
		if (!pending) return false;
		this.rejectPending(pending, new Error(reason), "cancelled");
		return true;
	}

	isBridgeMcpToolCall(toolCall: unknown): boolean {
		const record = asRecord(toolCall);
		if (!record) return false;
		const toolName = getFirstStringByKeys(record, ["name", "toolName", "mcpToolName"], { nonEmpty: true });
		if (toolName && this.knownMcpToolNames.has(toolName)) return true;

		const isMcpEnvelope = toolName === "mcp" || toolName === MCP_SERVER_NAME;
		const cursorMcpCallId = getFirstStringByKeys(record, ["call_id", "callId", "id", "toolCallId", "requestId"], { nonEmpty: true });
		if (cursorMcpCallId && this.knownCursorMcpCallIds.has(cursorMcpCallId) && isMcpEnvelope) return true;

		if (containsKnownMcpToolName(toolCall, this.knownMcpToolNames)) return true;

		return false;
	}

	cancel(reason: string): void {
		const error = new Error(reason);
		const pendingCount = this.pendingCount();
		const queuedCount = this.queuedRequests.length;
		if (pendingCount > 0 || queuedCount > 0) {
			this.emitDiagnostic({
				event: "run_cancelled",
				...this.lifecycleDiagnosticFields(pendingCount),
				queuedCount,
				cancelledRequestCount: pendingCount,
			});
		}
		this.queuedRequests.splice(0);
		for (const pending of [...this.pendingByBridgeCallId.values()]) {
			this.rejectAndAbortPending(pending, error, "cancelled");
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.cancel("Cursor pi tool bridge run disposed");
		await waitForProtocolFlush();
		const sessions = [...this.mcpSessions.values()];
		this.mcpSessions.clear();
		await Promise.allSettled([
			this.mcpTransport?.close(),
			this.mcpServer?.close(),
			...sessions.flatMap(({ transport, server }) => [transport.close(), server.close()]),
		]);
		await this.registry.unregisterRun(this.endpointPath, this);
		if (this.executorDescriptorPath) {
			await removeCursorExecutorBridgeDescriptor(this.executorDescriptorPath).catch(() => undefined);
		}
		this.emitDiagnostic({
			event: "run_disposed",
			...this.lifecycleDiagnosticFields(),
		});
	}

	private async handleReconnectableMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		let body: unknown;
		try {
			body = req.method === "POST" ? await readJsonRequestBody(req) : undefined;
		} catch (error) {
			const requestError = error instanceof McpRequestBodyError ? error : new McpRequestBodyError("Parse error", -32700);
			res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: requestError.jsonRpcCode, message: requestError.message },
				id: null,
			}));
			return;
		}
		const header = req.headers["mcp-session-id"];
		const sessionId = Array.isArray(header) ? header[0] : header;
		let session = sessionId ? this.mcpSessions.get(sessionId) : undefined;
		if (session && sessionId) {
			this.mcpSessions.delete(sessionId);
			this.mcpSessions.set(sessionId, session);
		}
		if (!session && req.method === "POST" && isInitializeRequest(body)) {
			try {
				session = await this.createMcpSession();
			} catch (error) {
				if (!(error instanceof McpSessionLimitError)) throw error;
				res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32000, message: error.message },
					id: null,
				}));
				return;
			}
		} else if (!session) {
			res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32000, message: "Bad Request: No valid MCP session ID provided" },
				id: null,
			}));
			return;
		}
		session.activeRequestCount += 1;
		try {
			await session.transport.handleRequest(req, res, body);
		} finally {
			session.activeRequestCount -= 1;
		}
	}

	private createProtocolServer(): McpProtocolServer {
		const server = new McpProtocolServer(
			{ name: "pi-cursor-sdk-tool-bridge", version: MCP_SERVER_VERSION },
			{ capabilities: { tools: {} } },
		);
		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: this.snapshot.tools.map(snapshotToolToMcpTool),
		}));
		server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			return this.enqueueToolRequest(request.params.name, request.params.arguments, String(extra.requestId), extra.signal);
		});
		return server;
	}

	private async createSingleClientMcpServer(): Promise<void> {
		const server = this.createProtocolServer();
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
		this.mcpServer = server;
		this.mcpTransport = transport;
		await server.connect(transport);
	}

	private async createMcpSession(): Promise<McpProtocolSession> {
		if (this.mcpSessions.size >= EXECUTOR_MCP_MAX_SESSIONS) {
			if (this.pendingByPiToolCallId.size > 0) {
				throw new McpSessionLimitError("Cursor pi tool bridge MCP session limit reached while tool calls are pending");
			}
			const oldestIdle = [...this.mcpSessions.entries()].find(([, candidate]) => candidate.activeRequestCount === 0);
			if (!oldestIdle) throw new McpSessionLimitError("Cursor pi tool bridge MCP session limit reached");
			this.mcpSessions.delete(oldestIdle[0]);
			await Promise.allSettled([oldestIdle[1].transport.close(), oldestIdle[1].server.close()]);
		}
		const server = this.createProtocolServer();
		let session: McpProtocolSession;
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: randomUUID,
			onsessioninitialized: (sessionId) => {
				this.mcpSessions.set(sessionId, session);
			},
		});
		session = { server, transport, activeRequestCount: 0 };
		transport.onclose = () => {
			const sessionId = transport.sessionId;
			if (sessionId && this.mcpSessions.get(sessionId) === session) this.mcpSessions.delete(sessionId);
		};

		await server.connect(transport);
		return session;
	}

	private enqueueToolRequest(mcpToolName: string, argsValue: unknown, cursorMcpCallId: string, signal?: AbortSignal): Promise<CallToolResult> {
		const piToolName = this.snapshot.mcpToolNameToPiToolName.get(mcpToolName);
		if (!piToolName) {
			return Promise.resolve({
				content: [{ type: "text", text: `Unknown pi bridge tool: ${mcpToolName}` }],
				isError: true,
			});
		}
		if (this.disposed) return Promise.reject(new Error("Cursor pi tool bridge run is disposed"));

		this.toolCallCounter += 1;
		const bridgeCallId = `${this.id}-bridge-${this.toolCallCounter}`;
		const request: CursorPiBridgeToolRequest = {
			runId: this.id,
			bridgeCallId,
			cursorMcpCallId,
			piToolCallId: `${this.id}-tool-${this.toolCallCounter}`,
			piToolName,
			mcpToolName,
			args: normalizeMcpArgs(argsValue),
		};

		return new Promise<CallToolResult>((resolve, reject) => {
			const pending: PendingBridgeCall = {
				request,
				resolve,
				reject,
				signal,
				settled: false,
			};
			pending.onAbort = () => {
				this.rejectAndAbortPending(pending, new Error("Cursor MCP bridge tool request was aborted"), "cancelled");
			};
			if (signal?.aborted) {
				pending.onAbort();
				return;
			}
			signal?.addEventListener("abort", pending.onAbort, { once: true });
			this.pendingByPiToolCallId.set(request.piToolCallId, pending);
			this.pendingByBridgeCallId.set(request.bridgeCallId, pending);
			this.pendingByCursorMcpCallId.set(cursorMcpCallId, pending);
			this.knownCursorMcpCallIds.add(cursorMcpCallId);
			pending.timeout = setTimeout(() => {
				const reason = `Cursor pi bridge CallTool timed out after ${this.callTimeoutMs} ms`;
				this.rejectAndAbortPending(pending, new Error(reason));
			}, this.callTimeoutMs);
			pending.timeout.unref?.();
			if (!this.onToolRequest) {
				if (this.liveRunHandlerDetached) {
					this.rejectPending(pending, new Error("Cursor pi tool bridge has no active live run"), "cancelled");
					return;
				}
				this.queuedRequests.push(request);
				this.emitRequestQueuedDiagnostic(request);
				this.recordBridgeRaw({ kind: "queued", request });
				return;
			}
			this.emitRequestQueuedDiagnostic(request);
			this.recordBridgeRaw({ kind: "queued", request });
			this.dispatchPendingToolRequest(pending, this.onToolRequest);
		});
	}

	private dispatchPendingToolRequest(
		pending: PendingBridgeCall,
		handler: (request: CursorPiBridgeToolRequest) => void,
	): void {
		try {
			handler(pending.request);
		} catch (error) {
			this.rejectPending(pending, error instanceof Error ? error : new Error(String(error)), "error");
		}
	}

	private rejectQueuedToolRequestsWithoutHandler(reason: string): void {
		while (this.queuedRequests.length > 0) {
			const request = this.queuedRequests.shift()!;
			const pending = this.pendingByPiToolCallId.get(request.piToolCallId);
			if (pending) this.rejectPending(pending, new Error(reason), "cancelled");
		}
	}

	private resolvePending(pending: PendingBridgeCall, result: CallToolResult): void {
		if (pending.settled) return;
		pending.settled = true;
		this.removePending(pending);
		this.emitRequestResolvedDiagnostic(pending.request, result.isError === true);
		this.recordBridgeRaw({ kind: "resolved", request: pending.request, result });
		pending.resolve(result);
	}

	private rejectPending(pending: PendingBridgeCall, error: Error, kind: "cancelled" | "error" = "error"): boolean {
		if (pending.settled) return false;
		pending.settled = true;
		this.removePending(pending);
		this.emitRequestRejectedDiagnostic(pending.request, kind);
		this.recordBridgeRaw({
			kind: "rejected",
			request: pending.request,
			error: error.message,
			rejectionKind: kind,
		});
		pending.reject(error);
		return true;
	}

	private rejectAndAbortPending(
		pending: PendingBridgeCall,
		error: Error,
		kind: "cancelled" | "error" = "error",
	): void {
		if (this.rejectPending(pending, error, kind)) {
			bridgeToolExecutionAbortTracker.abort(pending.request.piToolCallId, error.message);
		}
	}

	private lifecycleDiagnosticFields(pendingCount = this.pendingCount()): CursorPiToolBridgeLifecycleDiagnosticFields {
		return {
			runId: this.id,
			enabled: this.enabled,
			exposedToolCount: this.snapshot.tools.length,
			pendingCount,
		};
	}

	private requestDiagnosticFields(request: CursorPiBridgeToolRequest): CursorPiToolBridgeRequestDiagnosticFields {
		return {
			runId: this.id,
			bridgeCallId: request.bridgeCallId,
			cursorMcpCallId: request.cursorMcpCallId,
			piToolCallId: request.piToolCallId,
			mcpToolName: request.mcpToolName,
			piToolName: request.piToolName,
			pendingCount: this.pendingCount(),
		};
	}

	private emitRequestQueuedDiagnostic(request: CursorPiBridgeToolRequest): void {
		this.emitDiagnostic({ event: "request_queued", ...this.requestDiagnosticFields(request) });
	}

	private emitRequestResolvedDiagnostic(request: CursorPiBridgeToolRequest, isError: boolean): void {
		this.emitDiagnostic({ event: "request_resolved", ...this.requestDiagnosticFields(request), isError });
	}

	private emitRequestRejectedDiagnostic(request: CursorPiBridgeToolRequest, rejectionKind: CursorPiToolBridgeRejectionKind): void {
		this.emitDiagnostic({ event: "request_rejected", ...this.requestDiagnosticFields(request), rejectionKind });
	}

	private emitDiagnostic(event: CursorPiToolBridgeDiagnosticEvent): void {
		writeCursorPiToolBridgeDiagnostic(this.env, event, this.debugRecorder);
	}

	private pendingCount(): number {
		return this.pendingByBridgeCallId.size;
	}

	private removePending(pending: PendingBridgeCall): void {
		if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
		if (pending.timeout) clearTimeout(pending.timeout);
		this.pendingByPiToolCallId.delete(pending.request.piToolCallId);
		this.pendingByBridgeCallId.delete(pending.request.bridgeCallId);
		if (pending.request.cursorMcpCallId) this.pendingByCursorMcpCallId.delete(pending.request.cursorMcpCallId);
		const queuedIndex = this.queuedRequests.findIndex((request) => request.bridgeCallId === pending.request.bridgeCallId);
		if (queuedIndex >= 0) this.queuedRequests.splice(queuedIndex, 1);
	}
}
