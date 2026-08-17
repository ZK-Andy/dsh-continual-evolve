/**
 * The `/evolve wrapup` subcommand handler. Extracted from command.ts (P2-2).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import type { EvolutionEngine } from "./service.js";
import { questionServiceOf, requireGlobalApproval } from "./approval.js";
import { assessLocalEntries, candidateKey, filterPromotable, listLocalCandidates, splitArchiveGuards, splitPromoteBlocked, splitPromoteProposals, wholePromoteProposals } from "./wrapup.js";
import type { WrapupCandidate, WrapupItem } from "./wrapup.js";

function success(text: string): CommandResult {
	return { kind: "success", text };
}

export async function executeWrapupCommand(
	ctx: Context,
	engine: EvolutionEngine,
	invocation: CommandInvocation,
): Promise<CommandResult> {
	const sessionId = invocation.agent.id;
	const localState = engine.load("local", sessionId);
	const globalState = engine.load("global", undefined);
	const candidates = listLocalCandidates(localState, globalState);
	if (candidates.length === 0) {
		return success(
			`(nothing to wrap up: ${sessionId}'s local store has no active, un-promoted entries — use /evolve list to inspect it)`,
		);
	}

	// 1. Classify: the model judges each audited candidate's fate.
	const assessment = await assessLocalEntries(ctx, invocation.agent, candidates, { signal: invocation.signal });
	const byKey = new Map(candidates.map((candidate) => [candidateKey(candidate.kind, candidate.id), candidate]));

	// 2. Partition by action. Deterministic guards re-check the LIVE global
	//    store right before anything lands (state may have changed mid-call).
	const { promotable, skipped } = filterPromotable(assessment.items, globalState, candidates);
	const promoteItems = promotable.filter((item) => item.verdict === "promote");
	const archiveItems = assessment.items.filter((item) => item.verdict === "archive");
	// Split promotion (A-form): archive a mixed entry but promote ONLY the
	// cleaned durable part the model extracted. Guarded the same way as whole
	// promotes — a split that would duplicate a globally covered topic is
	// dropped and the entry archives plain.
	const splitItems: { item: WrapupItem; candidate: WrapupCandidate }[] = [];
	const splitSkipped: { key: string; reason: string }[] = [];
	for (const item of archiveItems) {
		if (!item.promote) continue;
		const candidate = byKey.get(item.key);
		if (!candidate) {
			splitSkipped.push({ key: item.key, reason: "not in the audited candidate list" });
			continue;
		}
		const blocked = splitPromoteBlocked(item, globalState, candidate.kind);
		if (blocked) {
			splitSkipped.push({ key: item.key, reason: blocked });
			continue;
		}
		splitItems.push({ item, candidate });
	}
	// Plain archives (no split payload): the symmetric guard — an archive that
	// is NOT globally covered AND was distilled from real user messages must
	// not proceed silently.
	const plainArchives = archiveItems.filter((item) => !item.promote);
	const { silent: silentArchives, review: reviewArchives } = splitArchiveGuards(plainArchives, candidates);
	const keepItems = assessment.items.filter((item) => item.verdict === "keep");

	// 3. Report the assessment before touching anything.
	const lines: string[] = [
		`wrapup assessment (${sessionId}): ${candidates.length} candidates${candidates.some((c) => c.coveredGlobally) ? `, ${candidates.filter((c) => c.coveredGlobally).length} covered globally` : ""}`,
		`${assessment.rationale}`,
	];
	for (const [heading, items] of [
		["PROMOTE (to global)", promoteItems],
		["SPLIT (archive + promote durable part)", splitItems.map((split) => split.item)],
		["ARCHIVE", silentArchives],
		["ARCHIVE (needs review)", reviewArchives],
		["KEEP", keepItems],
	] as const) {
		lines.push(`${heading}: ${items.length}`);
		for (const item of items) {
			const candidate = byKey.get(item.key);
			const title = candidate ? candidate.title : item.key;
			const splitNote = item.promote ? ` → 拆出提升「${item.promote.title}」` : "";
			lines.push(`- ${item.key} "${title}"${splitNote} — ${item.reason}`);
		}
	}
	for (const skip of skipped) {
		lines.push(`- promote skipped: ${skip.key} — ${skip.reason}`);
	}
	for (const skip of splitSkipped) {
		lines.push(`- split skipped: ${skip.key} — ${skip.reason}`);
	}
	lines.push("");

	const applied: string[] = [];

	// 4. Global writes: governed resource — ONE human approval gate covers
	//    every create (whole promotes AND split promotions). On approval:
	//    - whole promote → create global copy + stamp local promotedTo+archivedAt;
	//    - split → create the cleaned durable part + archive the original with
	//      promotedTo. On rejection: whole promotes are not written, and each
	//      split's original STILL archives plain (its snapshot half deserves
	//      the archive; the durable half is reported for manual handling).
	const wholeCreates = promoteItems.map((item) => ({ item, candidate: byKey.get(item.key) }));
	const splitCreates = splitItems;
	const allCreates = new Set([...wholeCreates.map((c) => c.item.key), ...splitCreates.map((c) => c.item.key)]);
	if (allCreates.size > 0) {
		const what = `wrapup 将写入跨会话 global store（共 ${allCreates.size} 条：${promoteItems.length} 条整条提升 + ${splitItems.length} 条拆解提升）：\n${[
			...promoteItems.map((item) => `- 整条提升 ${item.key} "${byKey.get(item.key)?.title ?? item.key}"`),
			...splitItems.map(
				(split) => `- 拆解提升 ${split.item.key} → 清洗「${split.item.promote?.title}」（原条目随之归档）`,
			),
		].join("\n")}`;
		let promoteAllowed = true;
		try {
			await requireGlobalApproval(ctx, invocation.agent, invocation.signal, what);
		} catch (cause) {
			promoteAllowed = false;
			const message = `global 写入未批准 — 整条提升与拆解提升均未写入 (${cause instanceof Error ? cause.message : String(cause)})`;
			applied.push(message);
			lines.push(message);
		}
		if (promoteAllowed) {
			// Whole promotes: create global entry, retire the local copy.
			// Shared proposal builders keep the wrap-up command and the gate's
			// local-fate dimension writing IDENTICAL edits.
			for (const { item, candidate } of wholeCreates) {
				if (!candidate) continue;
				const proposals = wholePromoteProposals(item, candidate, sessionId);
				const globalResult = engine.apply("global", undefined, proposals.global, { scope: "global" });
				const createdId = globalResult.appliedEdits.find((edit) => edit.applied)?.id ?? candidate.id;
				const localResult = engine.apply("local", sessionId, proposals.localStamp(createdId), {
					scope: "local",
					baselineState: localState,
				});
				applied.push(`promoted ${item.key} → global:${createdId} (${globalResult.id}; local stamped ${localResult.id})`);
			}
			// Split promotions: create the cleaned durable part, retire the
			// original local entry (its snapshot half is archived along).
			for (const { item, candidate } of splitCreates) {
				if (!item.promote) continue;
				const proposals = splitPromoteProposals(item, candidate, sessionId);
				const globalResult = engine.apply("global", undefined, proposals.global, { scope: "global" });
				const createdId = globalResult.appliedEdits.find((edit) => edit.applied)?.id ?? candidate.id;
				const localResult = engine.apply("local", sessionId, proposals.localStamp(createdId), {
					scope: "local",
					baselineState: localState,
				});
				applied.push(`split ${item.key}: promoted cleaned part → global:${createdId} (${globalResult.id}); original archived (${localResult.id})`);
			}
		} else {
			// Rejected: whole promotes stay un-written; each split's original
			// still archives plain (reported, data restorable).
			for (const { item, candidate } of splitCreates) {
				if (!candidate) continue;
				const result = engine.apply(
					"local",
					sessionId,
					{
						summary: `wrapup: split promotion not approved — archive original ${item.key} plain`,
						rationale: item.reason,
						expectedOutcome: `The original leaves injection; the cleaned part was NOT written (reported for manual handling).`,
						edits: [{ action: "archive", kind: candidate.kind, id: candidate.id }],
					},
					{ scope: "local", baselineState: localState },
				);
				applied.push(`split ${item.key}: promotion not approved — original archived plain (${result.id})`);
			}
		}
	}
	// 5. Silent archives: deterministic local action (hidden from injection,
	//    data kept restorable) — covered topics and operational entries need no
	//    confirmation, matching the original behavior.
	for (const item of silentArchives) {
		const candidate = byKey.get(item.key);
		if (!candidate) continue;
		const result = engine.apply(
			"local",
			sessionId,
			{
				summary: `wrapup: archive local ${item.key} — ${item.reason}`,
				rationale: item.reason,
				expectedOutcome: `The entry stops being injected but stays restorable.`,
				edits: [{ action: "archive", kind: candidate.kind, id: candidate.id }],
			},
			{ scope: "local", baselineState: localState },
		);
		applied.push(`archived ${item.key} (${result.id})`);
	}

	// 6. Review archives (symmetric guard): not covered globally + distilled
	//    from real user messages — the user decides before this content is
	//    hidden from future sessions. No question service → conservative keep.
	const userQuestions = questionServiceOf(ctx);
	for (const item of reviewArchives) {
		const candidate = byKey.get(item.key);
		if (!candidate) continue;
		if (!userQuestions) {
			applied.push(`kept ${item.key} — archive pending user confirmation (no question service)`);
			continue;
		}
		const questionId = "evolve-wrapup-archive-review";
		let archiveConfirmed = false;
		try {
			const answer = await userQuestions.ask({
				questions: [
					{
						id: questionId,
						question: `wrapup：条目「${candidate.title}」未被全局覆盖且源自真实对话，直接归档会隐藏它（数据保留、可恢复）。确认归档？`,
						options: [{ label: "归档" }, { label: "保留" }],
					},
				],
				agent: invocation.agent,
				signal: invocation.signal,
			});
			archiveConfirmed = answer.answers?.find((entry) => entry.id === questionId)?.selected?.includes("归档") ?? false;
		} catch {
			archiveConfirmed = false;
		}
		if (archiveConfirmed) {
			const result = engine.apply(
				"local",
				sessionId,
				{
					summary: `wrapup: archive local ${item.key} (user-confirmed) — ${item.reason}`,
					rationale: item.reason,
					expectedOutcome: `The entry stops being injected but stays restorable.`,
					edits: [{ action: "archive", kind: candidate.kind, id: candidate.id }],
				},
				{ scope: "local", baselineState: localState },
			);
			applied.push(`archived ${item.key} (user-confirmed, ${result.id})`);
		} else {
			applied.push(`kept ${item.key} — user declined the archive`);
		}
	}

	lines.push(...(applied.length > 0 ? applied : ["(no changes applied — all entries kept)"]));
	return success(lines.join("\n"));
}
