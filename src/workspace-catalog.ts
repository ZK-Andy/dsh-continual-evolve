/**
 * The card's workspace catalog — which workspaces the card may read, and which
 * of them it lists.
 *
 * The list comes from the host's workspace registry (`ctx.workspaceRegistry`,
 * the durable records the workspace picker itself renders), not from the
 * sessions this process happened to serve: a card that only knows its own
 * session history can never offer ZCode's workspace switching — with one
 * served root the selector has nothing to switch to. The served-roots map
 * stays as a source (a session in a workspace the registry does not know about
 * still shows up), and `storages/workspace.json` is read only when the
 * registry service yields nothing: that file is an internal format, so it is a
 * fallback, never the primary.
 *
 * Two questions, deliberately answered by two methods. `known()` is the read
 * fence: can this root be read at all? `list()` is the display projection:
 * which workspaces have a memory directory right now? ZCode's viewer lists
 * only workspaces that have one, but the fence cannot be that filter — a store
 * deleted between listing and read must degrade to the empty state on its own
 * entry, not turn the read into a 404.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { KnownWorkspaces } from "./known-workspaces.js";
import { memoryDirFor } from "./memory-section.js";

/** One workspace the card knows: canonical root plus its display label. */
export interface CatalogEntry {
	root: string;
	/** Display title from the registry, else the directory name. */
	label: string;
}

/** The read fence (`known`) and the listed set (`list`). */
export interface WorkspaceCatalog {
	/** Every workspace the card may read, in registry order. */
	known(): CatalogEntry[];
	/** The known workspaces that currently have a memory directory. */
	list(): CatalogEntry[];
}

/** The slice of `ctx.workspaceRegistry` this plugin consumes. */
export interface WorkspaceRegistryLike {
	list(): unknown;
}

/** Where the catalog gets its workspace records, in precedence order. */
export interface WorkspaceCatalogOptions {
	/** Live registry lookup; undefined when the host exposes no registry. */
	registry?: (() => WorkspaceRegistryLike | undefined) | undefined;
	/** The roots this process served — the last-resort source. */
	served: KnownWorkspaces;
	/** Harness home; enables the `storages/workspace.json` fallback when set. */
	homeDir?: string | undefined;
}

/** The registry stores `fs.realpath` already; resolve the rest the same way. */
function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// A vanished or unreadable directory keeps its resolved spelling: the
		// registry itself never rewrites a record when its directory disappears.
		return resolve(path);
	}
}

/** One catalogue entry from a path/title pair, or undefined when unusable. */
function entryOf(path: unknown, title: unknown): CatalogEntry | undefined {
	if (typeof path !== "string" || path.trim().length === 0) {
		return undefined;
	}
	const root = canonicalPath(path);
	const label = typeof title === "string" && title.trim().length > 0 ? title.trim() : basename(root);
	return { root, label };
}

/** Records from the live registry service. */
function registryEntries(registry: WorkspaceRegistryLike | undefined): CatalogEntry[] {
	if (registry === undefined) {
		return [];
	}
	let records: unknown;
	try {
		records = registry.list();
	} catch {
		// A registry that throws is a host fault the card must not inherit:
		// the next source still fills the list.
		return [];
	}
	if (!Array.isArray(records)) {
		return [];
	}
	const entries: CatalogEntry[] = [];
	for (const record of records) {
		if (typeof record !== "object" || record === null) {
			continue;
		}
		const entry = entryOf((record as { path?: unknown }).path, (record as { title?: unknown }).title);
		if (entry !== undefined) {
			entries.push(entry);
		}
	}
	return entries;
}

/** Records from the registry's own durable file, for hosts without the service. */
function fileEntries(homeDir: string | undefined): CatalogEntry[] {
	if (homeDir === undefined || homeDir.trim().length === 0) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(homeDir, "storages", "workspace.json"), "utf8"));
	} catch {
		// Missing or unreadable file: no workspaces from this source, no throw.
		return [];
	}
	const table = (parsed as { tables?: { workspaces?: unknown } } | null)?.tables?.workspaces;
	if (typeof table !== "object" || table === null || Array.isArray(table)) {
		return [];
	}
	const entries: CatalogEntry[] = [];
	for (const record of Object.values(table as Record<string, unknown>)) {
		if (typeof record !== "object" || record === null) {
			continue;
		}
		const entry = entryOf((record as { path?: unknown }).path, (record as { title?: unknown }).title);
		if (entry !== undefined) {
			entries.push(entry);
		}
	}
	return entries;
}

/** Records from the roots this process served, most recent first. */
function servedEntries(served: KnownWorkspaces): CatalogEntry[] {
	return served.list().map(({ root }) => {
		const canonical = canonicalPath(root);
		return { root: canonical, label: basename(canonical) };
	});
}

/** ZCode's memory-directory rule: a plain directory, never a symlink. */
function hasMemoryDirectory(root: string): boolean {
	try {
		const stat = lstatSync(memoryDirFor(root));
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/** Deduplicate by canonical root, keeping the first (highest-precedence) entry. */
function dedupe(entries: CatalogEntry[]): CatalogEntry[] {
	const seen = new Set<string>();
	const unique: CatalogEntry[] = [];
	for (const entry of entries) {
		if (seen.has(entry.root)) {
			continue;
		}
		seen.add(entry.root);
		unique.push(entry);
	}
	return unique;
}

/** Create the catalog over the given sources. */
export function createWorkspaceCatalog(options: WorkspaceCatalogOptions): WorkspaceCatalog {
	const known = (): CatalogEntry[] => {
		const live = registryEntries(options.registry?.());
		if (live.length > 0) {
			return dedupe([...live, ...servedEntries(options.served)]);
		}
		return dedupe([...fileEntries(options.homeDir), ...servedEntries(options.served)]);
	};
	return {
		known,
		list() {
			return known().filter((entry) => hasMemoryDirectory(entry.root));
		},
	};
}
