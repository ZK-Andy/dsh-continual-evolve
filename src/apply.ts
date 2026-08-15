/**
 * The apply pass: turn a validated proposal into state changes with full
 * per-edit accounting. Every failure is recorded per edit — a bad edit never
 * invalidates the whole proposal — and optimistic-concurrency checks reject
 * edits whose target entry changed while planning was in flight.
 */
import type {
	AppliedRefinementEdit,
	EntrySource,
	HarnessEntry,
	HarnessScope,
	HarnessState,
	RefinementProposal,
	RefinementResult,
} from "./types.js";
import { SOURCE_SESSION_KEY, SOURCE_SEQS_KEY, ARCHIVED_AT_KEY, cloneEntry, isArchived, slug } from "./types.js";
import { entryChangedSince } from "./state.js";
import { validateEdit } from "./validate.js";

export interface ApplyOptions {
	id: string;
	scope?: HarnessScope;
	rollbackOf?: string;
	/** State captured before planning; used to reject conflicting edits. */
	baselineState?: HarnessState;
	/**
	 * Trajectory citation stamped into newly created entries' metadata
	 * (sourceSession + sourceSeqs); updates keep whatever the entry already
	 * carries. Omitted entirely when the caller cannot determine it.
	 */
	source?: EntrySource;
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

		if (edit.action === "archive") {
			// Archive hides an entry from injection but never deletes it:
			// metadata.archivedAt is stamped through the normal apply path, so
			// the edit gets a before/after snapshot, a version bump, and a
			// rollback inverse like any other edit (restoring the snapshot
			// clears the stamp). Idempotency is explicit: re-archiving an
			// already-archived entry is an error, not a silent no-op.
			if (!before) {
				appliedEdits.push({ ...edit, id, applied: false, error: "entry not found" });
				continue;
			}
			if (isArchived(before)) {
				appliedEdits.push({ ...edit, id, before, applied: false, error: "entry already archived" });
				continue;
			}
			const after: HarnessEntry = {
				...before,
				metadata: { ...before.metadata, [ARCHIVED_AT_KEY]: now },
				updated_at: now,
				version: before.version + 1,
			};
			records[id] = after;
			touched.add(entryKey);
			appliedEdits.push({ ...edit, id, before, after: cloneEntry(after) ?? after, applied: true });
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

		// Trajectory citation: stamped on create (the distillation moment),
		// never re-stamped on update (the entry keeps its original source).
		// Model-supplied metadata wins on key collision.
		const sourceMetadata =
			!before && options.source
				? {
						[SOURCE_SESSION_KEY]: options.source.sessionId,
						...(options.source.seqs && options.source.seqs.length > 0
							? { [SOURCE_SEQS_KEY]: options.source.seqs }
							: {}),
					}
				: {};
		const skillKind = edit.skill_kind ?? before?.skill_kind;
		const after: HarnessEntry = {
			id,
			kind: edit.kind,
			title: edit.title ?? before?.title ?? id,
			content: edit.content ?? before?.content ?? "",
			path: edit.path ?? before?.path ?? "general",
			scope: before?.scope ?? options.scope ?? "local",
			reference: edit.reference ?? before?.reference ?? {},
			arguments: edit.arguments ?? before?.arguments ?? {},
			...(skillKind !== undefined ? { skill_kind: skillKind } : {}),
			metadata: { ...sourceMetadata, ...(edit.metadata ?? before?.metadata ?? {}) },
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
