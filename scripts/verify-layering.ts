#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify layering semantics (docs/architecture-standard.md §1): every relative
 * import edge is explicitly listed (R1 — the two assembly files carry explicit
 * edges too, no wildcard privileges); SQL and table-name literals live only in
 * `src/data` (R2); volatile config reads (`config.X?.y?.get(`) stay in
 * `src/index.ts` (R3); the src root holds exactly the four assembly/shape
 * files (R4 — every file has a home, no new root central contracts). R5
 * (client function hard 80) is owned by `verify-src-budgets.ts`.
 *
 * New files must extend EDGES below — an unlisted file or edge fails the
 * gate. Line counts use wc -l semantics (newline characters).
 *
 * Usage: tsx scripts/verify-layering.ts [src_root]
 * Exit code 0 = pass, 1 = violations found.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT_FILES = ["assemble.ts", "index.ts", "store.ts", "store-types.ts"];

/**
 * Explicitly allowed relative edges, as src-relative module paths without
 * extension. Type-only edges count (they still declare a layer direction);
 * the one noted exception is marked inline.
 */
const EDGES: Record<string, readonly string[]> = {
	"assemble.ts": [
		"index",
		"services/extraction",
		"services/extraction-surface",
		"services/llm-call",
		"services/model-route",
		"services/plugin-log",
		"services/review",
		"services/review-scheduler",
		"store",
		"surfaces/evolve-tools",
		"surfaces/skill-provider",
	],
	// The account layer's single import site for the store assembly.
	"data/database.ts": [],
	"data/archive-backfill.ts": [],
	"data/search-query.ts": [],
	"data/ledger.ts": ["store-types"],
	"data/migrate.ts": ["data/injection-log", "data/schema", "store-types"],
	"data/patrol.ts": ["data/records", "data/repository", "data/secret", "store-types"],
	"data/records.ts": [],
	"data/repository.ts": ["data/records", "data/resource-kinds", "data/search-query"],
	// Type-only back edge (erased at compile): the descriptor file names the
	// repository's ResourceKind contract it is written against.
	"data/resource-kinds.ts": ["data/repository"],
	"data/review-accounts.ts": ["data/records", "data/repository", "data/secret", "store-types"],
	// Guarded table shapes: the DDL single source, the drift probe, and the rebuild.
	"data/schema.ts": ["data/item-events", "data/records", "data/review-accounts", "store-types"],
	// The review queue's event tier, its writer, and the derived settled streak.
	"data/item-events.ts": ["data/review-accounts"],
	// Injection ledger: one row per session, pruned with the other ledgers.
	"data/injection-log.ts": ["data/records"],
	// Usage counters: one aggregate row per kind, bumped by served bodies only.
	"data/usage-accounts.ts": ["data/records", "data/repository", "store-types"],
	"data/secret.ts": [],
	"index.ts": [
		"assemble",
		"pages/memory-card/mount",
		"pages/memory-card/settings",
		"services/build-identity",
		"services/import-md",
		"services/plugin-log",
		"services/retention",
		"services/review",
		"services/token-budget",
		"store",
		"surfaces/memory-section",
	],
	"pages/memory-card/card-http.ts": [],
	"pages/memory-card/card-routes.ts": [
		"pages/memory-card/card-http",
		"pages/memory-card/prompt-routes",
		"pages/memory-card/settings",
		"pages/memory-card/workspace-hint",
		"store",
		"surfaces/memory-snapshot",
		"surfaces/skill-snapshot",
	],
	"pages/memory-card/mount.ts": [
		"index",
		"pages/memory-card/card-routes",
		"pages/memory-card/settings",
		"pages/memory-card/workspace-hint",
		"services/plugin-log",
		"store",
	],
	"pages/memory-card/prompt-routes.ts": [
		"pages/memory-card/card-http",
		"store",
		"surfaces/prompt-snapshot",
	],
	"pages/memory-card/settings.ts": ["pages/memory-card/card-http"],
	"pages/memory-card/workspace-hint.ts": [],
	"services/agent.ts": [],
	"services/chain.ts": [],
	"services/extraction.ts": [
		"services/extraction-failure",
		"services/agent",
		"services/extraction-item",
		"services/extraction-ring",
		"services/extraction-surface",
		"services/llm-call",
		"services/model-route",
		"services/plugin-log",
		"store",
	],
	// The route-failure record: the backoff ladder and the state rows it lives in.
	"services/extraction-failure.ts": ["services/llm-call", "services/plugin-log", "store", "store-types"],
	"services/extraction-prompt.ts": [],
	// The run vocabulary both the ring and the proposal link share (leaf: no value imports).
	"services/extraction-item.ts": [
		"services/extraction",
		"services/extraction-prompt",
		"services/model-route",
		"services/subagent",
		"store",
	],
	"services/extraction-propose.ts": [
		"services/chain",
		"services/extraction-item",
		"services/extraction-prompt",
		"services/extraction-screen",
		"services/llm-call",
		"services/retention",
		"services/subagent",
		"services/subagent-defs",
		"store",
	],
	"services/extraction-ring.ts": [
		"services/chain",
		"services/extraction",
		"services/extraction-item",
		"services/extraction-prompt",
		"services/extraction-propose",
		"services/extraction-surface",
		"services/llm-call",
		"services/model-route",
		"services/prompt-date",
		"services/subagent",
		"services/subagent-defs",
	],
	"services/extraction-surface.ts": [],
	"services/import-md.ts": ["services/memory-rules", "store"],
	"services/llm-call.ts": ["services/model-route"],
	"services/memory-apply.ts": [
		"data/ledger",
		"data/records",
		"data/repository",
		"services/extraction-prompt",
		"services/memory-linkage",
		"services/memory-merge",
		"services/memory-rules",
		"store-types",
	],
	// The linkage a landed memory write causes (queue events, not gate work).
	"services/memory-linkage.ts": ["data/records", "data/repository", "store-types"],
	// Same-session duplicate merges: mechanical version rows, no model calls.
	"services/memory-merge.ts": [
		"data/records",
		"data/repository",
		"services/memory-linkage",
		"services/memory-rules",
		"services/pre-screen",
		"store-types",
	],
	"services/memory-rules.ts": ["data/secret"],
	// The route candidates a direct call resolves through (see `model-route.ts`).
	"services/model-route.ts": [],
	"services/plugin-log.ts": ["services/retention", "store"],
	"services/prompt-apply.ts": [
		"data/ledger",
		"data/records",
		"data/repository",
		"services/memory-apply",
		"services/memory-rules",
		"services/prompt-rules",
		"store-types",
	],
	"services/prompt-date.ts": [],
	"services/prompt-rules.ts": ["data/secret", "services/memory-rules"],
	"services/retention.ts": ["services/extraction-failure", "store"],
	"services/review.ts": [
		"services/agent",
		"services/chain",
		"services/llm-call",
		"services/extraction-failure",
		"services/model-route",
		"services/plugin-log",
		"services/prompt-date",
		"services/review-candidates",
		"services/review-ring",
		"services/token-usage",
		"store",
		"store-types",
	],
	"services/review-candidates.ts": ["services/review", "store"],
	// The review track's triggers, pacing, route, and refusal halt.
	"services/review-scheduler.ts": [
		"services/agent",
		"services/extraction-failure",
		"services/llm-call",
		"services/model-route",
		"services/plugin-log",
		"services/prompt-date",
		"services/review",
		"services/review-candidates",
		"services/review-ring",
		"store-types",
	],
	"services/review-prompt.ts": [],
	"services/review-ring.ts": [
		"services/chain",
		"services/llm-call",
		"services/model-route",
		"services/review",
		"services/review-prompt",
		"services/review-row",
		"services/review-tiering",
		"services/subagent",
		"services/subagent-defs",
		"services/token-usage",
		"store",
	],
	// The verdict-row helpers both landing paths share (no ring import cycle).
	"services/review-row.ts": ["services/review-prompt", "services/review", "store"],
	// The tiering exits: archive / promote / demote / probation resolution.
	"services/review-tiering.ts": ["services/review-prompt", "services/review-ring", "services/review-row"],
	"data/tiering.ts": ["data/records", "data/repository"],
	"data/accounts.ts": ["data/injection-log", "data/item-events", "data/review-accounts", "data/tiering", "data/usage-accounts"],
	"services/skill-apply.ts": [
		"data/ledger",
		"data/records",
		"data/repository",
		"services/memory-apply",
		"services/memory-rules",
		"services/skill-rules",
		"store-types",
	],
	"services/skill-files.ts": [
		"data/records",
		"data/repository",
		"services/skill-rules",
		"store-types",
	],
	"services/skill-rules.ts": ["data/secret", "services/memory-rules"],
	"services/subagent.ts": ["services/llm-call", "services/model-route"],
	"services/subagent-defs.ts": [
		"services/extraction-prompt",
		"services/prompt-date",
		"services/review-prompt",
		"services/subagent",
	],
	"services/token-usage.ts": [],
	"store.ts": [
		"data/accounts",
		"data/database",
		"data/ledger",
		"data/migrate",
		"data/patrol",
		"data/records",
		"data/repository",
		"services/memory-apply",
		"services/prompt-apply",
		"services/skill-apply",
		"services/skill-files",
		"store-types",
	],
	"store-types.ts": [
		"data/item-events",
		"data/records",
		"data/review-accounts",
		"data/tiering",
		"services/memory-apply",
		"services/memory-rules",
		"services/prompt-rules",
		"services/skill-rules",
	],
	"surfaces/evolve-fields.ts": [],
	"surfaces/evolve-memory.ts": ["store", "surfaces/evolve-fields"],
	"surfaces/evolve-prompts.ts": ["store", "surfaces/evolve-fields"],
	"surfaces/evolve-skills.ts": ["services/skill-rules", "store", "surfaces/evolve-fields"],
	"surfaces/evolve-tools.ts": [
		"services/agent",
		"store",
		"surfaces/evolve-fields",
		"surfaces/evolve-memory",
		"surfaces/evolve-prompts",
		"surfaces/evolve-skills",
		"surfaces/memory-section",
	],
	"surfaces/memory-guide.ts": [],
	"surfaces/memory-section.ts": ["services/agent", "services/token-budget", "store", "surfaces/memory-guide"],
	"surfaces/memory-snapshot.ts": ["services/build-identity", "services/injection-stats", "store"],
	"surfaces/skill-snapshot.ts": ["services/skill-rules", "store", "surfaces/memory-snapshot"],
	"surfaces/prompt-snapshot.ts": ["store"],
	"services/build-identity.ts": [],
	"services/injection-stats.ts": ["store-types"],
	"services/pre-screen.ts": ["services/memory-rules", "services/token-budget"],
	"services/extraction-screen.ts": ["services/memory-rules", "services/pre-screen", "store-types"],
	"services/token-budget.ts": [],
	"surfaces/skill-provider.ts": [],
};

const STATIC_IMPORT_RE = /^[ \t]*import\s+(?:[^;"']*?\sfrom\s+)?["'](\.[^"']+)["']/gm;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;
const REEXPORT_RE = /^[ \t]*export\s+[^;]*?\sfrom\s+["'](\.[^"']+)["']/gm;

/** Distinct relative specifiers one file imports (static, dynamic, re-export). */
function specifiersOf(text: string): string[] {
	const seen = new Set<string>();
	for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE, REEXPORT_RE]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			if (m[1] !== undefined) seen.add(m[1]);
		}
	}
	return [...seen];
}

/** Resolve a relative specifier to a src-relative module path without extension. */
function resolveEdge(root: string, importerRel: string, spec: string): string {
	const base = spec.replace(/\.js$/, "");
	const abs = join(root, dirname(importerRel), base);
	return relative(root, abs);
}

/** Strip line and block comments (SQL lives in string literals, never in comments). */
function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[ \t])\/\/.*$/gm, "$1");
}

const TABLES = [
	"memories",
	"skills",
	"prompts",
	"memories_fts",
	"skills_fts",
	"prompts_fts",
	"extraction_log",
	"skill_log",
	"prompt_log",
	"review_log",
	"review_daily",
	"plugin_log",
	"state",
];
const SQL_RE = new RegExp(
	`\\b(SELECT|INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|CREATE\\s+TABLE|DROP\\s+TABLE|ALTER\\s+TABLE)\\b[^\\n]*\\b(${TABLES.join("|")})\\b`,
	"i",
);
const CONFIG_GET_RE = /config\.\w+\?\.\w+\?\.get\(/;

function collectTs(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) collectTs(full, out);
		else if (name.endsWith(".ts")) out.push(full);
	}
	return out;
}

function main(): number {
	const root = process.argv[2] ?? "src";
	let files: string[];
	try {
		if (!statSync(root).isDirectory()) {
			console.log(`SKIP: ${root} does not exist (no src tree)`);
			return 0;
		}
		files = collectTs(root).sort();
	} catch {
		console.log(`SKIP: ${root} does not exist (no src tree)`);
		return 0;
	}
	const errors: string[] = [];
	// R4: the src root holds exactly the assembly and shape files.
	for (const file of files) {
		const rel = relative(".", file);
		if (dirname(rel) === root || (root === "src" && dirname(rel) === ".")) {
			const base = rel.slice(rel.lastIndexOf("/") + 1);
			if (!ROOT_FILES.includes(base)) {
				errors.push(`${rel}: R4 root holds only ${ROOT_FILES.join(", ")} — move this file to its layer`);
			}
		}
	}
	for (const file of files) {
		const rel = relative(".", file);
		const key = relative(root, file).replace(/\\/g, "/");
		const text = readFileSync(file, "utf-8");
		// R1: every edge is listed; unlisted files must register first.
		const allowed = EDGES[key];
		if (allowed === undefined) {
			errors.push(`${rel}: R1 file not in the edge map — register its layer edges in scripts/verify-layering.ts`);
			continue;
		}
		for (const spec of specifiersOf(text)) {
			const target = resolveEdge(root, key, spec).replace(/\\/g, "/");
			if (!allowed.includes(target)) {
				errors.push(`${rel}: R1 unlisted edge to ${target} — register it or move the dependency`);
				continue;
			}
			try {
				statSync(join(root, `${target}.ts`));
			} catch {
				errors.push(`${rel}: R1 dangling edge to ${target} (no such module)`);
			}
		}
		// R2: SQL and table literals live only in src/data.
		if (!key.startsWith("data/")) {
			if (SQL_RE.test(stripComments(text))) {
				errors.push(`${rel}: R2 SQL/table literal outside src/data — sink the statement into the data layer`);
			}
		}
		// R3: volatile config reads stay in the assembly root.
		if (key !== "index.ts" && CONFIG_GET_RE.test(text)) {
			errors.push(`${rel}: R3 config.X?.y?.get( outside src/index.ts — unpack volatile config only in the assembly root`);
		}
	}
	console.log(`Checked ${files.length} src modules`);
	for (const e of errors) console.log(`FAIL: ${e}`);
	return errors.length > 0 ? 1 : 0;
}

process.exitCode = main();
