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
	filterLogBySession,
	formatLogLine,
	logRecord,
	pluginLogFilePath,
	registerFileLogger,
	renderArgs,
	sessionIdsInLine,
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
		expect(record["message"]).toBe('mounted {"baseDir":"/tmp"}');
	});

	it("renders printf placeholders (%o, %s) into the message field", () => {
		const record = JSON.parse(
			logRecord({ ts: 1, type: "info", name: "hmr", args: ["watching %o", []] }),
		) as Record<string, unknown>;
		expect(record["message"]).toBe("watching []");
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
		const line = logRecord(message({ type: "error", args: ["failed", new Error("boom")] }));
		const out = formatLogLine(line);
		expect(out).toContain("[E] continual-evolve failed");
		expect(out).toContain("boom");
	});

	it("prefers the rendered message field over raw args", () => {
		const line = logRecord({ ts: 1, type: "info", name: "hmr", args: ["watching %o", []] });
		const out = formatLogLine(line);
		expect(out).toContain("[I] hmr watching []");
		expect(out).not.toContain("%o");
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

describe("sessionIdsInLine / filterLogBySession", () => {
	const lineA = logRecord({
		ts: 1,
		type: "info",
		name: "continual-evolve",
		args: ["auto-review declined (turn_interval) [session-abc123] after 6 turns: nothing durable"],
	});
	const lineB = logRecord({
		ts: 2,
		type: "info",
		name: "continual-evolve",
		args: ["mounted skill", { sessionId: "session-def456" }],
	});
	const lineC = logRecord({ ts: 3, type: "info", name: "hmr", args: ["watching %o", []] });

	it("extracts distinct session tokens from message and args", () => {
		expect(sessionIdsInLine(lineA)).toEqual(["session-abc123"]);
		expect(sessionIdsInLine(lineB)).toEqual(["session-def456"]);
		expect(sessionIdsInLine(lineC)).toEqual([]);
	});

	it("filters lines by exact session token (no substring matches)", () => {
		const lines = [lineA, lineB, lineC];
		expect(filterLogBySession(lines, "session-abc123")).toEqual([lineA]);
		expect(filterLogBySession(lines, "session-abc")).toEqual([]); // prefix is not a match
		expect(filterLogBySession(lines, "session-def456")).toEqual([lineB]);
	});

	it("filters nothing for an empty session id and passes unparseable lines through a raw scan", () => {
		expect(filterLogBySession([lineA], "  ")).toEqual([]);
		expect(sessionIdsInLine("raw line session-00ff99")).toEqual(["session-00ff99"]);
	});
});
