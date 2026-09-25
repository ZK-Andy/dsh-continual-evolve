/**
 * Tests for the slug id derivation: ASCII titles keep legacy snake_case,
 * non-ASCII-only titles take a content-hashed fallback id (distinct titles
 * no longer collide), and identical titles still dedupe.
 */
import { describe, expect, it } from "vitest";
import { slug } from "../src/types.js";

const ID_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

describe("slug", () => {
	it("keeps ASCII snake_case behavior", () => {
		expect(slug("Hello World", "memory")).toBe("hello_world");
		expect(slug("  dark-one  ", "memory")).toBe("dark_one");
		expect(slug("Session handoff process", "skill")).toBe("session_handoff_process");
	});

	it("gives distinct Chinese-only titles distinct grammar-valid ids", () => {
		const first = slug("深色主题偏好一", "memory");
		const second = slug("深色主题偏好二", "memory");
		expect(first).not.toBe(second);
		expect(first).toMatch(ID_GRAMMAR);
		expect(second).toMatch(ID_GRAMMAR);
		expect(first.startsWith("memory_")).toBe(true);
	});

	it("dedupes identical Chinese titles onto the same id", () => {
		expect(slug("深色主题偏好一", "memory")).toBe(slug("深色主题偏好一", "memory"));
	});

	it("scopes the hash fallback by kind", () => {
		expect(slug("深色主题", "memory").startsWith("memory_")).toBe(true);
		expect(slug("深色主题", "prompt").startsWith("prompt_")).toBe(true);
	});
});
