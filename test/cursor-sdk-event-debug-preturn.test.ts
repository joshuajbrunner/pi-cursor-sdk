import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { computeCursorBootstrapObservation, computeCursorContextFingerprint, resetCursorBootstrapObservationStateForTests, shouldBootstrapCursorContext } from "../src/context.js";
import {
 createCursorDebugUnifiedDiff, drainPreTurnEvents, recordLifecycleEvent, recordPromptMutation, recordSkillState, recordToolActivation, resetPreTurnEventsForTests,
} from "../src/cursor-sdk-event-debug-preturn.js";

afterEach(() => { delete process.env.PI_CURSOR_SDK_EVENT_DEBUG; resetPreTurnEventsForTests(); resetCursorBootstrapObservationStateForTests(); });
describe("pre-turn debug capture", () => {
 it("is a no-op when disabled", () => { delete process.env.PI_CURSOR_SDK_EVENT_DEBUG; recordLifecycleEvent({ hook: "x", phase: "enter", depth: 1 }); expect(drainPreTurnEvents()).toEqual([]); });
 it("sequences all event types", () => { process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1"; recordLifecycleEvent({ hook: "x", phase: "enter", depth: 1 }); recordPromptMutation({ label: "sanitize", before: "a", after: "b" }); recordToolActivation({ source: "cursor-skill-tool", before: [], after: ["x"] }); recordSkillState({ site: "x", operation: "write", beforeKeys: [], afterKeys: ["x"] }); expect(drainPreTurnEvents().map((e) => e.seq)).toEqual([1, 2, 3, 4]); });
 it("drops newest and resets drops on drain", () => { process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1"; for (let i = 0; i < 501; i++) recordLifecycleEvent({ hook: String(i), phase: "enter", depth: 1 }); const events = drainPreTurnEvents(); expect(events).toHaveLength(500); const last = events.at(-1); expect(last && last.type === "lifecycle" ? last.hook : undefined).toBe("499"); recordLifecycleEvent({ hook: "next", phase: "enter", depth: 1 }); expect(drainPreTurnEvents()).toHaveLength(1); });
});
describe("bootstrap observation", () => {
 it("does not change bootstrap decisions and identifies sanitized-only changes", () => {
  const base = "Guidelines:\nold guidance\n\nPi documentation / details";
  const changed = "Guidelines:\nnew guidance\n\nPi documentation / details";
  const context = (systemPrompt: string) => ({ systemPrompt, messages: [] });
  const state = { bootstrapped: true, contextFingerprint: computeCursorContextFingerprint(context(base) as never) };
  const matrix = [context(base), context(changed), context("Guidelines:\nold guidance\n\nPi documentation / changed"), context("Guidelines:\nold guidance\n\nPi documentation / details\nOutside change")];
  const firstTurn = { bootstrapped: false, contextFingerprint: "" };
  expect(shouldBootstrapCursorContext(firstTurn, context(base) as never)).toBe(true);
  for (const item of matrix) { delete process.env.PI_CURSOR_SDK_EVENT_DEBUG; const offDecision = shouldBootstrapCursorContext(state, item as never); process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1"; expect(shouldBootstrapCursorContext(state, item as never)).toBe(offDecision); }
  delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
  const off = shouldBootstrapCursorContext(state, context(changed) as never);
  process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
  const on = shouldBootstrapCursorContext(state, context(changed) as never);
  expect(on).toBe(off);
  computeCursorBootstrapObservation(state, context(base) as never, "observation-test");
  const observation = computeCursorBootstrapObservation(state, context(changed) as never, "observation-test");
  expect(observation?.wouldBootstrapOnRaw).toBe(true);
  expect(observation?.wastedBootstrap).toBe(true);
 });
 it("retains the pre-reset observation", () => {
  process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
  const base = "Guidelines:\nold guidance\n\nPi documentation / details";
  const changed = "Guidelines:\nnew guidance\n\nPi documentation / details";
  const state = { bootstrapped: true, contextFingerprint: computeCursorContextFingerprint({ systemPrompt: base, messages: [] } as never) };
  computeCursorBootstrapObservation(state, { systemPrompt: base, messages: [] } as never, "reset-test");
  const observation = computeCursorBootstrapObservation(state, { systemPrompt: changed, messages: [] } as never, "reset-test");
  expect(observation?.wastedBootstrap).toBe(true);
  const freshLeaseState = { bootstrapped: false, contextFingerprint: "" };
  const postReset = computeCursorBootstrapObservation(freshLeaseState, { systemPrompt: changed, messages: [] } as never, "reset-test-post");
  expect(postReset?.wastedBootstrap).toBe(false);
  expect(postReset?.wouldBootstrapOnRaw).toBe(true);
 });
});

describe("provider observation ordering", () => {
 it("observes the original state before reset handling", () => {
  const source = readFileSync(new URL("../src/cursor-provider-turn-prepare.ts", import.meta.url), "utf8");
  // The observation must use the pre-reset lease; textual checks make renames fail loudly.
  const declaration = source.indexOf("const bootstrapObservation");
  const resetBranch = source.indexOf("if (sendPlan.resetAgent)");
  expect(declaration).toBeGreaterThan(-1);
  expect(resetBranch).toBeGreaterThan(-1);
  expect(declaration).toBeLessThan(resetBranch);
 });
});

describe("unified diff", () => {
 it("handles identical and basic changes", () => { expect(createCursorDebugUnifiedDiff("a", "a")).toBe(""); expect(createCursorDebugUnifiedDiff("a", "a\nb")).toContain("+b"); expect(createCursorDebugUnifiedDiff("a\nb", "a")).toContain("-b"); expect(createCursorDebugUnifiedDiff("a", "b")).toContain("-a\n+b"); });
 it("separates distant changes", () => { const before = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"); const after = before.replace("line 20", "line 20\nTOP").replace("line 180", "line 180\nBOTTOM"); const diff = createCursorDebugUnifiedDiff(before, after); expect(diff.match(/@@ -/g)).toHaveLength(2); expect(diff).toContain("@@ -18,6 +18,7 @@"); expect(diff).toContain("@@ -178,6 +179,7 @@"); });
});
