import {
	recordLifecycleEvent,
} from "./cursor-sdk-event-debug-preturn.js";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionContext,
	ExtensionHandler,
	SessionStartEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

export type CursorModelLifecycleContext = ExtensionContext;

type CursorModelSelectEvent = { model: ExtensionContext["model"] };

type CursorModelLifecycleSyncHandler = (ctx: CursorModelLifecycleContext) => Promise<void> | void;
type CursorModelSessionStartHandler = ExtensionHandler<SessionStartEvent>;
type CursorModelSelectHandler = (event: CursorModelSelectEvent, ctx: CursorModelLifecycleContext) => Promise<void> | void;
type CursorModelTurnStartHandler = ExtensionHandler<TurnStartEvent>;
type CursorModelBeforeAgentStartHandler = ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;

export interface CursorModelLifecycleExtensionApi {
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "before_agent_start", handler: CursorModelBeforeAgentStartHandler): void;
	on(event: "model_select", handler: (event: CursorModelSelectEvent, ctx: ExtensionContext) => Promise<void> | void): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
}

export interface CursorModelLifecycleHandlers {
	sessionStart?: CursorModelSessionStartHandler;
	modelSelect?: CursorModelSelectHandler;
	turnStart?: CursorModelTurnStartHandler;
	sync?: CursorModelLifecycleSyncHandler;
	beforeAgentStart?: CursorModelBeforeAgentStartHandler;
}

function normalizeLifecycleHandlers(
	handlerOrHandlers: CursorModelLifecycleSyncHandler | CursorModelLifecycleHandlers,
): CursorModelLifecycleHandlers {
	return typeof handlerOrHandlers === "function" ? { sync: handlerOrHandlers } : handlerOrHandlers;
}

let lifecycleDepth = 0;

function lifecycleModel(ctx: CursorModelLifecycleContext): { model?: string; runtime?: string } {
	const model = ctx.model;
	return {
		model: typeof model?.id === "string" ? model.id : typeof model?.name === "string" ? model.name : undefined,
		runtime: typeof model?.provider === "string" ? model.provider : undefined,
	};
}

async function instrumentLifecycle<T>(hook: string, ctx: CursorModelLifecycleContext, handler: () => Promise<T>): Promise<T> {
	lifecycleDepth += 1;
	const depth = lifecycleDepth;
	const started = performance.now();
	const identity = lifecycleModel(ctx);
	recordLifecycleEvent({ hook, phase: "enter", depth, ...identity });
	let failure: string | undefined;
	try {
		return await handler();
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		lifecycleDepth -= 1;
		recordLifecycleEvent({ hook, phase: "exit", depth, ...identity, durationMs: performance.now() - started, error: failure });
	}
}

export function registerCursorModelLifecycle(
	pi: CursorModelLifecycleExtensionApi,
	handlerOrHandlers: CursorModelLifecycleSyncHandler | CursorModelLifecycleHandlers,
): void {
	const handlers = normalizeLifecycleHandlers(handlerOrHandlers);
	const sync = handlers.sync;
	if (handlers.sessionStart || sync) {
		pi.on("session_start", (event, ctx) => instrumentLifecycle("session_start", ctx, async () => {
			await handlers.sessionStart?.(event, ctx);
			await sync?.(ctx);
		}));
	}
	if (handlers.modelSelect || sync) {
		pi.on("model_select", (event, ctx) => instrumentLifecycle("model_select", ctx, async () => {
			const effectiveCtx = { ...ctx, model: event.model };
			await handlers.modelSelect?.(event, effectiveCtx);
			await sync?.(effectiveCtx);
		}));
	}
	if (handlers.turnStart || sync) {
		pi.on("turn_start", (event, ctx) => instrumentLifecycle("turn_start", ctx, async () => {
			await handlers.turnStart?.(event, ctx);
			await sync?.(ctx);
		}));
	}
	if (handlers.beforeAgentStart || sync) {
		pi.on("before_agent_start", (event, ctx) => instrumentLifecycle("before_agent_start", ctx, async () => {
			await sync?.(ctx);
			return await handlers.beforeAgentStart?.(event, ctx);
		}));
	}
}
