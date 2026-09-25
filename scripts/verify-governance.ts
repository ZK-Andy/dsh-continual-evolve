#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Local governance self-check (same logic as the CI governance job).
 *
 * - Issue templates must contain owner/priority/class.
 *   Exempt: config.yml (form config, not a template); test_feedback.yml
 *   (30s lightweight feedback form, triage fills governance fields later).
 * - PR template must contain the Reviewer Checklist + change-scope pointer.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function main(): number {
	let ok = true;
	const issueDir = join(root, ".github/ISSUE_TEMPLATE");
	if (existsSync(issueDir)) {
		for (const name of readdirSync(issueDir)) {
			if (!name.endsWith(".yml")) continue;
			if (name === "config.yml" || name === "test_feedback.yml") continue;
			const t = readFileSync(join(issueDir, name), "utf-8");
			for (const kw of ["owner", "priority", "class"]) {
				if (!t.toLowerCase().includes(kw)) {
					console.log(`FAIL ${name}: 缺 ${kw}`);
					ok = false;
				}
			}
		}
	}
	const pr = join(root, ".github/pull_request_template.md");
	if (existsSync(pr)) {
		const t = readFileSync(pr, "utf-8");
		if (!t.includes("Reviewer Checklist")) {
			console.log("FAIL PR template 缺 Reviewer Checklist");
			ok = false;
		}
		if (!t.includes("change-scope")) {
			console.log("FAIL PR template 缺 change-scope");
			ok = false;
		}
	} else {
		console.log("FAIL 缺 .github/pull_request_template.md");
		ok = false;
	}
	console.log(ok ? "OK" : "FAIL");
	return ok ? 0 : 1;
}

process.exitCode = main();
