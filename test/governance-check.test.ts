import { describe, expect, it } from "vitest";
import { checkGovernance, parseEvent, renderFindings } from "../scripts/governance-check.js";

/** The shape GitHub hands the governance workflow for an `issues` event. */
function issueEvent(body: string, title = "Add plugin to awesome list?"): unknown {
	return { action: "opened", issue: { number: 3, title, body, labels: [] } };
}

describe("parseEvent", () => {
	it("reports a missing payload instead of throwing", () => {
		expect(parseEvent(undefined)).toEqual({ ok: false, error: expect.stringContaining("为空") });
		expect(parseEvent("   ")).toEqual({ ok: false, error: expect.stringContaining("为空") });
	});

	it("reports malformed JSON instead of throwing", () => {
		const parsed = parseEvent("{not json");
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.error).toContain("不是合法 JSON");
	});
});

describe("checkGovernance", () => {
	const fencedBody = [
		"Hey, would you add this plugin?",
		"",
		"```markdown",
		"- [dsh-continual-evolve](https://github.com/ZK-Andy/dsh-continual-evolve) - Workspace memory. <!-- platform: standalone -->",
		"```",
	].join("\n");

	it("survives a body whose code fence used to break the shell", () => {
		const findings = checkGovernance("issues", issueEvent(fencedBody));
		// The bug was shell interpolation, not the findings: a fenced body now
		// simply reports the missing template markers as a warning.
		expect(findings.map((f) => f.level)).toEqual(["info", "info", "warning"]);
		expect(findings.at(-1)?.message).toContain("缺少 Owner / 优先级 / 分类");
		expect(findings.at(-1)?.message).toContain("不阻断");
	});

	it("passes an issue that carries the template markers", () => {
		const body = "## Owner\n@ZK-Andy\n\n## 优先级\nP2\n\n## 分类\nprocess\n";
		const findings = checkGovernance("issues", issueEvent(body));
		expect(findings.at(-1)).toEqual({ level: "info", message: "Issue 输入校验通过" });
	});

	it("warns on an empty body and stops there", () => {
		const findings = checkGovernance("issues", issueEvent("   "));
		expect(findings.at(-1)).toEqual({ level: "warning", message: "Issue 正文为空" });
	});

	it("checks the PR template markers", () => {
		const missing = checkGovernance("pull_request", { pull_request: { number: 7, title: "feat(x): y", body: "描述" } });
		expect(missing.at(-1)?.message).toContain("缺少 Reviewer Checklist / change-scope");
		const complete = checkGovernance("pull_request", {
			pull_request: { number: 7, title: "feat(x): y", body: "## Reviewer Checklist\n- [x] ok\n\npnpm run change-scope 输出见下" },
		});
		expect(complete.at(-1)).toEqual({ level: "info", message: "PR 输入校验通过" });
	});

	it("says nothing to check for other event types", () => {
		expect(checkGovernance("workflow_dispatch", {})).toEqual([
			{ level: "info", message: "event=workflow_dispatch" },
			{ level: "info", message: "无需校验的事件类型（workflow_dispatch）" },
		]);
	});

	it("degrades a non-object payload to a warning", () => {
		expect(checkGovernance("issues", null).at(-1)).toMatchObject({ level: "warning" });
	});
});

describe("renderFindings", () => {
	it("turns warnings into workflow annotations and leaves info plain", () => {
		expect(
			renderFindings([
				{ level: "info", message: "event=issues" },
				{ level: "warning", message: "Issue 正文为空" },
			]),
		).toEqual(["event=issues", "::warning::Issue 正文为空"]);
	});
});
