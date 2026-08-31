#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const artifactNames = ["metadata.json", "lifecycle.jsonl", "tool-activation.jsonl", "prompt-mutations.jsonl"];
function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } }
function readJsonl(path) {
  try {
    const records = [], errors = [];
    for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try { records.push({ ...JSON.parse(line), __line: index + 1, __file: path, __raw: line }); } catch { errors.push(index + 1); }
    }
    return { records, errors };
  } catch { return { records: [], errors: existsSync(path) ? [0] : [] }; }
}
function isTurn(dir) { return artifactNames.some((name) => existsSync(join(dir, name))); }
function turnDirs(root) {
  if (isTurn(root)) return [root];
  const manifest = readJson(join(root, "session.json"));
  if (manifest?.turns?.length) return manifest.turns.map((t) => resolve(t.artifactDir));
  return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && isTurn(join(root, e.name))).map((e) => join(root, e.name)).sort();
}
function setKey(values) { return [...new Set(values ?? [])].sort().join("\u0000"); }
function label(dir) { return dir.split(/[\\/]/).pop() ?? dir; }
function bodyFor(dir, mutation) {
  if (typeof mutation.after === "string") return mutation.after;
  if (typeof mutation.afterBody !== "string") return "";
  try { return readFileSync(join(dir, mutation.afterBody), "utf8"); } catch { return ""; }
}
function containsTool(text, tool) { return new RegExp(`(^|[^A-Za-z0-9_-])${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^A-Za-z0-9_-])`).test(text); }

const root = resolve(process.argv[2] ?? ".debug/cursor-sdk-events");
if (!existsSync(root)) { console.error(`No capture directory: ${root}`); process.exit(2); }
const dirs = turnDirs(root);
if (!dirs.length) { console.error(`No turn artifacts found under: ${root}`); process.exit(2); }
let wasted = 0, lost = 0, concurrent = 0, parseErrors = 0;
const late = [], boundaryFindings = [], boundaryGaps = [], allActivations = [], allMutations = [], coverage = [], turnMetadata = [], activationValidity = []; let boundaryChecks = 0;
for (const [turnIndex, dir] of dirs.entries()) {
  const metadataPath = join(dir, "metadata.json"), lifecyclePath = join(dir, "lifecycle.jsonl"), activationPath = join(dir, "tool-activation.jsonl"), mutationPath = join(dir, "prompt-mutations.jsonl");
  const metadata = readJson(metadataPath) ?? {}, provider = metadata.providerMeta ?? metadata.providerMetadata;
  turnMetadata.push(metadata);
  const lifecycleResult = readJsonl(lifecyclePath), activationResult = readJsonl(activationPath), mutationResult = readJsonl(mutationPath);
  const lifecycle = lifecycleResult.records, activations = activationResult.records, mutations = mutationResult.records;
  activationValidity.push(existsSync(activationPath) && activationResult.errors.length === 0 && activations.every((e) => typeof e.seq === "number"));
  const errors = lifecycleResult.errors.length + activationResult.errors.length + mutationResult.errors.length;
  parseErrors += errors;
  const available = {
    wasted: Boolean(provider && typeof provider.wouldBootstrapOnRaw === "boolean" && typeof provider.wouldBootstrapOnSanitized === "boolean"),
    concurrent: existsSync(lifecyclePath) && lifecycleResult.errors.length === 0,
    lost: existsSync(activationPath) && activationResult.errors.length === 0 && activations.every((e) => typeof e.seq === "number"),
    late: existsSync(activationPath) && existsSync(mutationPath) && activationResult.errors.length === 0 && mutationResult.errors.length === 0,
  };
  coverage.push(available);
  if (available.wasted && provider.wouldBootstrapOnRaw === true && provider.wouldBootstrapOnSanitized === false) wasted++;
  const stack = [], overlaps = [], depthRecords = [], depthHooks = new Set();
  for (const e of lifecycle) {
    if (e.phase === "enter") { if (stack.length) overlaps.push({ outer: stack[stack.length - 1], inner: e }); stack.push(e); if (e.depth > 1) { depthHooks.add(e.hook); depthRecords.push(e); } }
    else { const i = stack.map((x) => x.hook).lastIndexOf(e.hook); if (i >= 0) stack.splice(i, 1); }
  }
  const collisions = [];
  if (available.lost) {
    const ordered = [...activations].sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < ordered.length; i++) {
      const previous = ordered[i - 1], current = ordered[i];
      if (setKey(current.before) !== setKey(previous.after)) {
        const vanished = (previous.after ?? []).filter((x) => !(current.before ?? []).includes(x));
        collisions.push(`${current.source} state discontinuity (stale read by ${current.source}, or an unobserved writer between ${previous.source} and ${current.source}; dropped: ${vanished.join(", ") || "none"}); evidence predecessor ${previous.__file}:${previous.__line} seq=${previous.seq} ${JSON.stringify(previous)}; stale ${current.__file}:${current.__line} seq=${current.seq} ${JSON.stringify(current)}`); lost++;
      }
    }
  }
  for (const a of activations) allActivations.push({ ...a, dir, turnIndex });
  for (const m of mutations) allMutations.push({ ...m, dir, turnIndex });
  if (available.concurrent) concurrent += depthHooks.size + overlaps.length;
  console.log(`\nTURN ${label(dir)}`);
  if (provider?.rawSystemHash || provider?.sanitizedSystemHash) console.log(`  fingerprints: raw=${provider.rawSystemHash ?? "(missing)"} sanitized=${provider.sanitizedSystemHash ?? "(missing)"}`);
  if (available.wasted && provider.wouldBootstrapOnRaw === true && provider.wouldBootstrapOnSanitized === false) { console.log(`  !!! WASTED BOOTSTRAP: rawSystemHash=${provider.rawSystemHash ?? "?"}, sanitizedSystemHash=${provider.sanitizedSystemHash ?? "?"}, wouldBootstrapOnRaw=true, wouldBootstrapOnSanitized=false !!!`); const previous = allMutations.filter((m) => m.turnIndex < turnIndex && m.label === "sanitize" && typeof m.afterBody === "string").sort((a, b) => b.turnIndex - a.turnIndex || (b.seq ?? -1) - (a.seq ?? -1))[0]; const current = [...mutations].reverse().find((m) => m.label === "sanitize" && typeof m.afterBody === "string"); const bodyPath = (d, m) => typeof m?.afterBody === "string" && existsSync(join(d, m.afterBody)) ? join(d, m.afterBody) : undefined; const same = previous && current && bodyPath(previous.dir, previous) && bodyPath(dir, current) && bodyFor(dir, current) === bodyFor(previous.dir, previous); if (same) console.log(`    evidence byte-identical sanitize after bodies: ${join(previous.dir, previous.afterBody)} and ${join(dir, current.afterBody)} (prior ${previous.__file}:${previous.__line}, current ${current.__file}:${current.__line})`); if (!same) console.log(`    evidence prompt-body paths unavailable in metadata/artifacts; inspect ${metadataPath}`); }
  if (depthHooks.size || overlaps.length) { console.log(`  ${available.concurrent ? "concurrent hooks" : "concurrent hook candidates (unverified)"}: depth>1=${depthHooks.size}, interleaved=${overlaps.map((x) => `${x.outer.hook}@${x.outer.seq} → ${x.inner.hook}@${x.inner.seq}`).join("; ") || "none"}`); for (const e of depthRecords) console.log(`    evidence ${e.__file}:${e.__line} seq=${e.seq} ${JSON.stringify(e)}`); for (const x of overlaps) { const exit = lifecycle.find((e) => e.phase === "exit" && e.hook === x.outer.hook && e.seq > x.inner.seq); console.log(`    evidence ${x.outer.__file}:${x.outer.__line} seq=${x.outer.seq} ${JSON.stringify(x.outer)}; ${x.inner.__file}:${x.inner.__line} seq=${x.inner.seq} ${JSON.stringify(x.inner)}; exit ${exit?.__file ?? lifecyclePath}:${exit?.__line ?? "?"} seq=${exit?.seq ?? "?"}`); } }
  if (collisions.length) console.log(`  !!! LOST UPDATES: ${collisions.join("; ")}`);
  console.log(`  prompt churn: ${[...new Set(mutations.filter((e) => e.changed === true).map((e) => e.label))].join(", ") || "none"}`);
  if (errors) console.log(`  WARNING: ${errors} malformed JSONL line(s); affected detectors are NOT CHECKED`);
}
for (let i = 1; i < dirs.length; i++) {
  const activationFile = (n) => join(dirs[n], "tool-activation.jsonl");
  if (!existsSync(activationFile(i))) { boundaryGaps.push(`turn boundary ${i - 1} → ${i} has an absent activation file`); continue; }
  const nextTurns = allActivations.filter((a) => a.turnIndex === i).sort((a, b) => a.seq - b.seq);
  if (!activationValidity[i]) { boundaryGaps.push(`turn boundary ${i - 1} → ${i} has malformed or unordered activation data`); continue; }
  if (!nextTurns.length) continue; // present-empty: bridge to the next non-empty turn
  let j = i - 1;
  while (j >= 0 && existsSync(activationFile(j)) && !allActivations.some((a) => a.turnIndex === j)) j--;
  if (j < 0) continue; // no predecessor state to compare
  if (!existsSync(activationFile(j))) { boundaryGaps.push(`turn boundary ${i - 1} → ${i} has an absent activation file`); continue; }
  const priorTurns = allActivations.filter((a) => a.turnIndex === j).sort((a, b) => a.seq - b.seq);
  const prior = priorTurns.at(-1), next = nextTurns[0];
  const processKey = (m) => m?.processId ?? m?.pid;
  const span = turnMetadata.slice(j, i + 1);
  if (!activationValidity.slice(j, i + 1).every(Boolean)) { boundaryGaps.push(`turn boundary ${j} → ${i} has malformed or unordered activation data`); continue; }
  if (span.some((m) => processKey(m) === undefined) || span.some((m) => processKey(m) !== processKey(span[0]))) { boundaryGaps.push(`turn boundary ${j} → ${i} has no proven same-process identity`); continue; }
  if (span.some((m) => m.droppedCount !== 0 || typeof m.droppedCount !== "number")) { boundaryGaps.push(`turn boundary ${j} → ${i} has unknown or dropped pre-turn events`); continue; }
  if (!prior || typeof prior.seq !== "number" || typeof next.seq !== "number" || next.seq <= prior.seq) { boundaryGaps.push(`turn boundary ${j} → ${i} has no continuous ordered activation sequence`); continue; }
  boundaryChecks += i - j;
  if (setKey(next.before) !== setKey(prior.after)) { const dropped = (prior.after ?? []).filter((x) => !(next.before ?? []).includes(x)); boundaryFindings.push(`${next.source} state discontinuity across turns (stale read, or an unobserved writer; dropped: ${dropped.join(", ") || "none"}); evidence predecessor ${prior.__file}:${prior.__line} seq=${prior.seq} ${JSON.stringify(prior)}; next ${next.__file}:${next.__line} seq=${next.seq} ${JSON.stringify(next)}`); lost++; }
}
if (boundaryFindings.length) { console.log("\nCROSS-TURN STATE DISCONTINUITIES"); for (const item of boundaryFindings) console.log(`  ${item}`); }
for (const a of allActivations) for (const tool of a.added ?? []) {
  const own = allMutations.find((m) => m.turnIndex === a.turnIndex && m.changed === true && containsTool(bodyFor(m.dir, m), tool));
  if (own) continue;
  const p = allMutations.find((m) => m.turnIndex > a.turnIndex && m.changed === true && containsTool(bodyFor(m.dir, m), tool));
  if (p) late.push(`${label(a.dir)}: activation evidence ${a.__file}:${a.__line} seq=${a.seq ?? "?"} ${JSON.stringify(a)}; first-appearance evidence ${p.__file}:${p.__line} seq=${p.seq ?? "?"} body=${p.afterBody ? join(p.dir, p.afterBody) : "inline"}`);
}
if (late.length) { console.log("\nONE-TURN-LATE CANDIDATES"); for (const item of late) console.log(`  ${item}`); }
const missing = [], count = (key) => coverage.filter((c) => c[key]).length;
const detectorNames = { wasted: "metadata.json providerMeta bootstrap fields", concurrent: "lifecycle.jsonl", lost: "tool-activation.jsonl", late: "tool-activation.jsonl + prompt-mutations.jsonl" };
const boundaryChecked = boundaryChecks;
const checked = { wasted: count("wasted"), concurrent: count("concurrent"), lost: count("lost"), late: count("late") };
for (const key of Object.keys(detectorNames)) if (checked[key] < dirs.length) missing.push(`${detectorNames[key]} (${checked[key]}/${dirs.length} turns)`);
if (boundaryGaps.length) missing.push(`cross-turn continuity (${boundaryChecked}/${Math.max(0, dirs.length - 1)} boundaries)`);
const state = (key, findings) => checked[key] === dirs.length ? `CHECKED: ${findings} findings` : `NOT CHECKED (${checked[key]}/${dirs.length} turns; ${findings} findings in checked turns)`;
console.log(`\nSUMMARY: ${dirs.length} turn(s); wasted bootstrap=${state("wasted", wasted)}; concurrent hooks=${state("concurrent", concurrent)}; lost-update collisions=${state("lost", lost)}; cross-turn continuity=${boundaryGaps.length ? `NOT CHECKED (${boundaryChecked}/${Math.max(0, dirs.length - 1)} boundaries; ${boundaryFindings.length} findings in checked boundaries)` : `CHECKED: ${boundaryFindings.length} findings`}; one-turn-late=${state("late", late.length)}`);
if (missing.length || parseErrors || boundaryGaps.length) console.log(`NOT CHECKED (incomplete coverage): ${[...missing, ...boundaryGaps, ...(parseErrors ? [`${parseErrors} malformed JSONL line(s)`] : [])].join(", ")}`);
const hasFinding = wasted > 0 || concurrent > 0 || lost > 0 || late.length > 0;
process.exitCode = hasFinding ? 1 : missing.length || parseErrors || boundaryGaps.length ? 2 : 0;
