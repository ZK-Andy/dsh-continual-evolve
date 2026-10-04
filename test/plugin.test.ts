import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apply, type EvolveConfig } from "../src/index.js";
import { MEMORY_SECTION_NAME } from "../src/memory-section.js";

interface RecordedSection {
	name: string;
	order: number;
	text: unknown;
}

function makeCtx(): { sections: RecordedSection[]; host: Parameters<typeof apply>[0] } {
	const sections: RecordedSection[] = [];
	const host = {
		systemPrompt: {
			section: (s: RecordedSection) => sections.push(s),
		},
		logger: () => ({ info: () => undefined, warn: () => undefined }),
	};
	return { sections, host };
}

const fullConfig: EvolveConfig = {
	memoryIndex: { enabled: true, guide: true, order: 400, maxChars: 6000 },
};

let workspace = "";

afterEach(() => {
	if (workspace) {
		rmSync(workspace, { recursive: true, force: true });
		workspace = "";
	}
});

describe("apply", () => {
	it("registers exactly one memory section with the defaults", () => {
		const { sections, host } = makeCtx();
		apply(host, fullConfig);
		expect(sections).toHaveLength(1);
		expect(sections[0].name).toBe(MEMORY_SECTION_NAME);
		expect(sections[0].order).toBe(400);
		expect(typeof sections[0].text).toBe("function");
	});

	it("registers nothing when the memory index is disabled", () => {
		const { sections, host } = makeCtx();
		apply(host, { memoryIndex: { enabled: false, guide: true, order: 400, maxChars: 6000 } });
		expect(sections).toHaveLength(0);
	});

	it("honors the configured order", () => {
		const { sections, host } = makeCtx();
		apply(host, { memoryIndex: { enabled: true, guide: true, order: 450, maxChars: 6000 } });
		expect(sections[0].order).toBe(450);
	});

	it("the registered provider renders a section for an agent in a workspace", () => {
		workspace = mkdtempSync(join(tmpdir(), "evolve-plugin-"));
		const { sections, host } = makeCtx();
		apply(host, fullConfig);
		const render = sections[0].text as (context: { agent: unknown }) => string;
		const agent = { id: "s1", session: { header: { cwd: workspace } } };
		const text = render({ agent });
		expect(text).toContain("# 持久记忆");
		expect(text).toContain("<memories>");
		// First render in a fresh workspace bootstraps its store.
		expect(text).not.toBe("");
	});
});
