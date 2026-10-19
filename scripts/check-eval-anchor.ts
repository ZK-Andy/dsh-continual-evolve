#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * External-anchor staleness check (P5a): the online four-arm / external runs
 * stay manual (they spend tokens — CI must never auto-spend), but expiry
 * goes red twice: the card (store state, every session) and this scheduled
 * check (git log of committed reports, monthly).
 *
 * Thresholds (P5a拍板）: past 60 days warn, past 67 days (60 + 7 grace) fail.
 * Never anchored reads as a warning, never as a failure — a fresh checkout
 * must not start red.
 *
 * Usage: tsx scripts/check-eval-anchor.ts [--runs DIR] [--now ISO]
 * Exit code 0 = ok or warning, 1 = overdue.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const ANCHOR_WARN_DAYS = 60;
export const ANCHOR_FAIL_DAYS = 67;

export interface AnchorCheck {
	readonly ok: boolean;
	readonly level: "ok" | "warn" | "fail";
	readonly reason: string;
}

/** Pure check (importable by tests): days since the last anchor decide. */
export function checkAnchorDays(daysSince: number | undefined): AnchorCheck {
	if (daysSince === undefined) {
		return { ok: true, level: "warn", reason: "no external anchor yet — schedule the first one" };
	}
	if (daysSince > ANCHOR_FAIL_DAYS) {
		return { ok: false, level: "fail", reason: `external anchor ${String(daysSince)}d ago — over the 67d limit, run it` };
	}
	if (daysSince > ANCHOR_WARN_DAYS) {
		return { ok: true, level: "warn", reason: `external anchor ${String(daysSince)}d ago — past the 60d window` };
	}
	return { ok: true, level: "ok", reason: `external anchor ${String(daysSince)}d ago` };
}

/** Latest committed external-anchor date under runs, via git log (clone-safe). */
function latestAnchorDate(runsDir: string): string | undefined {
	const files: string[] = [];
	const walk = (dir: string): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const full = join(dir, name);
			try {
				if (statSync(full).isDirectory()) {
					walk(full);
				} else if (name.startsWith("external-") && name.endsWith(".md")) {
					files.push(full);
				}
			} catch {
				// Unreadable files are not evidence; skip them.
			}
		}
	};
	walk(runsDir);
	let latest: string | undefined;
	for (const file of files) {
		try {
			const date = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], { encoding: "utf8" }).trim();
			if (date.length > 0 && (latest === undefined || date > latest)) {
				latest = date;
			}
		} catch {
			// Untracked files have no log date; skip them.
		}
	}
	return latest;
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
	const root = join(import.meta.dirname, "..");
	const runsDir = argValue("--runs") ?? join(root, "evals", "runs");
	const nowMs = Date.parse(argValue("--now") ?? new Date().toISOString());
	const latest = latestAnchorDate(runsDir);
	const daysSince = latest === undefined ? undefined : Math.max(0, Math.floor((nowMs - Date.parse(latest)) / 86400000));
	const check = checkAnchorDays(Number.isNaN(daysSince as number) ? undefined : daysSince);
	console.log(`${check.level.toUpperCase()}: ${check.reason}`);
	return check.ok ? 0 : 1;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	},
);
