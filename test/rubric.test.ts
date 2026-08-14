/**
 * Rubric ACL tests: AES-256-GCM envelopes, key precedence (config → env →
 * per-installation key file → dev fallback), legacy passthrough, and
 * tamper/wrong-key rejection.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import {
	DEV_RUBRIC_KEY,
	RUBRIC_KEY_FILE_NAME,
	decryptRubric,
	deriveKey,
	encryptRubric,
	isEncryptedRubric,
	parseEnvelope,
	resolveRubricKey,
	rubricKeyFilePath,
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
	function makeBaseDir(): string {
		return mkdtempSync(join(tmpdir(), "evolve-rubric-"));
	}

	it("prefers the config key over env, the key file, and dev", () => {
		const baseDir = makeBaseDir();
		try {
			const warnings: string[] = [];
			const key = resolveRubricKey(baseDir, "config-key", { DSH_EVOLVE_RUBRIC_KEY: "env-key" }, (m) => warnings.push(m));
			expect(key.equals(deriveKey("config-key"))).toBe(true);
			expect(warnings).toHaveLength(0);
			// explicit config must not create a key file
			expect(existsSync(rubricKeyFilePath(baseDir))).toBe(false);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("falls back to the environment before the key file", () => {
		const baseDir = makeBaseDir();
		try {
			const warnings: string[] = [];
			const key = resolveRubricKey(baseDir, undefined, { DSH_EVOLVE_RUBRIC_KEY: "env-key" }, (m) => warnings.push(m));
			expect(key.equals(deriveKey("env-key"))).toBe(true);
			expect(warnings).toHaveLength(0);
			expect(existsSync(rubricKeyFilePath(baseDir))).toBe(false);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("generates a per-installation key file (0600) on first use", () => {
		const baseDir = makeBaseDir();
		try {
			const warnings: string[] = [];
			const key = resolveRubricKey(baseDir, undefined, {}, (m) => warnings.push(m));
			expect(warnings).toHaveLength(0);
			const path = rubricKeyFilePath(baseDir);
			expect(existsSync(path)).toBe(true);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			const stored = readFileSync(path, "utf8").trim();
			expect(stored.length).toBeGreaterThan(0);
			expect(key.equals(deriveKey(stored))).toBe(true);
			// not the publicly known dev key
			expect(key.equals(deriveKey(DEV_RUBRIC_KEY))).toBe(false);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("reuses an existing key file across calls", () => {
		const baseDir = makeBaseDir();
		try {
			const a = resolveRubricKey(baseDir, undefined, {});
			const b = resolveRubricKey(baseDir, undefined, {});
			expect(a.equals(b)).toBe(true);
			expect(readFileSync(rubricKeyFilePath(baseDir), "utf8").trim()).toHaveLength(64); // 32 random bytes in hex
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("honors a pre-existing key file", () => {
		const baseDir = makeBaseDir();
		try {
			mkdirSync(join(baseDir, "evolve"), { recursive: true });
			writeFileSync(rubricKeyFilePath(baseDir), "my-own-passphrase\n", { encoding: "utf8", mode: 0o600 });
			const warnings: string[] = [];
			const key = resolveRubricKey(baseDir, undefined, {}, (m) => warnings.push(m));
			expect(key.equals(deriveKey("my-own-passphrase"))).toBe(true);
			expect(warnings).toHaveLength(0);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("falls back to the dev key with a warning when the key file is unusable", () => {
		const baseDir = makeBaseDir();
		try {
			// baseDir is a regular file, so evolve/rubric.key cannot be created
			const notADir = join(baseDir, "not-a-directory");
			writeFileSync(notADir, "x");
			const warnings: string[] = [];
			const key = resolveRubricKey(notADir, undefined, {}, (m) => warnings.push(m));
			expect(key.equals(deriveKey(DEV_RUBRIC_KEY))).toBe(true);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toMatch(/development key/);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("exposes the key file path and name for tooling", () => {
		expect(RUBRIC_KEY_FILE_NAME).toBe("rubric.key");
		expect(rubricKeyFilePath("/base")).toBe(join("/base", "evolve", "rubric.key"));
	});
});
