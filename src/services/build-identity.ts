/**
 * Build identity: which generation of this plugin's code the running process
 * holds, versus what is on disk right now (ADR
 * `2026-10-18-absorb-memory-plugin-strengths`, borrowed from 灵枢's
 * `code_generation` / `disk_generation` self-check).
 *
 * The plugin is a long-lived process; `dsh plugin add` / `npm publish` /
 * `git pull` change files under it, and nothing on the host restarts it. Until
 * now the only way to tell was `ls -la lib/` plus a `host.log` line — this
 * module turns that into two hashes and a boolean.
 *
 * The loaded generation is computed once, at module import: that is the
 * moment the process took those bytes. The disk generation is re-read on
 * demand. They differ ⇒ the process is running stale code.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** What the process holds versus what the package directory holds. */
export interface BuildIdentity {
	/** Package version from `package.json` ("unknown" when unreadable). */
	version: string;
	/** Hash of the entry file at import time — the generation this process runs. */
	codeGeneration: string;
	/** Hash of the entry file on disk right now. */
	diskGeneration: string;
	/** Whether the two generations differ (the process is running stale code). */
	staleOnDisk: boolean;
	/** Same as {@link staleOnDisk}; the name the reader wants at the decision point. */
	restartRequired: boolean;
}

/** Marker used whenever a file cannot be read. */
export const UNKNOWN_GENERATION = "unknown";

/** Short, comparable hash of some bytes. */
function hashOf(bytes: string | Buffer): string {
	return createHash("sha1").update(bytes).digest("hex").slice(0, 12);
}

/**
 * The built entry file, resolved from this module's own location: the built
 * tree is `lib/services/build-identity.js` → `lib/index.js`. Under `tsx` the
 * source path has no sibling entry, so callers fall back to unknown.
 */
function defaultEntry(): string | undefined {
	try {
		return fileURLToPath(new URL("../index.js", import.meta.url));
	} catch {
		return undefined;
	}
}

/** Read a file's hash, or the unknown marker. */
function generationOf(file: string | undefined): string {
	if (file === undefined) {
		return UNKNOWN_GENERATION;
	}
	try {
		return hashOf(readFileSync(file));
	} catch {
		return UNKNOWN_GENERATION;
	}
}

/**
 * The generation this process imported. Computed at module load by design:
 * re-reading later would report the disk as "what we run", which is the exact
 * confusion this module exists to end.
 */
const LOADED_GENERATION = generationOf(defaultEntry());

/** The package version, read once (it cannot change while the process lives). */
function versionOf(): string {
	try {
		const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
			version?: unknown;
		};
		return typeof manifest.version === "string" ? manifest.version : UNKNOWN_GENERATION;
	} catch {
		return UNKNOWN_GENERATION;
	}
}

const LOADED_VERSION = versionOf();

/**
 * Compare a loaded generation with the current disk state.
 * @param entry - The entry file to re-read (undefined ⇒ unknown).
 * @param loaded - The generation computed at import time.
 * @param version - The package version to report.
 * @returns The identity, with `staleOnDisk` false whenever either side is unknown.
 */
export function identify(entry: string | undefined, loaded: string, version: string): BuildIdentity {
	const disk = generationOf(entry);
	const comparable = loaded !== UNKNOWN_GENERATION && disk !== UNKNOWN_GENERATION;
	const stale = comparable && loaded !== disk;
	return {
		version,
		codeGeneration: loaded,
		diskGeneration: disk,
		staleOnDisk: stale,
		restartRequired: stale,
	};
}

/**
 * The identity of the running plugin.
 * @returns Loaded generation (from import time), disk generation (now), and whether a restart is owed.
 */
export function buildIdentity(): BuildIdentity {
	return identify(defaultEntry(), LOADED_GENERATION, LOADED_VERSION);
}

/**
 * A one-line summary for the plugin log: stable when nothing changed, loud
 * when a restart is owed.
 * @returns The `plugin_log` message body.
 */
export function describeIdentity(identity: BuildIdentity): string {
	if (identity.staleOnDisk) {
		return `running ${identity.codeGeneration}, disk has ${identity.diskGeneration} (v${identity.version}) — restart the host to load it`;
	}
	return `running ${identity.codeGeneration} (v${identity.version}), disk matches`;
}
