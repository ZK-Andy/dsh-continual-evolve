/**
 * The apply pass: turn a validated proposal into state changes with full
 * per-edit accounting. Every failure is recorded per edit — a bad edit never
 * invalidates the whole proposal — and optimistic-concurrency checks reject
 * edits whose target entry changed while planning was in flight.
 */
import type {
	AppliedRefinementEdit,
	HarnessEntry,
	HarnessScope,
	HarnessState,
	RefinementProposal,
	RefinementResult,
} from "./types.js";
import { cloneEntry, slug } from "./types.js";
import { entryChangedSince } from "./state.js";
import { validateEdit } from "./validate.js";

export interface ApplyOptions {
	id: string;
	scope?: HarnessScope;
	rollbackOf?: string;
	/** State captured before planning; used to reject conflicting edits. */
	baselineState?: HarnessState;
}

export function applyRefinementProposal(
	state: HarnessState,
	proposal: RefinementProposal,
	options: ApplyOptions,
): RefinementResult {
	const appliedEdits: AppliedRefinementEdit[] = [];
	const touched = new Set<string>();
	const now = new Date().toISOString();

	for (const edit of proposal.edits) {
		const computedId = edit.id ?? (edit.action === "create" ? slug(edit.title ?? edit.kind, edit.kind) : undefined);
		const id = computedId ?? "";
		const validationError = validateEdit(edit, computedId);
		if (validationError) {
			appliedEdits.push({ ...edit, id, applied: false, error: validationError });
			continue;
		}

		const records = state.entries[edit.kind];
		const before = cloneEntry(records[id]);
		const entryKey = `${edit.kind}:${id}`;
		const baseline = cloneEntry(options.baselineState?.entries[edit.kind][id]);
		if (options.baselineState && !touched.has(entryKey) && JSON.stringify(before ?? null) !== JSON.stringify(baseline ?? null)) {
			appliedEdits.push({
				...edit,
				id,
				...(before ? { before } : {}),
				applied: false,
				error: "entry changed during planning",
			});
			continue;
		}

		if (edit.action === "delete") {
			if (!before) {
				appliedEdits.push({ ...edit, id, applied: false, error: "entry not found" });
				continue;
			}
			delete records[id];
			touched.add(entryKey);
			appliedEdits.push({ ...edit, id, before, applied: true });
			continue;
		}

		if (edit.action === "create" && before) {
			appliedEdits.push({ ...edit, id, before, applied: false, error: "entry already exists" });
			continue;
		}
		if (edit.action === "update" && !before) {
			appliedEdits.push({ ...edit, id, applied: false, error: "entry not found" });
			continue;
		}

		const after: HarnessEntry = {
			id,
			kind: edit.kind,
			title: edit.title ?? before?.title ?? id,
			content: edit.content ?? before?.content ?? "",
			path: edit.path ?? before?.path ?? "general",
			scope: before?.scope ?? options.scope ?? "local",
			reference: edit.reference ?? before?.reference ?? {},
			arguments: edit.arguments ?? before?.arguments ?? {},
			metadata: edit.metadata ?? before?.metadata ?? {},
			source: "evolve",
			created_at: before?.created_at ?? now,
			updated_at: now,
			version: before ? before.version + 1 : 1,
		};
		records[id] = after;
		touched.add(entryKey);
		appliedEdits.push({
			...edit,
			id,
			...(before ? { before } : {}),
			after: cloneEntry(after) ?? after,
			applied: true,
		});
	}

	const changes = appliedEdits.filter((edit) => edit.applied).map((edit) => `${edit.action} ${edit.kind}:${edit.id}`);
	state.refinements.push({
		id: options.id,
		trigger: proposal.summary,
		changes,
		evidence: proposal.rationale,
		outcome: proposal.expectedOutcome,
		created_at: now,
	});

	return {
		id: options.id,
		summary: proposal.summary,
		rationale: proposal.rationale,
		expectedOutcome: proposal.expectedOutcome,
		appliedEdits,
		harnessStatePath: "",
		...(options.rollbackOf ? { rollbackOf: options.rollbackOf } : {}),
		...(options.scope ? { scope: options.scope } : {}),
	};
}

export { entryChangedSince };
