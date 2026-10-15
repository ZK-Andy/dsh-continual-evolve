/**
 * The skill write gate: validate one skill proposal and land it. The batch
 * (transaction, file intents, ledger) stays with the store assembly; this
 * module owns per-proposal validation and row mutation, mirroring
 * `memory-apply.ts` for memories. Nothing reaches the database without the
 * mechanical gates in `skill-rules.ts`.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { ProposalContext } from "./memory-apply.js";
import type { SkillFields, SkillProposal } from "./skill-rules.js";
import { isValidMemoryId } from "./memory-rules.js";
import { skillFieldGateReasons, slugifySkillId } from "./skill-rules.js";
import type { LedgerFile, SkillFileWarning, SkillRecord, SkillProposalOutcome } from "../store-types.js";
import { writeSkillLedger } from "../data/ledger.js";
import { skillRecordOf, type SkillRow } from "../data/records.js";
import type { Repository } from "../data/repository.js";

/** A skill mutation's audit payload (action/record pinned, shape shared). */
export type SkillLedgerFile = LedgerFile<SkillProposal["action"], SkillRecord>;

/** A post-commit file operation (files sync after COMMIT, never fail the batch). */
export interface SkillFileIntent {
	partition: string;
	id: string;
	op: "write" | "remove";
}

/** The proposal id, derived from the title (slug, CJK-hash fallback) on create. */
function skillIdFor(proposal: SkillProposal): string {
	if (proposal.id !== undefined && proposal.id.trim().length > 0) {
		return proposal.id.trim();
	}
	if (proposal.action === "create" && typeof proposal.title === "string") {
		return slugifySkillId(proposal.title);
	}
	return "";
}

/** The scope update/delete targets (`global` only when asked for). */
function skillScopeOf(proposal: SkillProposal): string | { reason: string } {
	if (proposal.scope !== undefined && proposal.scope !== "project" && proposal.scope !== "global") {
		return { reason: `scope must be "project" or "global", got "${proposal.scope}"` };
	}
	return proposal.scope ?? "project";
}

/** The partition a scope names: global rows live in `""`, project rows in the context workspace. */
function skillPartitionOf(ctx: ProposalContext, scope: string): string {
	return scope === "global" ? "" : ctx.workspaceId;
}

function skillFail(proposal: SkillProposal, reason: string): SkillProposalOutcome {
	return {
		id: proposal.id ?? "",
		action: proposal.action as SkillProposalOutcome["action"],
		ok: false,
		reason,
	};
}

/** The merged field values a skill create/update would write. */
function mergedSkillFields(
	proposal: SkillProposal,
	existing: SkillRecord | undefined,
	action: "create" | "update",
): { fields: SkillFields } | { reason: string } {
	const pick = (value: string | undefined, fallback: string): string => (typeof value === "string" ? value : fallback);
	if (action === "create") {
		if (typeof proposal.title !== "string" || typeof proposal.description !== "string" || typeof proposal.body !== "string") {
			return { reason: "create requires id?, title, description, body" };
		}
		return { fields: { title: proposal.title, description: proposal.description, body: proposal.body } };
	}
	/* v8 ignore next 3 — applySkillOne checks existence before merging, so update never arrives without a row. */
	if (existing === undefined) {
		return { reason: "no skill to merge into" };
	}
	return {
		fields: {
			title: pick(proposal.title, existing.title),
			description: pick(proposal.description, existing.description),
			body: pick(proposal.body, existing.body),
		},
	};
}

function identicalSkill(a: SkillRecord, fields: SkillFields): boolean {
	return a.title === fields.title && a.description === fields.description && a.body === fields.body;
}

/** Everything one skill proposal needs once its id is validated. */
interface SkillApplyJob {
	skills: Repository<SkillRow>;
	ctx: ProposalContext;
	proposal: SkillProposal;
	id: string;
	now: string;
	files: SkillLedgerFile[];
	intents: SkillFileIntent[];
}

/** The resolved update/delete target: scope name, partition, and stored row. */
interface SkillTarget {
	scope: string;
	partition: string;
	existing: SkillRecord | undefined;
}

/**
 * Validate one skill proposal and land it; file work happens post-commit via intents.
 * @param skills - The skills repository (inside the caller's transaction).
 * @param ctx - The write context (provenance + accounting).
 * @param proposal - The single mutation to validate and land.
 * @param now - The ISO instant stamped on touched rows.
 * @param files - Ledger file payloads appended on success.
 * @param intents - Post-commit file operations appended on success.
 * @returns The single-proposal outcome.
 */
export function applySkillOne(
	skills: Repository<SkillRow>,
	ctx: ProposalContext,
	proposal: SkillProposal,
	now: string,
	files: SkillLedgerFile[],
	intents: SkillFileIntent[],
): SkillProposalOutcome {
	const action = proposal.action;
	if (action !== "create" && action !== "update" && action !== "delete" && action !== "move-to-global") {
		return skillFail(proposal, `unknown action ${String(action)}`);
	}
	const id = skillIdFor(proposal);
	if (!isValidMemoryId(id)) {
		return skillFail(proposal, id.length === 0 ? "id missing and cannot be derived from the title" : `malformed id "${id}"`);
	}
	const job: SkillApplyJob = { skills, ctx, proposal, id, now, files, intents };
	if (action === "create") {
		return createSkill(job);
	}
	if (action === "move-to-global") {
		return moveSkillToGlobal(job);
	}
	const scope = skillScopeOf(proposal);
	if (typeof scope !== "string") {
		return skillFail(proposal, scope.reason);
	}
	const partition = skillPartitionOf(ctx, scope);
	const existingRow = skills.getRow(partition, id);
	const existing = existingRow === undefined || existingRow.status === "archived" ? undefined : skillRecordOf(existingRow);
	const target: SkillTarget = { scope, partition, existing };
	if (action === "delete") {
		return deleteSkill(job, target);
	}
	// action === "update"
	return updateSkill(job, target);
}

/** Land a create proposal: project-only, with duplicate guards on both partitions. */
function createSkill(job: SkillApplyJob): SkillProposalOutcome {
	const { skills, ctx, proposal, id, now, files, intents } = job;
	const action = proposal.action;
	if (ctx.workspaceId === "") {
		return skillFail(proposal, "skills are created in a project — move one to global explicitly afterwards");
	}
	const merged = mergedSkillFields(proposal, undefined, "create");
	if ("reason" in merged) {
		return skillFail(proposal, merged.reason);
	}
	const reasons = skillFieldGateReasons(merged.fields);
	if (reasons.length > 0) {
		return skillFail(proposal, reasons[0] ?? "invalid skill");
	}
	const projectRow = skills.getRow(ctx.workspaceId, id);
	if (projectRow !== undefined && projectRow.status !== "archived") {
		return skillFail(proposal, `skill "${id}" already exists in this project — update it instead of creating a duplicate`);
	}
	const globalRow = skills.getRow("", id);
	if (globalRow !== undefined && globalRow.status !== "archived") {
		const global = skillRecordOf(globalRow);
		if (identicalSkill(global, merged.fields)) {
			return skillFail(proposal, `identical global skill "${id}" already exists — call it directly, nothing to create`);
		}
		return skillFail(proposal, `global skill "${id}" exists with different content — rename yours, or delete the global row first`);
	}
	const sameBody = skills.findBodyOwner(ctx.workspaceId, merged.fields.body);
	if (sameBody !== undefined && sameBody !== id) {
		return skillFail(proposal, `identical skill "${sameBody}" already exists in this project — reuse it instead of duplicating`);
	}
	const sameGlobalBody = skills.findBodyOwner("", merged.fields.body);
	if (sameGlobalBody !== undefined) {
		return skillFail(proposal, `identical global skill "${sameGlobalBody}" already exists — call it directly instead of duplicating`);
	}
	skills.insertRow([
		ctx.workspaceId,
		id,
		merged.fields.title,
		merged.fields.description,
		merged.fields.body,
		ctx.sessionId ?? null,
		proposal.sourceSeqs ?? null,
		ctx.runId ?? (ctx.trigger === "explicit" ? "explicit" : null),
		now,
		now,
	]);
	skills.syncFts(ctx.workspaceId, id);
	files.push({
		id,
		action,
		scope: "project",
		after: skillRecordOf(skills.getRow(ctx.workspaceId, id) as SkillRow),
		sourceSeqs: proposal.sourceSeqs,
	});
	intents.push({ partition: ctx.workspaceId, id, op: "write" });
	return { id, action, ok: true };
}

/** Land a move-to-global proposal: copy to global, archive the project row. */
function moveSkillToGlobal(job: SkillApplyJob): SkillProposalOutcome {
	const { skills, ctx, proposal, id, now, files, intents } = job;
	const action = proposal.action;
	const projectRow = skills.getRow(ctx.workspaceId, id);
	if (projectRow === undefined || projectRow.status === "archived") {
		return skillFail(proposal, `no project skill "${id}" to move — create it in the project first`);
	}
	const project = skillRecordOf(projectRow);
	if (project.status !== "active") {
		return skillFail(proposal, `project skill "${id}" is ${project.status} — only active skills move to global`);
	}
	const globalRow = skills.getRow("", id);
	if (globalRow !== undefined && globalRow.status !== "archived") {
		return skillFail(proposal, `global skill "${id}" already exists — delete it first, or keep the project copy shadowing it`);
	}
	const reasons = skillFieldGateReasons({ title: project.title, description: project.description, body: project.body });
	if (reasons.length > 0) {
		return skillFail(proposal, reasons[0] ?? "invalid skill");
	}
	skills.insertRow([
		"",
		id,
		project.title,
		project.description,
		project.body,
		project.sourceSession,
		project.sourceSeqs,
		ctx.runId ?? (ctx.trigger === "explicit" ? "explicit" : null),
		now,
		now,
	]);
	skills.syncFts("", id);
	skills.archiveRow(ctx.workspaceId, id, now);
	skills.syncFts(ctx.workspaceId, id);
	files.push({ id, action, scope: "project", before: project });
	files.push({ id, action, scope: "global", after: skillRecordOf(skills.getRow("", id) as SkillRow) });
	intents.push({ partition: "", id, op: "write" });
	intents.push({ partition: ctx.workspaceId, id, op: "remove" });
	return { id, action, ok: true };
}

/** Land a delete proposal against its resolved target. */
function deleteSkill(job: SkillApplyJob, target: SkillTarget): SkillProposalOutcome {
	const { skills, proposal, id, files, intents } = job;
	const { scope, partition, existing } = target;
	const action = proposal.action;
	if (existing === undefined) {
		return skillFail(proposal, `no ${scope} skill "${id}" to delete`);
	}
	skills.deleteRow(partition, id);
	skills.syncFts(partition, id);
	files.push({ id, action, scope, before: existing });
	intents.push({ partition, id, op: "remove" });
	return { id, action, ok: true };
}

/** Land an update proposal against its resolved target. */
function updateSkill(job: SkillApplyJob, target: SkillTarget): SkillProposalOutcome {
	const { skills, proposal, id, now, files, intents } = job;
	const { scope, partition, existing } = target;
	const action = proposal.action;
	// action === "update"
	if (existing === undefined) {
		return skillFail(proposal, `no ${scope} skill "${id}" to update — create it in the project instead`);
	}
	const merged = mergedSkillFields(proposal, existing, "update");
	/* v8 ignore next 3 — existing is defined here (checked above), so the merge cannot fail this way. */
	if ("reason" in merged) {
		return skillFail(proposal, merged.reason);
	}
	const reasons = skillFieldGateReasons(merged.fields);
	if (reasons.length > 0) {
		return skillFail(proposal, reasons[0] ?? "invalid skill");
	}
	skills.updateRow([merged.fields.title, merged.fields.description, merged.fields.body, now, partition, id]);
	skills.syncFts(partition, id);
	files.push({ id, action, scope, before: existing, after: skillRecordOf(skills.getRow(partition, id) as SkillRow) });
	intents.push({ partition, id, op: "write" });
	return { id, action, ok: true };
}

/** The file-projection operations a committed skill batch syncs (presentation side). */
export interface SkillFileOps {
	/** The materialized directory for one skill partition. */
	rootOf(partition: string): string;
	/** Materialize one active skill row as its SKILL.md. */
	writeFile(root: string, record: SkillRecord): SkillFileWarning[];
	/** Drop one skill's materialized directory (managed files only). */
	removeFile(root: string, id: string): SkillFileWarning[];
}

/**
 * Run one skill batch: validate all proposals, apply atomically, sync files
 * post-commit, ledger. The database is the source of truth: files sync after
 * the commit and never fail the batch — patrol retries whatever refuses.
 * @param skills - The skills repository (inside this batch's transaction).
 * @param database - The open database handle (for the transaction).
 * @param skillLog - The prepared skill_log insert.
 * @param ctx - The write context (provenance + accounting).
 * @param proposals - The batch to validate and land.
 * @param files - The file-projection operations.
 * @returns The per-proposal outcomes plus file warnings.
 */
export function applySkillBatch(
	skills: Repository<SkillRow>,
	database: DatabaseSync,
	skillLog: StatementSync,
	ctx: ProposalContext,
	proposals: readonly SkillProposal[],
	files: SkillFileOps,
): { outcomes: SkillProposalOutcome[]; warnings: SkillFileWarning[] } {
	const outcomes: SkillProposalOutcome[] = [];
	const ledgerFiles: SkillLedgerFile[] = [];
	const intents: SkillFileIntent[] = [];
	const runId = ctx.runId ?? (ctx.trigger === "explicit" ? "explicit" : undefined);
	const now = new Date().toISOString();
	database.exec("BEGIN");
	for (const proposal of proposals) {
		const outcome = applySkillOne(skills, ctx, proposal, now, ledgerFiles, intents);
		outcomes.push(outcome);
		if (!outcome.ok) {
			break;
		}
	}
	const applied = outcomes.every((outcome) => outcome.ok);
	database.exec(applied ? "COMMIT" : "ROLLBACK");
	const warnings: SkillFileWarning[] = [];
	if (applied) {
		for (const intent of intents) {
			const root = files.rootOf(intent.partition);
			if (intent.op === "write") {
				const row = skills.getRow(intent.partition, intent.id);
				if (row === undefined || row.status !== "active") {
					continue;
				}
				warnings.push(...files.writeFile(root, skillRecordOf(row)));
			} else {
				warnings.push(...files.removeFile(root, intent.id));
			}
		}
	}
	const decision = applied ? ctx.decision : `${ctx.decision ?? ""} first failure: ${outcomes.find((o) => !o.ok)?.reason ?? ""}`.trim();
	writeSkillLedger(skillLog, {
		runId,
		sessionId: ctx.sessionId,
		workspaceId: ctx.workspaceId,
		trigger: ctx.trigger,
		decision,
		status: applied ? "applied" : "rejected",
		files: applied ? ledgerFiles : [],
		warnings,
	});
	return { outcomes, warnings };
}
