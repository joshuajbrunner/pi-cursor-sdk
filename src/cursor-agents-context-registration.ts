import { isCursorModel } from "./cursor-model.js";
import { registerCursorModelLifecycle, type CursorModelLifecycleExtensionApi } from "./cursor-model-lifecycle.js";
import { resolveEffectiveCursorConfigForContext } from "./cursor-runtime-state.js";
import { resolveCursorFacingSystemPrompt } from "./cursor-agents-context.js";
import { recordPromptMutation } from "./cursor-sdk-event-debug-preturn.js";

export type CursorAgentsContextExtensionApi = CursorModelLifecycleExtensionApi;

export function registerCursorAgentsContextDedup(pi: CursorAgentsContextExtensionApi): void {
	registerCursorModelLifecycle(pi, {
		beforeAgentStart: (event, ctx) => {
			if (!isCursorModel(ctx.model)) return undefined;
			const runtime = resolveEffectiveCursorConfigForContext(ctx).runtime.value;
			const resolved = resolveCursorFacingSystemPrompt(
				event.systemPrompt,
				ctx.model,
				event.systemPromptOptions,
				undefined,
				undefined,
				runtime,
			);
			recordPromptMutation({ label: "agents-context-dedup", hook: "before_agent_start", before: event.systemPrompt, after: resolved });
			if (resolved === event.systemPrompt) return undefined;
			return { systemPrompt: resolved };
		},
	});
}
