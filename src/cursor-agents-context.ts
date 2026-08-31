import type {
	BuildSystemPromptOptions,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { recordAgentsContextDecision } from "./cursor-sdk-event-debug-preturn.js";
import { resolveCursorSdkEventDebugEnabled } from "../shared/cursor-sdk-event-debug-env.mjs";
import { isCursorModel } from "./cursor-model.js";
import {
	cursorSettingSourcesIncludes,
	CURSOR_SETTING_SOURCES_ENV,
	getEffectiveCursorSettingSources,
	resolveCursorSettingSources,
} from "./cursor-setting-sources.js";
import type { SettingSource } from "@cursor/sdk";
import type { CursorRuntime } from "./cursor-config.js";
export const CURSOR_PRESERVE_PI_AGENTS_MD_ENV = "PI_CURSOR_PRESERVE_PI_AGENTS_MD";

/** Opening tag prefix pi `buildSystemPrompt()` uses for each context file (path attribute only). */
export const PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX = '<project_instructions path="';
const PI_PROJECT_INSTRUCTIONS_CLOSE = "</project_instructions>";
const PI_PROJECT_CONTEXT_OPEN = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
const PI_PROJECT_CONTEXT_CLOSE = "</project_context>\n";

function normalizeContextPath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function normalizeDirPath(dirPath: string): string {
	const normalized = normalizeContextPath(dirPath).replace(/\/+$/, "");
	return normalized || "/";
}

export type PiAgentsContextFile = {
	path: string;
	content: string;
};

/** Overlap classes for pi context files that Cursor also loads via `settingSources`. */
export type PiAgentsContextOverlap = "none" | "cursor-user-agents" | "cursor-project-rules";

/** Pi context filenames that can overlap Cursor project/user ambient rules. */
const CURSOR_OVERLAPPING_CONTEXT_BASE_NAMES = new Set(["agents.md", "claude.md"]);

export function getAgentsContextFileBaseName(filePath: string): string {
	const normalized = normalizeContextPath(filePath);
	return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function isPiAgentDirContextFilePath(
	filePath: string,
	fileName: "agents.md" | "claude.md",
	agentDir: string = getAgentDir(),
): boolean {
	const normalized = normalizeContextPath(filePath);
	const expectedPath = `${normalizeDirPath(agentDir)}/${fileName}`;
	return normalized.toLowerCase() === expectedPath.toLowerCase();
}

/** Actual pi agent dir `AGENTS.md` — overlaps Cursor `user` setting source (global agent instructions). */
export function isPiAgentDirAgentsMdPath(filePath: string, agentDir: string = getAgentDir()): boolean {
	return isPiAgentDirContextFilePath(filePath, "agents.md", agentDir);
}

/** Actual pi agent dir `CLAUDE.md` — kept because Cursor user rules use `~/.claude/CLAUDE.md`. */
export function isPiAgentDirClaudeMdPath(filePath: string, agentDir: string = getAgentDir()): boolean {
	return isPiAgentDirContextFilePath(filePath, "claude.md", agentDir);
}

/**
 * Classify whether a pi-loaded context file overlaps Cursor ambient rules.
 * Project/repo `AGENTS.md` and `CLAUDE.md` overlap Cursor `project` sources.
 * Only the actual pi agent dir `AGENTS.md` overlaps Cursor `user`; agent-dir `CLAUDE.md` is kept
 * because Cursor user rules use `~/.claude/CLAUDE.md`, not pi's agent dir path.
 */
export function classifyContextFileOverlap(
	filePath: string,
	agentDir: string = getAgentDir(),
): PiAgentsContextOverlap {
	const base = getAgentsContextFileBaseName(filePath);
	if (!CURSOR_OVERLAPPING_CONTEXT_BASE_NAMES.has(base)) return "none";
	if (base === "agents.md" && isPiAgentDirAgentsMdPath(filePath, agentDir)) return "cursor-user-agents";
	if (base === "claude.md" && isPiAgentDirClaudeMdPath(filePath, agentDir)) return "none";
	return "cursor-project-rules";
}

export function shouldRemovePiAgentsContextFile(
	file: PiAgentsContextFile,
	settingSources: SettingSource[] | undefined,
	agentDir?: string,
): boolean {
	switch (classifyContextFileOverlap(file.path, agentDir)) {
		case "cursor-user-agents":
			return cursorSettingSourcesIncludes(settingSources, "user");
		case "cursor-project-rules":
			return cursorSettingSourcesIncludes(settingSources, "project");
		default:
			return false;
	}
}

function shouldSuppressPiAgentsContextInternal(
	model: ExtensionContext["model"],
	contextFiles: readonly PiAgentsContextFile[],
	settingSources: SettingSource[] | undefined,
	agentDir?: string,
	decision?: (outcome: "not-cursor-model" | "preserve-env-set") => void,
): boolean {
	if (!isCursorModel(model)) { decision?.("not-cursor-model"); return false; }
	if (parseEnvBoolean(process.env[CURSOR_PRESERVE_PI_AGENTS_MD_ENV], false)) { decision?.("preserve-env-set"); return false; }
	if (contextFiles.length === 0) return false;
	return contextFiles.some((file) => shouldRemovePiAgentsContextFile(file, settingSources, agentDir));
}

export function shouldSuppressPiAgentsContext(
	model: ExtensionContext["model"],
	contextFiles: readonly PiAgentsContextFile[],
	settingSources: SettingSource[] | undefined,
	agentDir?: string,
): boolean {
	return shouldSuppressPiAgentsContextInternal(model, contextFiles, settingSources, agentDir);
}

/** Exact pi `buildSystemPrompt()` serialization for one context file block (including trailing blank line). */
export function serializePiProjectInstructionsBlock(file: PiAgentsContextFile): string {
	return `${PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX}${file.path}">\n${file.content}\n${PI_PROJECT_INSTRUCTIONS_CLOSE}\n\n`;
}

/** Exact pi `buildSystemPrompt()` serialization for the full project context section. */
export function serializePiProjectContextSection(contextFiles: readonly PiAgentsContextFile[]): string {
	if (contextFiles.length === 0) return "";
	return `${PI_PROJECT_CONTEXT_OPEN}${contextFiles.map(serializePiProjectInstructionsBlock).join("")}${PI_PROJECT_CONTEXT_CLOSE}`;
}

/** Remove pi context blocks that overlap Cursor setting sources. */
type AgentsContextDecision = {
	outcome: string;
	runtime?: string;
	systemPromptOptionsPresent?: boolean;
	contextFiles: Array<{ path: string; overlap: PiAgentsContextOverlap }>;
	settingSourcesRaw?: string;
	settingSources?: string[] | null;
	model?: string;
	agentDir?: string;
	serializedSectionLength?: number;
	promptLength: number;
};

function removePiAgentsContextFromSystemPromptInternal(
	systemPrompt: string,
	contextFiles: readonly PiAgentsContextFile[],
	settingSources: SettingSource[] | undefined,
	agentDir: string | undefined,
	decision?: (decision: AgentsContextDecision) => void,
): string {
	const retainedContextFiles: PiAgentsContextFile[] = [];
	let removedAny = false;
	for (const file of contextFiles) {
		if (shouldRemovePiAgentsContextFile(file, settingSources, agentDir)) {
			removedAny = true;
			continue;
		}
		retainedContextFiles.push(file);
	}
	if (!removedAny) {
		decision?.({ outcome: "no-files-removed", contextFiles: contextFiles.map((file) => ({ path: file.path, overlap: classifyContextFileOverlap(file.path, agentDir) })), ...(settingSources === undefined ? {} : { settingSources: settingSources.map(String) }), agentDir, promptLength: systemPrompt.length });
		return systemPrompt;
	}

	const originalSection = serializePiProjectContextSection(contextFiles);
	const start = systemPrompt.indexOf(originalSection);
	if (start < 0) {
		decision?.({ outcome: "section-not-found", contextFiles: contextFiles.map((file) => ({ path: file.path, overlap: classifyContextFileOverlap(file.path, agentDir) })), ...(settingSources === undefined ? {} : { settingSources: settingSources.map(String) }), agentDir, serializedSectionLength: originalSection.length, promptLength: systemPrompt.length });
		return systemPrompt;
	}

	const replacementSection = serializePiProjectContextSection(retainedContextFiles);
	decision?.({ outcome: "stripped", contextFiles: contextFiles.map((file) => ({ path: file.path, overlap: classifyContextFileOverlap(file.path, agentDir) })), ...(settingSources === undefined ? {} : { settingSources: settingSources.map(String) }), agentDir, serializedSectionLength: originalSection.length, promptLength: systemPrompt.length });
	return systemPrompt.slice(0, start) + replacementSection + systemPrompt.slice(start + originalSection.length);
}

export function removePiAgentsContextFromSystemPrompt(
	systemPrompt: string,
	contextFiles: readonly PiAgentsContextFile[],
	settingSources: SettingSource[] | undefined,
	agentDir?: string,
): string {
	return removePiAgentsContextFromSystemPromptInternal(systemPrompt, contextFiles, settingSources, agentDir);
}

export function resolveCursorFacingSystemPrompt(
	systemPrompt: string,
	model: ExtensionContext["model"],
	systemPromptOptions?: BuildSystemPromptOptions,
	settingSourcesRaw?: string,
	agentDir?: string,
	runtime: CursorRuntime = "local",
): string {
	const files = systemPromptOptions?.contextFiles ?? [];
	const effectiveSettingSourcesRaw = settingSourcesRaw ?? process.env[CURSOR_SETTING_SOURCES_ENV];
	const describe = (outcome: string, sources?: SettingSource[] | null): void => {
		if (!resolveCursorSdkEventDebugEnabled()) return;
		recordAgentsContextDecision({ outcome, runtime, systemPromptOptionsPresent: systemPromptOptions !== undefined, contextFiles: files.map((file) => ({ path: file.path, overlap: classifyContextFileOverlap(file.path, agentDir) })), ...(effectiveSettingSourcesRaw === undefined ? {} : { settingSourcesRaw: effectiveSettingSourcesRaw }), ...(sources === undefined ? {} : { settingSources: sources === null ? null : sources.map(String) }), model: typeof model === "object" && model !== null && "id" in model ? String(model.id) : undefined, agentDir, promptLength: systemPrompt.length });
	};
	if (runtime === "cloud") { describe("runtime-cloud"); return systemPrompt; }
	if (!systemPromptOptions) { describe("missing-system-prompt-options"); return systemPrompt; }
	const contextFiles = systemPromptOptions.contextFiles ?? [];
	if (contextFiles.length === 0) { describe("empty-context-files"); return systemPrompt; }
	const settingSources =
		effectiveSettingSourcesRaw === undefined
			? getEffectiveCursorSettingSources()
			: resolveCursorSettingSources(effectiveSettingSourcesRaw);
	let earlyOutcome: "not-cursor-model" | "preserve-env-set" | undefined;
	const suppressed = shouldSuppressPiAgentsContextInternal(model, contextFiles, settingSources, agentDir, resolveCursorSdkEventDebugEnabled() ? (outcome) => { earlyOutcome = outcome; } : undefined);
	if (!suppressed) {
		if (earlyOutcome) describe(earlyOutcome, settingSources);
		else if (settingSources === undefined) describe("setting-sources-disabled", null);
		else describe("no-overlap", settingSources);
		return systemPrompt;
	}
	return removePiAgentsContextFromSystemPromptInternal(systemPrompt, contextFiles, settingSources, agentDir, resolveCursorSdkEventDebugEnabled() ? (decision) => recordAgentsContextDecision({ ...decision, runtime, systemPromptOptionsPresent: true, ...(effectiveSettingSourcesRaw === undefined ? {} : { settingSourcesRaw: effectiveSettingSourcesRaw }), model: typeof model === "object" && model !== null && "id" in model ? String(model.id) : undefined }) : undefined);
}
