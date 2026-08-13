/**
 * Tests for the tool scope resolution: the boolean `global: true` parameter
 * and the string "global" must both select the cross-session store.
 */
import { describe, expect, it } from "vitest";
import { scopeOf } from "../src/tool.js";

describe("scopeOf", () => {
	it("maps boolean true to global", () => {
		expect(scopeOf(true, "local")).toBe("global");
	});

	it("maps the string 'global' to global", () => {
		expect(scopeOf("global", "local")).toBe("global");
	});

	it("falls back for false / undefined / other values", () => {
		expect(scopeOf(false, "local")).toBe("local");
		expect(scopeOf(undefined, "local")).toBe("local");
		expect(scopeOf("GLOBAL", "local")).toBe("local");
	});
});
