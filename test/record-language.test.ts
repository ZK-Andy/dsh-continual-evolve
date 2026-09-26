/**
 * Tests for record-language resolution: the configured > durable >
 * detected > fallback chain, the fail-open settings read, and the prompt
 * instruction line. The chain is what lets evolution records follow the
 * DSH client language instead of defaulting to English.
 */
import { describe, expect, it } from "vitest";
import {
	detectLanguageFromText,
	durableLocalePreference,
	normalizeRecordLanguage,
	recordLanguageInstruction,
	resolveRecordLanguage,
} from "../src/record-language.js";

function settingsCtx(rows: unknown): { [key: string]: unknown } {
	return { settings: { describe: () => rows } };
}

describe("detectLanguageFromText", () => {
	it("returns zh on Chinese user text", () => {
		expect(detectLanguageFromText("请把确认弹窗的文案改得好看一点")).toBe("zh");
	});

	it("returns undefined on English text (no signal, not a default)", () => {
		expect(detectLanguageFromText("please make the confirm dialog prettier")).toBeUndefined();
	});

	it("ignores stray Han characters below the signal floor", () => {
		expect(detectLanguageFromText("ok 好")).toBeUndefined();
	});

	it("returns undefined on empty text", () => {
		expect(detectLanguageFromText("")).toBeUndefined();
	});
});

describe("durableLocalePreference", () => {
	it("reads the locale namespace preference", () => {
		expect(durableLocalePreference(settingsCtx([{ ns: "locale", value: { preference: "zh" } }]))).toBe("zh");
	});

	it("accepts subtag ids", () => {
		expect(durableLocalePreference(settingsCtx([{ ns: "locale", value: { preference: "zh-Hans-CN" } }]))).toBe("zh");
		expect(durableLocalePreference(settingsCtx([{ ns: "locale", value: { preference: "en-GB" } }]))).toBe("en");
	});

	it("fails open on every host-shape mismatch", () => {
		expect(durableLocalePreference({})).toBeUndefined();
		expect(durableLocalePreference({ settings: {} })).toBeUndefined();
		expect(
			durableLocalePreference({ settings: { describe: () => { throw new Error("host moved"); } } }),
		).toBeUndefined();
		expect(durableLocalePreference(settingsCtx(null))).toBeUndefined();
		expect(durableLocalePreference(settingsCtx([{ ns: "other", value: {} }]))).toBeUndefined();
		expect(durableLocalePreference(settingsCtx([{ ns: "locale", value: { preference: "fr" } }]))).toBeUndefined();
		expect(durableLocalePreference(settingsCtx([{ ns: "locale", value: null }]))).toBeUndefined();
	});
});

describe("resolveRecordLanguage", () => {
	it("prefers the explicit config over everything", () => {
		expect(
			resolveRecordLanguage({
				configured: "en",
				ctx: settingsCtx([{ ns: "locale", value: { preference: "zh" } }]),
				trajectoryText: "中文轨迹",
			}),
		).toBe("en");
	});

	it("uses the durable preference under auto", () => {
		expect(
			resolveRecordLanguage({
				configured: "auto",
				ctx: settingsCtx([{ ns: "locale", value: { preference: "zh" } }]),
				trajectoryText: "english trajectory",
			}),
		).toBe("zh");
	});

	it("falls back to trajectory detection without a durable value", () => {
		expect(resolveRecordLanguage({ ctx: {}, trajectoryText: "确认弹窗有点丑陋" })).toBe("zh");
	});

	it("falls back to en with no signal anywhere (DSH FALLBACK_LOCALE)", () => {
		expect(resolveRecordLanguage({})).toBe("en");
		expect(resolveRecordLanguage({ trajectoryText: "hello" })).toBe("en");
	});
});

describe("normalizeRecordLanguage", () => {
	it("passes zh/en through and rejects the rest", () => {
		expect(normalizeRecordLanguage("zh")).toBe("zh");
		expect(normalizeRecordLanguage("en")).toBe("en");
		expect(normalizeRecordLanguage("auto")).toBeUndefined();
		expect(normalizeRecordLanguage(undefined)).toBeUndefined();
		expect(normalizeRecordLanguage("fr")).toBeUndefined();
	});
});

describe("recordLanguageInstruction", () => {
	it("keeps machine contracts out of the localized surface in both languages", () => {
		expect(recordLanguageInstruction("zh")).toContain("JSON 键名");
		expect(recordLanguageInstruction("en")).toContain("Keep JSON keys");
	});
});
