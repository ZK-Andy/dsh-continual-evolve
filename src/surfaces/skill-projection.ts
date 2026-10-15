/**
 * The skill file projection: every active skill row materializes as a
 * `SKILL.md` the host skill loader discovers. The database is the source
 * of truth and these files are a read-only projection — writes here are
 * atomic (tmp + rename), patrol rewrites drifted files, and only files
 * carrying the generated marker are ever touched. Hand-written skills in
 * the same directories are never rewritten or removed.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	globalSkillsDir,
	projectSkillsDir,
	renderSkillMarkdown,
	SKILL_GENERATED_MARKER,
	skillDir,
	validateRenderedSkill,
} from "../skill-rules.js";
import type { PatrolResult, SkillFileWarning, SkillRecord } from "../store-types.js";
import { skillRecordOf, type SkillRow } from "../data/records.js";
import type { Repository } from "../data/repository.js";

/** The materialized directory for one skill partition (global vs project). */
export function skillRootOf(workspaceId: string): string {
	return workspaceId === "" ? globalSkillsDir() : projectSkillsDir(workspaceId);
}

/** Read a materialized file, undefined when missing or unreadable. */
function readSkillFile(root: string, id: string): string | undefined {
	let dir: string;
	try {
		dir = skillDir(root, id);
	} catch {
		return undefined;
	}
	try {
		return readFileSync(join(dir, "SKILL.md"), "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Write one active skill row as its SKILL.md (atomic tmp + rename so the
 * host watcher never sees a partial file). Returns materialization warnings —
 * the row already landed, so the caller surfaces them instead of failing.
 * @param root - The materialized skills directory.
 * @param record - The active skill row to project.
 * @returns File warnings; empty when the projection landed cleanly.
 */
export function writeSkillFile(root: string, record: SkillRecord): SkillFileWarning[] {
	const rendered = renderSkillMarkdown(record);
	const warnings = validateRenderedSkill(record).map((problem) => ({ id: record.id, warning: `skill ${record.id}: ${problem}` }));
	let dir: string;
	try {
		dir = skillDir(root, record.id);
	} catch (error) {
		return [{ id: record.id, warning: `skill ${record.id}: ${error instanceof Error ? error.message : String(error)}` }];
	}
	try {
		mkdirSync(dir, { recursive: true });
		const temp = join(dir, `SKILL.md.${process.pid}.tmp`);
		writeFileSync(temp, rendered, "utf8");
		renameSync(temp, join(dir, "SKILL.md"));
	} catch (error) {
		warnings.push({
			id: record.id,
			warning: `skill ${record.id}: file write failed, patrol will retry: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
	return warnings;
}

/**
 * Remove one skill's materialized directory after its row left the active
 * set. Only files carrying the generated marker are removed — a hand-written
 * skill that happens to share the directory is left in place with a warning.
 * @param root - The materialized skills directory.
 * @param id - The skill id whose directory may go.
 * @returns File warnings; empty when nothing needed doing.
 */
export function removeSkillFile(root: string, id: string): SkillFileWarning[] {
	let dir: string;
	try {
		dir = skillDir(root, id);
	} catch (error) {
		return [{ id, warning: `skill ${id}: ${error instanceof Error ? error.message : String(error)}` }];
	}
	let current: string;
	try {
		current = readFileSync(join(dir, "SKILL.md"), "utf8");
	} catch {
		return [];
	}
	if (!current.includes(SKILL_GENERATED_MARKER)) {
		return [{ id, warning: `skill ${id}: ${join(dir, "SKILL.md")} is hand-written, left in place` }];
	}
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch (error) {
		return [{ id, warning: `skill ${id}: file removal failed, patrol will retry: ${error instanceof Error ? error.message : String(error)}` }];
	}
	return [];
}

/**
 * Bring every managed SKILL.md back in line with the store: rewrite
 * missing or drifted files, drop orphan managed files. Only files
 * carrying the generated marker are ever written or removed.
 * @param skills - The skills repository.
 * @param result - The patrol result accumulating counts.
 */
export function reconcileSkillFiles(skills: Repository<SkillRow>, result: PatrolResult): void {
	const active = skills.activeRowList();
	for (const row of active) {
		const record = skillRecordOf(row);
		const root = skillRootOf(record.workspaceId);
		let current: string | undefined;
		try {
			current = readSkillFile(root, record.id);
		} catch {
			current = undefined;
		}
		if (current === renderSkillMarkdown(record)) {
			continue;
		}
		try {
			const problems = writeSkillFile(root, record);
			if (problems.length === 0) {
				result.skillFilesReconciled += 1;
			} else {
				result.skillFileErrors += 1;
			}
		} catch {
			result.skillFileErrors += 1;
		}
	}
	const roots = new Map<string, string>();
	for (const row of active) {
		roots.set(skillRootOf(row.workspace_id), row.workspace_id);
	}
	roots.set(skillRootOf(""), "");
	for (const [root, partition] of roots) {
		let names: string[];
		try {
			names = readdirSync(root, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			continue;
		}
		for (const name of names) {
			let content: string;
			try {
				content = readFileSync(join(root, name, "SKILL.md"), "utf8");
			} catch {
				continue;
			}
			if (!content.includes(SKILL_GENERATED_MARKER)) {
				continue;
			}
			const row = skills.getRow(partition, name);
			if (row !== undefined && row.status === "active") {
				continue;
			}
			try {
				rmSync(join(root, name), { recursive: true, force: true });
				result.skillOrphanFilesRemoved += 1;
			} catch {
				result.skillFileErrors += 1;
			}
		}
	}
}
