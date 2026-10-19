import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareApi, snapshotApi, type ApiSnapshot } from "../scripts/verify-api-snapshot.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function snapshotOf(modules: Record<string, string>): ApiSnapshot {
	return { version: 1, modules };
}

describe("compareApi", () => {
	it("passes identical surfaces", () => {
		const current = { "src/a.ts": "export declare const a: 1;\n" };
		expect(compareApi(current, snapshotOf(current)).ok).toBe(true);
	});

	it("fails a changed signature", () => {
		const result = compareApi({ "src/a.ts": "export declare const a: 2;\n" }, snapshotOf({ "src/a.ts": "export declare const a: 1;\n" }));
		expect(result.ok).toBe(false);
		expect(result.messages.some((m) => m.includes("src/a.ts"))).toBe(true);
	});

	it("fails a removed export the same way (surface text differs)", () => {
		const result = compareApi({ "src/a.ts": "export {};\n" }, snapshotOf({ "src/a.ts": "export declare const a: 1;\n" }));
		expect(result.ok).toBe(false);
	});

	it("fails new modules until re-anchored", () => {
		const result = compareApi({ "src/a.ts": "export {};\n", "src/new.ts": "export {};\n" }, snapshotOf({ "src/a.ts": "export {};\n" }));
		expect(result.ok).toBe(false);
		expect(result.messages.some((m) => m.includes("src/new.ts") && m.includes("--update"))).toBe(true);
	});

	it("fails deleted modules until re-anchored", () => {
		const result = compareApi({}, snapshotOf({ "src/gone.ts": "export {};\n" }));
		expect(result.ok).toBe(false);
		expect(result.messages.some((m) => m.includes("src/gone.ts"))).toBe(true);
	});
});

describe("snapshotApi on the real tree", () => {
	it(
		"emits one surface per src module",
		() => {
			const snapshot = snapshotApi(join(root, "tsconfig.json"));
			expect(Object.keys(snapshot.modules).length).toBeGreaterThan(70);
			expect(snapshot.modules["src/services/extraction-item.ts"]).toContain("runIdOf");
		},
		60_000,
	);
});
