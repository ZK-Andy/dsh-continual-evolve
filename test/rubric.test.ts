/**
 * Rubric ACL tests: AES-256-GCM envelopes, key precedence, legacy passthrough,
 * and tamper/wrong-key rejection.
 */
import { describe, expect, it } from "vitest";
import {
	DEV_RUBRIC_KEY,
	decryptRubric,
	deriveKey,
	encryptRubric,
	isEncryptedRubric,
	parseEnvelope,
	resolveRubricKey,
} from "../src/rubric.js";

describe("encryptRubric / decryptRubric", () => {
	it("roundtrips plaintext with the same key", () => {
		const key = deriveKey("test-passphrase");
		const envelope = encryptRubric("strict scoring: no regressions", key);
		expect(envelope.startsWith("v1:")).toBe(true);
		expect(envelope).not.toContain("strict scoring");
		expect(decryptRubric(envelope, key)).toBe("strict scoring: no regressions");
	});

	it("produces a fresh iv per encryption (non-deterministic)", () => {
		const key = deriveKey("test-passphrase");
		const a = encryptRubric("same", key);
		const b = encryptRubric("same", key);
		expect(a).not.toBe(b);
	});

	it("rejects a wrong key", () => {
		const envelope = encryptRubric("secret", deriveKey("key-a"));
		expect(() => decryptRubric(envelope, deriveKey("key-b"))).toThrow();
	});

	it("rejects tampered envelopes", () => {
		const key = deriveKey("test-passphrase");
		const envelope = encryptRubric("secret", key);
		const parsed = parseEnvelope(envelope);
		expect(parsed).toBeDefined();
		const tampered = `v1:${[parsed!.iv, parsed!.tag, Buffer.from("AAAA").toString("base64url")].join("|")}`;
		expect(() => decryptRubric(tampered, key)).toThrow();
	});

	it("passes legacy plaintext through unchanged", () => {
		expect(decryptRubric("old plaintext rubric", deriveKey("k"))).toBe("old plaintext rubric");
		expect(isEncryptedRubric("old plaintext rubric")).toBe(false);
		expect(isEncryptedRubric("v1:abc")).toBe(true);
	});

	it("rejects malformed envelopes", () => {
		expect(() => decryptRubric("v1:only-two-parts", deriveKey("k"))).toThrow(/malformed/);
		expect(parseEnvelope("v1:only-two-parts")).toBeUndefined();
	});
});

describe("resolveRubricKey", () => {
	it("prefers the config key over env and dev", () => {
		const warnings: string[] = [];
		const key = resolveRubricKey("config-key", { DSH_EVOLVE_RUBRIC_KEY: "env-key" }, (m) => warnings.push(m));
		expect(key.equals(deriveKey("config-key"))).toBe(true);
		expect(warnings).toHaveLength(0);
	});

	it("falls back to the environment", () => {
		const warnings: string[] = [];
		const key = resolveRubricKey(undefined, { DSH_EVOLVE_RUBRIC_KEY: "env-key" }, (m) => warnings.push(m));
		expect(key.equals(deriveKey("env-key"))).toBe(true);
		expect(warnings).toHaveLength(0);
	});

	it("falls back to the dev key with a warning", () => {
		const warnings: string[] = [];
		const key = resolveRubricKey(undefined, {}, (m) => warnings.push(m));
		expect(key.equals(deriveKey(DEV_RUBRIC_KEY))).toBe(true);
		expect(warnings).toHaveLength(1);
	});
});
