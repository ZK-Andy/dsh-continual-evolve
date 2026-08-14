/**
 * Plugin-owned file logging tests: JSONL records, rotation, 0600
 * permissions, and exporter registration against a mock context.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import {
	DEFAULT_LOG_MAX_BYTES,
	PLUGIN_LOG_FILE_NAME,
	appendOrRotate,
	formatLogLine,
	logRecord,
	pluginLogFilePath,
	registerFileLogger,
	renderArgs,
} from "../src/logfile.js";

function message(overrides: Partial<Parameters<typeof logRecord>[0]> = {}) {
	return {
		ts: Date.parse("2026-08-15T00:00:00.000Z"),
		type: "info",
		name: "continual-evolve",
		args: ["mounted", { baseDir: "/tmp" }],
		...overrides,
	};
}

function makeDir(): string {
	return mkdtempSync(join(tmpdir(), "evolve-logfile-"));
}

describe("logRecord / renderArgs", () => {
	it("renders a JSONL record with ISO timestamp, type, name, and args", () => {
		const record = JSON.parse(logRecord(message())) as Record<string, unknown>;
		expect(record["ts"]).toBe("2026-08-15T00:00:00.000Z");
		expect(record["type"]).toBe("info");
		expect(record["name"]).toBe("continual-evolve");
		expect(record["args"]).toEqual(["mounted", { baseDir: "/tmp" }]);
	});

	it("renders errors with name, message, and stack", () => {
		const error = new Error("boom");
		const args = renderArgs([error]);
		expect(args[0]).toMatchObject({ name: "Error", message: "boom" });
		expect((args[0] as { stack?: string }).stack).toContain("boom");
	});

	it("survives circular objects", () => {
		const circular: Record<string, unknown> = {};
		circular["self"] = circular;
		const args = renderArgs([circular]);
		expect(typeof args[0]).toBe("string");
	});
});

describe("appendOrRotate", () => {
	it("creates the file with 0600 permissions and appends lines", () => {
		const dir = makeDir();
		try {
			const path = join(dir, "plugin.log");
			appendOrRotate(path, DEFAULT_LOG_MAX_BYTES, '{"a":1}');
			appendOrRotate(path, DEFAULT_LOG_MAX_BYTES, '{"b":2}');
			expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"b":2}\n');
			expect(statSync(path).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rotates the file to .1 when it exceeds maxBytes", () => {
		const dir = makeDir();
		try {
			const path = join(dir, "plugin.log");
			appendOrRotate(path, 10, "0123456789");
			// next append exceeds the threshold → rename to .1, fresh file
			appendOrRotate(path, 10, "0123456789");
			expect(readFileSync(`${path}.1`, "utf8")).toBe("0123456789\n");
			expect(readFileSync(path, "utf8")).toBe("0123456789\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("registerFileLogger", () => {
	it("registers an exporter that writes records to <baseDir>/evolve/plugin.log", () => {
		const dir = makeDir();
		try {
			let captured: { export(message: Parameters<typeof logRecord>[0]): void; levels?: Record<string, number> } | undefined;
			const ctx = {
				logger: {
					exporter(exporter: typeof captured) {
						captured = exporter;
					},
				},
			};
			const exporter = registerFileLogger(ctx as never, dir, { logLevel: 2 });
			expect(captured).toBe(exporter);
			expect(exporter.levels).toEqual({ default: 2 });

			exporter.export(message({ type: "warn", args: ["something smells"] }));
			const path = pluginLogFilePath(dir);
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path, "utf8")).toContain('"name":"continual-evolve"');
			expect(readFileSync(path, "utf8")).toContain("something smells");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("formatLogLine", () => {
	it("renders stored records back to human-readable lines", () => {
		const line = logRecord(message({ type: "error", args: ["failed", new Error("x")] }));
		const out = formatLogLine(line);
		expect(out).toContain("[E] continual-evolve failed");
		expect(out).toContain('"message":"x"');
	});

	it("passes unparseable lines through unchanged", () => {
		expect(formatLogLine("not json")).toBe("not json");
	});
});

describe("paths", () => {
	it("exposes the log file name and path", () => {
		expect(PLUGIN_LOG_FILE_NAME).toBe("plugin.log");
		expect(pluginLogFilePath("/base")).toBe(join("/base", "evolve", "plugin.log"));
	});
});
