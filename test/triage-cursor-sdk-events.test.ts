import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "scripts", "triage-cursor-sdk-events.mjs");
const fixture = (name: string) => join(process.cwd(), "test", "fixtures", name);

describe("cursor SDK event triage", () => {
	it("detects wasted bootstrap, overlap, lost updates, and later-turn activation", () => {
		const result = spawnSync(process.execPath, [root, fixture("triage-events-positive")], { encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("wasted bootstrap=CHECKED: 2 findings");
		expect(result.stdout).toContain("concurrent hooks: depth>1=1");
		expect(result.stdout).toContain("LOST UPDATES");
		expect(result.stdout).toContain("ONE-TURN-LATE CANDIDATES");
		expect(result.stdout).toContain("first-appearance evidence");
		expect(result.stdout).toContain("turn-002/prompt-mutations.jsonl");
	});

	it("marks malformed captures insufficient even when valid lines contain a finding", () => {
		const result = spawnSync(process.execPath, [root, fixture("triage-events-malformed")], { encoding: "utf8" });
		expect(result.status).toBe(2);
		expect(result.stdout).toContain("concurrent hooks=NOT CHECKED");
		expect(result.stdout).toContain("malformed JSONL line(s)");
	});

	it.each([
		["triage-events-quiet", 0, "cross-turn continuity=CHECKED: 0 findings"],
		["triage-events-absent", 2, "cross-turn continuity=NOT CHECKED"],
		["triage-events-discontinuity-across-empty", 1, "CROSS-TURN STATE DISCONTINUITIES"],
		["triage-events-boundary-gate", 2, "cross-turn continuity=NOT CHECKED"],
		["triage-events-empty-first", 0, "cross-turn continuity=CHECKED: 0 findings"],
		["triage-events-corrupt-empty-middle", 2, "cross-turn continuity=NOT CHECKED"],
		["triage-events-unrelated-later-corrupt", 2, "cross-turn continuity=CHECKED: 0 findings"],
	])("handles empty-file turn boundaries: %s", (name, status, marker) => {
		const result = spawnSync(process.execPath, [root, fixture(name)], { encoding: "utf8" });
		expect(result.status).toBe(status);
		expect(result.stdout).toContain(marker);
	});

	it("does not report clean sequential or same-turn data", () => {
		const output = execFileSync(process.execPath, [root, fixture("triage-events-clean")], { encoding: "utf8" });
		expect(output).toContain("wasted bootstrap=CHECKED: 0 findings");
		expect(output).toContain("lost-update collisions=CHECKED: 0 findings");
		expect(output).toContain("one-turn-late=CHECKED: 0 findings");
		expect(output).not.toContain("WASTED BOOTSTRAP");
	});
});
