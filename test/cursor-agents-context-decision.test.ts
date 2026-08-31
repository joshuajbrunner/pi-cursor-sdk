import { afterEach, describe, expect, it } from "vitest";
import { resolveCursorFacingSystemPrompt, serializePiProjectContextSection } from "../src/cursor-agents-context.js";
import { resetPreTurnEventsForTests, setPreTurnEventSink, type PreTurnEvent } from "../src/cursor-sdk-event-debug-preturn.js";
import { makeHarnessModel, makeModel } from "./helpers/model-fixtures.js";

const file = { path: "/repo/AGENTS.md", content: "Project guidance" };
const options = { cwd: "/repo", contextFiles: [file] };
const model = makeModel("cursor");

afterEach(() => { delete process.env.PI_CURSOR_SDK_EVENT_DEBUG; delete process.env.PI_CURSOR_PRESERVE_PI_AGENTS_MD; delete process.env.PI_CURSOR_SETTING_SOURCES; resetPreTurnEventsForTests(); });
function capture(): PreTurnEvent[] {
	process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
	const events: PreTurnEvent[] = [];
	setPreTurnEventSink((items) => events.push(...items));
	return events;
}
function last(events: PreTurnEvent[]): Extract<PreTurnEvent, { type: "agents-context-decision" }> {
	const event = [...events].reverse().find((item: PreTurnEvent) => item.type === "agents-context-decision");
	expect(event?.type).toBe("agents-context-decision");
	return event as Extract<PreTurnEvent, { type: "agents-context-decision" }>;
}

describe("agents context decision instrumentation", () => {
	it.each([
		["runtime-cloud", "cloud", options, "all"],
		["missing-system-prompt-options", "local", undefined, "all"],
		["empty-context-files", "local", { cwd: "/repo", contextFiles: [] }, "all"],
		["no-overlap", "local", { cwd: "/repo", contextFiles: [{ path: "/repo/README.md", content: "x" }] }, "all"],
	])("records %s", (outcome, runtime, systemPromptOptions, sources) => {
		const events = capture();
		resolveCursorFacingSystemPrompt("prompt", model, systemPromptOptions, sources, undefined, runtime as "local" | "cloud");
		const event = last(events);
		expect(event.outcome).toBe(outcome);
		if (outcome !== "no-overlap") expect("settingSources" in event).toBe(false);
	});

	it("records not-cursor-model", () => {
		const events = capture();
		const otherModel = makeHarnessModel("other", "openai-responses", "other");
		resolveCursorFacingSystemPrompt("prompt", otherModel, options, "all");
		const event = last(events);
		expect(event.outcome).toBe("not-cursor-model");
		expect("settingSources" in event).toBe(true);
	});

	it("records setting-sources-disabled from the environment", () => {
		const events = capture();
		process.env.PI_CURSOR_SETTING_SOURCES = "none";
		resolveCursorFacingSystemPrompt("prompt", model, options);
		const event = last(events);
		expect(event.outcome).toBe("setting-sources-disabled");
		expect(event.settingSourcesRaw).toBe("none");
		expect(event.settingSources).toBeNull();
	});

	it("does not inspect context paths when disabled", () => {
		process.env.PI_CURSOR_SDK_EVENT_DEBUG = "0";
		let reads = 0;
		const lazy = { content: "x", get path() { reads++; return "/repo/AGENTS.md"; } };
		resolveCursorFacingSystemPrompt("prompt", model, { cwd: "/repo", contextFiles: [lazy] }, "all", undefined, "cloud");
		expect(reads).toBe(0);
	});

	it("records preserve-env-set", () => {
		const events = capture();
		process.env.PI_CURSOR_PRESERVE_PI_AGENTS_MD = "1";
		resolveCursorFacingSystemPrompt("prompt", model, options, "all");
		expect(last(events).outcome).toBe("preserve-env-set");
		delete process.env.PI_CURSOR_PRESERVE_PI_AGENTS_MD;
	});

	it("records section-not-found when serialized section differs", () => {
		const events = capture();
		const section = serializePiProjectContextSection([file]);
		resolveCursorFacingSystemPrompt(`prefix${section.replace("Project guidance", "Changed")}`, model, options, "all");
		expect(last(events).outcome).toBe("section-not-found");
	});

	it("records stripped", () => {
		const events = capture();
		resolveCursorFacingSystemPrompt(serializePiProjectContextSection([file]), model, options, "all");
		expect(last(events).outcome).toBe("stripped");
	});

	it("is neutral when disabled", () => {
		process.env.PI_CURSOR_SDK_EVENT_DEBUG = "0";
		const events: PreTurnEvent[] = [];
		setPreTurnEventSink((items) => events.push(...items));
		const prompt = serializePiProjectContextSection([file]);
		const baseline = resolveCursorFacingSystemPrompt(prompt, model, options, "all");
		expect(resolveCursorFacingSystemPrompt(prompt, model, options, "all")).toBe(baseline);
		expect(events).toHaveLength(0);
	});
});
