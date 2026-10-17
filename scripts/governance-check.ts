#!/usr/bin/env -S ../node_modules/.bin/tsx
/**
 * Validate the Issue/PR payload the `governance` workflow receives and print
 * the findings as workflow annotations.
 *
 * The payload arrives through environment variables, never through shell
 * interpolation: an issue body is untrusted markdown, and a code fence inside
 * `BODY="${{ github.event.issue.body }}"` closes the quote and hands the
 * remaining lines to the shell (2026-10-18 evidence: `markdown: 未找到命令`,
 * syntax error on the `(` of a markdown link, exit 2).
 *
 * The checks are advisory by design — the process exits 0 whatever it finds so
 * a missing Owner/Priority line cannot block an outside contributor.
 *
 * Usage (CI): EVENT_NAME=issues EVENT_JSON='<toJSON(github.event)>' \
 *   node scripts/governance-check.ts
 * Usage (local): tsx scripts/governance-check.ts --event path/to/event.json
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** One validation result, rendered as a workflow annotation or a plain line. */
export interface GovernanceFinding {
	level: "info" | "warning";
	message: string;
}

/** A parsed event payload, or why it could not be read. */
export type ParsedEvent = { ok: true; event: unknown } | { ok: false; error: string };

/** The markers an Issue body carries when the issue template was used. */
const ISSUE_MARKERS = ["Owner", "优先级", "分类"];

/** The markers the PR template guarantees (reviewer checklist + scope proof). */
const PR_MARKERS = ["Reviewer Checklist", "change-scope"];

/**
 * Read the event JSON without throwing: a malformed payload is a finding, not
 * a crash — the workflow must stay green so contributors see the message.
 * @param raw - The event JSON string.
 * @returns The parsed payload or the error message.
 */
export function parseEvent(raw: string | undefined): ParsedEvent {
	if (raw === undefined || raw.trim().length === 0) {
		return { ok: false, error: "事件负载为空（EVENT_JSON 未传入）" };
	}
	try {
		return { ok: true, event: JSON.parse(raw) };
	} catch (error) {
		return { ok: false, error: `事件负载不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
	}
}

/** The body string of the issue or pull request the event carries. */
function bodyOf(payload: Record<string, unknown>): string {
	const issue = payload.issue as { body?: unknown } | undefined;
	const pull = payload.pull_request as { body?: unknown } | undefined;
	const body = issue?.body ?? pull?.body;
	return typeof body === "string" ? body : "";
}

/** The title of the issue or pull request the event carries. */
function titleOf(payload: Record<string, unknown>): string {
	const issue = payload.issue as { title?: unknown } | undefined;
	const pull = payload.pull_request as { title?: unknown } | undefined;
	const title = issue?.title ?? pull?.title;
	return typeof title === "string" ? title : "";
}

/** The number of the issue or pull request the event carries, `undefined` when absent. */
function numberOf(payload: Record<string, unknown>): number | undefined {
	const issue = payload.issue as { number?: unknown } | undefined;
	const pull = payload.pull_request as { number?: unknown } | undefined;
	const number = issue?.number ?? pull?.number;
	return typeof number === "number" ? number : undefined;
}

/**
 * Decide what the governance step reports for one event.
 * @param eventName - `issues`, `pull_request`, or anything else.
 * @param event - The parsed event payload.
 * @returns The findings, `info` first.
 */
export function checkGovernance(eventName: string, event: unknown): GovernanceFinding[] {
	const findings: GovernanceFinding[] = [{ level: "info", message: `event=${eventName}` }];
	if (eventName !== "issues" && eventName !== "pull_request") {
		findings.push({ level: "info", message: `无需校验的事件类型（${eventName}）` });
		return findings;
	}
	if (event === null || typeof event !== "object") {
		findings.push({ level: "warning", message: "事件负载不是对象，跳过校验" });
		return findings;
	}
	const payload = event as Record<string, unknown>;
	const kind = eventName === "issues" ? "Issue" : "PR";
	const number = numberOf(payload);
	findings.push({ level: "info", message: `${kind} #${number ?? "?"}: ${titleOf(payload)}` });
	const body = bodyOf(payload);
	if (body.trim().length === 0) {
		findings.push({ level: "warning", message: `${kind} 正文为空` });
		return findings;
	}
	const expected = eventName === "issues" ? ISSUE_MARKERS : PR_MARKERS;
	const missing = expected.filter((marker) => !body.includes(marker));
	if (missing.length > 0) {
		const hint =
			eventName === "issues"
				? "建议用 Issue 模板补齐（缺失不阻断，仅提示）"
				: "请用 PR 模板补齐 Reviewer Checklist 与 change-scope 最小证据";
		findings.push({ level: "warning", message: `缺少 ${missing.join(" / ")}；${hint}` });
		return findings;
	}
	findings.push({ level: "info", message: `${kind} 输入校验通过` });
	return findings;
}

/**
 * Render findings as workflow command lines (`::warning::`) or plain text.
 * @param findings - The findings to render.
 * @returns One line per finding.
 */
export function renderFindings(findings: readonly GovernanceFinding[]): string[] {
	return findings.map((finding) => (finding.level === "warning" ? `::warning::${finding.message}` : finding.message));
}

/** Print findings for a terminal or CI run. */
function report(findings: readonly GovernanceFinding[]): void {
	for (const line of renderFindings(findings)) {
		console.log(line);
	}
}

/** Read the event JSON from `--event <path>` or the `EVENT_JSON` variable. */
function eventJsonFrom(argv: readonly string[]): string | undefined {
	const flag = argv.indexOf("--event");
	if (flag < 0) {
		return process.env.EVENT_JSON;
	}
	const path = argv[flag + 1];
	if (path === undefined) {
		return undefined;
	}
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Run main only under direct execution (tests import the helpers without side effects). */
function main(): void {
	const parsed = parseEvent(eventJsonFrom(process.argv.slice(2)));
	if (!parsed.ok) {
		report([{ level: "warning", message: parsed.error }]);
		return;
	}
	report(checkGovernance(process.env.EVENT_NAME ?? "unknown", parsed.event));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
