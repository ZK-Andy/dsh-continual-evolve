/**
 * Plugin-owned file logging: a cordis logger exporter that appends every
 * log message — from this plugin or any other — to a JSONL file under the
 * evolve store. Logging becomes a property of the plugin itself: no extra
 * component to install, and it works no matter how `dsh web` is launched
 * (foreground terminal, nohup, restart scripts, ...). The official
 * `cordis-plugin-logger-console` remains an optional add-on for live
 * terminal output; this file exporter is the baseline that always exists.
 *
 * - file: `<baseDir>/evolve/plugin.log` (0600, JSONL)
 * - rotation: when the file exceeds `logMaxBytes` it is renamed to
 *   `plugin.log.1` (replacing the previous `.1`)
 * - level: `levels.default` = logLevel (0=error, 1=info, 2=warn, 3=debug)
 * - failure containment: a write error is swallowed — logging never
 *   disturbs the agent loop
 */
import type { Context } from "@deepseek-ai/cordis";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Name of the plugin log file under `<baseDir>/evolve/`. */
export const PLUGIN_LOG_FILE_NAME = "plugin.log";
/** Default rotation threshold (5 MiB). */
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface FileLoggerConfig {
	/** 0=error, 1=info, 2=warn, 3=debug. */
	logLevel?: number;
	/** Rotate the log when it exceeds this many bytes. */
	logMaxBytes?: number;
}

/** Full path of the plugin log file. */
export function pluginLogFilePath(baseDir: string): string {
	return join(baseDir, "evolve", PLUGIN_LOG_FILE_NAME);
}

/** JSON-safe rendering of a log message's arguments. */
export function renderArgs(args: readonly unknown[]): unknown[] {
	return args.map((arg) => {
		if (arg instanceof Error) {
			return { name: arg.name, message: arg.message, stack: arg.stack };
		}
		if (typeof arg === "object" && arg !== null) {
			try {
				return JSON.parse(JSON.stringify(arg)) as unknown;
			} catch {
				return String(arg);
			}
		}
		return arg;
	});
}

/** One JSONL record as written to the log file. */
export function logRecord(message: {
	ts: number;
	type: string;
	name: string;
	args: readonly unknown[];
}): string {
	return JSON.stringify({
		ts: new Date(message.ts).toISOString(),
		type: message.type,
		name: message.name,
		args: renderArgs(message.args),
	});
}

/** Human-readable rendering of one stored JSONL line (unparseable lines pass through). */
export function formatLogLine(line: string): string {
	try {
		const record = JSON.parse(line) as { ts?: string; type?: string; name?: string; args?: unknown[] };
		const ts = record.ts ?? "";
		const type = record.type ? `[${record.type[0]?.toUpperCase() ?? "?"}]` : "[?]";
		const name = record.name ?? "";
		const args = Array.isArray(record.args)
			? record.args.map((arg) => (typeof arg === "object" && arg !== null ? JSON.stringify(arg) : String(arg))).join(" ")
			: "";
		return `${ts} ${type} ${name} ${args}`.trimEnd();
	} catch {
		return line;
	}
}

/** Append one line, rotating the file first when it exceeds maxBytes. */
export function appendOrRotate(path: string, maxBytes: number, line: string): void {
	const dir = dirname(path);
	if (!existsSync(path)) {
		mkdirSync(dir, { recursive: true });
		// 0600: the log can carry session context and must not be world-readable
		writeFileSync(path, "", { encoding: "utf8", mode: 0o600 });
	}
	if (maxBytes > 0) {
		try {
			if (statSync(path).size > maxBytes) {
				renameSync(path, `${path}.1`);
			}
		} catch {
			// stat/rename failures fall through to the append attempt
		}
	}
	appendFileSync(path, `${line}\n`, "utf8");
}

/**
 * Register the file exporter on the context. Returns the exporter so tests
 * can drive it directly. The exporter is disposed with the plugin's scope.
 */
export function registerFileLogger(ctx: Context, baseDir: string, config: FileLoggerConfig = {}) {
	const path = pluginLogFilePath(baseDir);
	const maxBytes = config.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES;
	const exporter = {
		levels: { default: config.logLevel ?? 1 },
		export(message: { ts: number; type: string; name: string; args: readonly unknown[] }) {
			try {
				appendOrRotate(path, maxBytes, logRecord(message));
			} catch {
				// logging must never disturb the agent loop
			}
		},
	};
	ctx.logger.exporter(exporter);
	return exporter;
}
