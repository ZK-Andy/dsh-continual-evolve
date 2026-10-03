/**
 * `/evolve` runtime subcommands: pause/resume the automatic extraction
 * moments, render the listener/store status, and the per-entry injection +
 * token usage report.
 */
import type { HarnessState, RefinementKind } from "./types.js";
import type { EvolutionEngine } from "./service.js";
import { loadUsage, getUsageCount } from "./usage.js";
import { loadGateRuntime, saveGateRuntime } from "./runtime.js";
import { loadTokenUsage, renderTokenUsageReport } from "./token-usage.js";
import { success, type CommandRuntimeOptions, type CommandTextResult } from "./command-util.js";

/** `/evolve pause|resume` — the runtime switch is independent of registration. */
export function executePauseResumeCommand(engine: EvolutionEngine, sub: "pause" | "resume", runtime: CommandRuntimeOptions): CommandTextResult {
	const pausing = sub === "pause";
	const defaultEnabled = runtime.autoReview ?? false;
	const current = loadGateRuntime(engine.baseDir, defaultEnabled);
	if (pausing && current.paused) {
		return success("automatic Memory Agent is already paused (no change).");
	}
	if (!pausing && current.enabled && !current.paused) {
		return success("automatic Memory Agent is already running (no change).");
	}
	saveGateRuntime(engine.baseDir, pausing, pausing ? current.enabled : true);
	return success(
		pausing
			? "automatic Memory Agent paused: no automatic memory extraction calls until /evolve resume. Manual evolve_* tools and /evolve commands keep working."
			: "automatic Memory Agent resumed: extraction moments (compaction / goal-blocked / session-close drain) are live again.",
	);
}

/** `/evolve status` — listener wiring plus per-store entry counts and retention. */
export function executeStatusCommand(engine: EvolutionEngine, sessionId: string, projectKey: string | undefined, runtime: CommandRuntimeOptions): CommandTextResult {
	const configuredDefault = runtime.autoReview === undefined ? "unknown" : runtime.autoReview ? "on" : "off";
	const current = loadGateRuntime(engine.baseDir, runtime.autoReview ?? false);
	const effective = current.paused
		? "PAUSED (resume with /evolve resume)"
		: current.enabled
			? "Memory Agent running"
			: "Memory Agent off (enable with /evolve resume)";
	const gateLine = `gate: moment-driven Memory Agent listener registered · config default ${configuredDefault} · runtime ${effective}`;
	const countEntries = (state: HarnessState): number => Object.values(state.entries).reduce((n, byKind) => n + Object.keys(byKind).length, 0);
	const lines = [gateLine];
	lines.push(`stores: global ${countEntries(engine.load("global", undefined))} entries · local(${sessionId}) ${countEntries(engine.load("local", sessionId))} entries`);
	if (projectKey) {
		try {
			lines[lines.length - 1] += ` · project ${countEntries(engine.load("project", projectKey))} entries`;
		} catch {
			lines[lines.length - 1] += " · project (unavailable)";
		}
	}
	const retention = engine.retention;
	if (retention) {
		lines.push(
			`retention: snapshots ${retention.snapshots} · refinements ${retention.refinements} · reviews ${retention.reviews} · token usage ${retention.tokenUsage} (historyRetain)`,
		);
	}
	return success(lines.join("\n"));
}

/**
 * `/evolve usage` — injection counts per entry across the stores the human
 * can see (global + this session + this project), plus the exact direct-call
 * token report. Counts are per-session since the v2 usage shape — "in how
 * many sessions did this entry surface".
 */
export function executeUsageCommand(engine: EvolutionEngine, sessionId: string, projectKey: string | undefined): CommandTextResult {
	const store = loadUsage(engine.baseDir);
	const rows: { key: string; title: string; count: number; lastSession?: string }[] = [];
	const seen = new Set<string>();
	const collect = (state: HarnessState): void => {
		for (const kind of Object.keys(state.entries) as RefinementKind[]) {
			for (const entry of Object.values(state.entries[kind])) {
				const key = `${kind}:${entry.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const count = getUsageCount(store, kind, entry.id);
				rows.push({
					key,
					title: entry.title,
					count,
					...(store.lastSession?.[`${kind}:${entry.id}`] ? { lastSession: store.lastSession[`${kind}:${entry.id}`] } : {}),
				});
			}
		}
	};
	collect(engine.load("global", undefined));
	collect(engine.load("local", sessionId));
	if (projectKey) {
		try {
			collect(engine.load("project", projectKey));
		} catch {
			// project store unavailable here — global+local still report
		}
	}
	const liveKeys = new Set(rows.map((r) => r.key));
	const orphaned = Object.keys(store.counts).filter((k) => !liveKeys.has(k)).length;
	const total = rows.reduce((n, r) => n + r.count, 0);
	const injected = rows.filter((r) => r.count > 0).sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
	const stale = rows.filter((r) => r.count === 0).sort((a, b) => (a.key < b.key ? -1 : 1));
	const lines = [`injected entries: ${total} injections across ${injected.length} of ${rows.length} stored entries${orphaned > 0 ? ` (+${orphaned} historical key(s) for deleted entries)` : ""}`];
	if (injected.length > 0) {
		lines.push("injected (top 15):");
		for (const row of injected.slice(0, 15)) {
			lines.push(`  ${row.key} — ${row.count}× · ${row.title}${row.lastSession ? ` (last in ${row.lastSession})` : ""}`);
		}
		if (injected.length > 15) {
			lines.push(`  … and ${injected.length - 15} more`);
		}
	} else {
		lines.push("injected: (none yet — nothing has surfaced into a session prompt)");
	}
	if (stale.length > 0) {
		lines.push(`never injected (${stale.length}):`);
		for (const row of stale.slice(0, 20)) {
			lines.push(`  ${row.key} · ${row.title}`);
		}
		if (stale.length > 20) {
			lines.push(`  … and ${stale.length - 20} more`);
		}
	}
	lines.push("", ...renderTokenUsageReport(loadTokenUsage(engine.baseDir), engine.retention.tokenUsage));
	return success(lines.join("\n"));
}
