import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readInstalledPackageDistText, resolveInstalledPackageRoot } from "./helpers/installed-package.js";

// Locks the installed SDK boundary independently of the bridge mocks. Runtime
// source checks cover the callback/result normalization in the bundled executor.
describe("installed Cursor SDK custom-tools contract", () => {
	it("publishes local custom tools with JSON arguments and an optional call ID", () => {
		const root = resolveInstalledPackageRoot("@cursor/sdk");
		const options = readFileSync(join(root, "dist/esm/options.d.ts"), "utf8");
		expect(options).toContain("customTools?: Record<string, SDKCustomTool>");
		expect(options).toMatch(/interface SDKCustomToolContext\s*\{\s*toolCallId\?: string;/);
		expect(options).toContain("execute: (args: Record<string, SDKJsonValue>, context: SDKCustomToolContext) => SDKCustomToolResult | Promise<SDKCustomToolResult>");
		const executor = readFileSync(join(root, "dist/esm/custom-tools.d.ts"), "utf8");
		expect(executor).toContain('"custom-user-tools"');
		expect(executor).toContain("createSdkCustomToolMcpExecutor(customTools: Record<string, SDKCustomTool>): McpExecutor");
	});

	it("decodes protobuf arguments and passes the call ID to the in-process callback", () => {
		const source = readInstalledPackageDistText("@cursor/sdk");
		expect(source).toMatch(/Object\.fromEntries\(Object\.entries\(\w+\.args\)\.map\(/);
		expect(source).toMatch(/\.toJson\(\)/);
		expect(source).toMatch(/\.execute\([^;]{0,300}\{toolCallId:\w+\.toolCallId\|\|void 0\}\)/);
	});

	it("preserves content, error flags and structured content in SDK results", () => {
		const source = readInstalledPackageDistText("@cursor/sdk");
		expect(source).toMatch(/\{content:\w+\.content,isError:\w+\.isError,structuredContent:\w+\.structuredContent\}/);
		expect(source).toMatch(/\.Struct\.fromJson\(\w+\.structuredContent\)/);
		expect(source).toContain("Unknown custom tool:");
	});
});
