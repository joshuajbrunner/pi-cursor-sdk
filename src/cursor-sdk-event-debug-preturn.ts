import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolveCursorSdkEventDebugEnabled } from "../shared/cursor-sdk-event-debug-env.mjs";

const MAX_EVENTS = 500;
let events: PreTurnEvent[] = [];
let droppedCount = 0;
let lastDroppedCount = 0;
let sequence = 0;
let activeSink: ((events: PreTurnEvent[]) => void) | undefined;

export type PreTurnEvent =
	| ({ type: "lifecycle"; hook: string; phase: "enter" | "exit"; depth: number; model?: string; runtime?: string; durationMs?: number; error?: string } & Common)
	| ({ type: "prompt-mutation"; label: string; hook?: string; before: string; after: string; changed: boolean; beforeSha1: string; afterSha1: string; beforeLength: number; afterLength: number; diff: string } & Common)
	| ({ type: "tool-activation"; source: string; reason?: string; before: string[]; after: string[]; added: string[]; removed: string[] } & Common)
	| ({ type: "skill-state"; site: string; operation: string; beforeKeys: string[]; afterKeys: string[]; beforeCount: number; afterCount: number } & Common);

type Common = { seq: number; t: number; ts: string };
type PreTurnEventInput = { [K in PreTurnEvent["type"]]: Omit<Extract<PreTurnEvent, { type: K }>, keyof Common> }[PreTurnEvent["type"]];

function enabled(): boolean { return resolveCursorSdkEventDebugEnabled(); }
function push(event: PreTurnEventInput): void {
	if (!enabled()) return;
	const common = { seq: ++sequence, t: performance.now(), ts: new Date().toISOString() };
	let item: PreTurnEvent;
	if (event.type === "lifecycle") item = { ...event, ...common };
	else if (event.type === "prompt-mutation") item = { ...event, ...common };
	else if (event.type === "tool-activation") item = { ...event, ...common };
	else item = { ...event, ...common };
	if (events.length >= MAX_EVENTS) { droppedCount++; return; }
	events.push(item);
	if (activeSink) activeSink(drainPreTurnEvents());
}
function sha1(text: string): string { return createHash("sha1").update(text).digest("hex"); }
export function createCursorDebugUnifiedDiff(before: string, after: string): string {
	if (before === after) return "";
	const originalA = before.split("\n"), originalB = after.split("\n");
	let prefix = 0;
	while (prefix < originalA.length && prefix < originalB.length && originalA[prefix] === originalB[prefix]) prefix++;
	let suffix = 0;
	while (suffix < originalA.length - prefix && suffix < originalB.length - prefix && originalA[originalA.length - 1 - suffix] === originalB[originalB.length - 1 - suffix]) suffix++;
	const trimPrefix = Math.max(0, prefix - 3), trimSuffix = Math.max(0, suffix - 3);
	const a = originalA.slice(trimPrefix, originalA.length - trimSuffix), b = originalB.slice(trimPrefix, originalB.length - trimSuffix), ops: Array<{ kind: " " | "+" | "-"; text: string; ai: number; bi: number }> = [];
	const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1]?.[j + 1]! + 1 : Math.max(dp[i + 1]?.[j] ?? 0, dp[i][j + 1] ?? 0);
	let i = 0, j = 0;
	while (i < a.length && j < b.length) { if (a[i] === b[j]) { ops.push({ kind: " ", text: a[i], ai: i++, bi: j++ }); } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i][j + 1] ?? 0)) ops.push({ kind: "-", text: a[i], ai: i++, bi: j }); else ops.push({ kind: "+", text: b[j], ai: i, bi: j++ }); }
	while (i < a.length) ops.push({ kind: "-", text: a[i], ai: i++, bi: j }); while (j < b.length) ops.push({ kind: "+", text: b[j], ai: i, bi: j++ });
	const changed = ops.map((op, n) => op.kind === " " ? -1 : n).filter((n) => n >= 0), groups: number[][] = [];
	for (const n of changed) { const group = groups.at(-1); if (!group || n - group.at(-1)! > 6) groups.push([n]); else group.push(n); }
	const hunks = groups.map((group) => { const from = Math.max(0, group[0] - 3), to = Math.min(ops.length - 1, group.at(-1)! + 3); const selected = ops.slice(from, to + 1); const oldStart = Math.max(1, selected[0].ai + trimPrefix + 1), newStart = Math.max(1, selected[0].bi + trimPrefix + 1); const oldCount = selected.filter((op) => op.kind !== "+").length, newCount = selected.filter((op) => op.kind !== "-").length; return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${selected.map((op) => op.kind + op.text).join("\n")}`; });
	return [`--- before`, `+++ after`, ...hunks].join("\n") + "\n";
}

export function nextCursorDebugSeq(): number { return enabled() ? ++sequence : 0; }
export function recordLifecycleEvent(entry: { hook: string; phase: "enter" | "exit"; depth: number; model?: string; runtime?: string; durationMs?: number; error?: string }): void { push({ type: "lifecycle", ...entry }); }
export function recordPromptMutation(entry: { label: string; hook?: string; before: string; after: string }): void {
	if (!enabled()) return;
	push({ type: "prompt-mutation", ...entry, changed: entry.before !== entry.after, beforeSha1: sha1(entry.before), afterSha1: sha1(entry.after), beforeLength: entry.before.length, afterLength: entry.after.length, diff: createCursorDebugUnifiedDiff(entry.before, entry.after) });
}
export function recordToolActivation(entry: { source: string; reason?: string; before: string[]; after: string[] }): void {
	if (!enabled()) return;
	push({ type: "tool-activation", ...entry, added: entry.after.filter((x) => !entry.before.includes(x)), removed: entry.before.filter((x) => !entry.after.includes(x)) });
}
export function recordSkillState(entry: { site: string; operation: string; beforeKeys: string[]; afterKeys: string[] }): void {
	push({ type: "skill-state", ...entry, beforeCount: entry.beforeKeys.length, afterCount: entry.afterKeys.length });
}
export function drainPreTurnEvents(): PreTurnEvent[] {
	if (!enabled()) return [];
	const drained = events;
	events = [];
	lastDroppedCount = droppedCount;
	droppedCount = 0;
	return drained;
}
export function getPreTurnDroppedCount(): number { return lastDroppedCount; }
export function setPreTurnEventSink(sink: ((events: PreTurnEvent[]) => void) | undefined): void { activeSink = sink; }
export function resetPreTurnEventsForTests(): void { events = []; droppedCount = 0; lastDroppedCount = 0; sequence = 0; activeSink = undefined; }
