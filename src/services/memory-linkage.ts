/**
 * The linkage a landed memory write causes (`2026-10-17-review-and-tiering-batch-rollout`
 * §R2/§R4). Kept out of the write gate so the gate stays "validate, land,
 * ledger": this module only decides which existing items a write puts back in
 * front of review.
 *
 * A `corrects` target always links. A create also links the items its title is
 * lexically near — labelled `correction` when the writer is a feedback row
 * (the user correcting a topic), `similar` otherwise. Text-only updates link
 * nobody: the review's own rewrites would otherwise drag their neighbours back
 * into the queue they just left.
 */
import type { ItemEventEntry, ItemEventKind } from "../store-types.js";
import type { MemoryRow } from "../data/records.js";
import type { Repository } from "../data/repository.js";

/** At most this many neighbour links per landed write. */
const MAX_LINKS = 5;

/** What a linkage pass needs: the partition and its memories repository. */
export interface LinkageContext {
	workspaceId: string;
	memories: Repository<MemoryRow>;
}

/**
 * The linkage events one landed create causes.
 * @param ctx - The write's partition and repository.
 * @param id - The landed item id.
 * @param fields - The landed title and type.
 * @param link - The correction target, null when the write corrects nothing.
 * @returns The events to append, at most {@link MAX_LINKS}.
 */
export function createLinkages(
	ctx: LinkageContext,
	id: string,
	fields: { type: string; title: string },
	link: string | null,
): ItemEventEntry[] {
	const entries: ItemEventEntry[] = [];
	const seen = new Set<string>([id]);
	if (link !== null) {
		entries.push({ workspaceId: ctx.workspaceId, kind: "memory", id: link, event: "corrects", sourceId: id });
		seen.add(link);
	}
	const query = linkageToken(fields.title);
	if (query === undefined) {
		return entries;
	}
	const event: ItemEventKind = fields.type === "feedback" ? "correction" : "similar";
	try {
		for (const row of ctx.memories.searchRows(ctx.workspaceId, query, MAX_LINKS)) {
			if (entries.length >= MAX_LINKS) {
				break;
			}
			if (seen.has(row.id) || row.status !== "active") {
				continue;
			}
			seen.add(row.id);
			entries.push({ workspaceId: ctx.workspaceId, kind: "memory", id: row.id, event, sourceId: id });
		}
	} catch {
		// Advisory only: a write that passed the gates is not doomed by the index.
	}
	return entries;
}

/**
 * The correction-only linkage an update causes, empty when the update names
 * no target.
 * @param ctx - The write's partition and repository.
 * @param id - The updated item id.
 * @param link - The correction target, null when the update corrects nothing.
 * @returns The events to append.
 */
export function updateLinkages(ctx: LinkageContext, id: string, link: string | null): ItemEventEntry[] {
	if (link === null) {
		return [];
	}
	return [{ workspaceId: ctx.workspaceId, kind: "memory", id: link, event: "corrects", sourceId: id }];
}

/**
 * The search token a landed title links on. The trigram index can only match
 * a ≥3-char phrase, so the widest honest topic proxy is the title's first
 * word — and for a CJK run (no whitespace) its first three characters. The
 * ADR asks for a loose threshold to start with; tightening it later is one
 * edit here, not a schema change.
 * @param title - The landed title.
 * @returns The FTS query, `undefined` when the title carries no usable token.
 */
function linkageToken(title: string): string | undefined {
	const token = (title.trim().split(/[\s\u3000]+/)[0] ?? "").slice(0, 20);
	if (token.length < 3) {
		return undefined;
	}
	return /[\u3400-\u9fff]/.test(token) ? token.slice(0, 3) : token;
}
