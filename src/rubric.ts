/**
 * Rubric ACL: rubric plaintext never touches the disk. The evaluation runner
 * is the ONLY consumer that decrypts — the optimizer (planner) and the model
 * (with its bash tools) can read benchmark files and see ciphertext only, so
 * rubric isolation is enforced by code, not by prompt construction.
 *
 * Format: `v1:<base64(iv) | base64(tag) | base64(ciphertext)>` — each part is
 * URL-safe base64 without padding, joined by `|`. A value without the `v1:`
 * prefix is treated as legacy plaintext (pre-ACL files) and passes through.
 *
 * Key resolution (first match wins):
 *   1. plugin config `rubricKey`
 *   2. environment `DSH_EVOLVE_RUBRIC_KEY`
 *   3. a per-installation local key file at `<baseDir>/evolve/rubric.key`
 *      (auto-generated with 0600 permissions on first use — every install
 *      gets its own random key, so no user setup is needed and no publicly
 *      known key protects anyone's rubrics)
 *   4. a fixed development key as a last-resort fallback when the key file
 *      can neither be read nor written (warns; only reachable in
 *      pathological environments, since the plugin's stores live under the
 *      same directory)
 * The key string is derived to 32 bytes with SHA-256, so any passphrase works.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The development fallback key — reachable only when the local key file is unusable. */
export const DEV_RUBRIC_KEY = "dsh-continual-evolve-dev-key";

/** Name of the per-installation key file under `<baseDir>/evolve/`. */
export const RUBRIC_KEY_FILE_NAME = "rubric.key";

/** Full path of the per-installation rubric key file. */
export function rubricKeyFilePath(baseDir: string): string {
	return join(baseDir, "evolve", RUBRIC_KEY_FILE_NAME);
}

export interface RubricCipher {
	iv: string;
	tag: string;
	data: string;
}

export const RUBRIC_PREFIX = "v1:";

/** Derive a 32-byte AES-256 key from any passphrase. */
export function deriveKey(passphrase: string): Buffer {
	return createHash("sha256").update(passphrase, "utf8").digest();
}

/** Resolve the effective rubric key with the documented precedence. */
export function resolveRubricKey(
	baseDir: string,
	configKey: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	warn?: (message: string) => void,
): Buffer {
	if (configKey && configKey.length > 0) {
		return deriveKey(configKey);
	}
	const envKey = env["DSH_EVOLVE_RUBRIC_KEY"];
	if (envKey && envKey.length > 0) {
		return deriveKey(envKey);
	}
	return loadOrCreateLocalKey(baseDir, warn);
}

/**
 * Load the per-installation key file, generating a fresh random key (0600)
 * on first use. Falls back to the development key with a warning when the
 * file can neither be read nor written.
 */
function loadOrCreateLocalKey(baseDir: string, warn?: (message: string) => void): Buffer {
	const path = rubricKeyFilePath(baseDir);
	try {
		if (existsSync(path)) {
			const content = readFileSync(path, "utf8").trim();
			if (content.length > 0) {
				return deriveKey(content);
			}
		}
		const key = randomBytes(32).toString("hex");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${key}\n`, { encoding: "utf8", mode: 0o600 });
		return deriveKey(key);
	} catch (cause) {
		warn?.(
			`rubric encryption: cannot read/write the local key file (${path}): ${cause instanceof Error ? cause.message : String(cause)} — using the development key`,
		);
		return deriveKey(DEV_RUBRIC_KEY);
	}
}

/** Encrypt rubric plaintext into the `v1:` envelope (never written raw). */
export function encryptRubric(plaintext: string, key: Buffer): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${RUBRIC_PREFIX}${[iv, tag, data].map((part) => part.toString("base64url")).join("|")}`;
}

/**
 * Decrypt a `v1:` envelope. Legacy plaintext (no prefix) passes through
 * unchanged so pre-ACL benchmark files keep working. Throws on tampered
 * data, a wrong key, or a malformed envelope.
 */
export function decryptRubric(payload: string, key: Buffer): string {
	if (!payload.startsWith(RUBRIC_PREFIX)) {
		return payload; // legacy plaintext file
	}
	const raw = payload.slice(RUBRIC_PREFIX.length);
	const parts = raw.split("|");
	if (parts.length !== 3) {
		throw new Error("rubric: malformed encrypted envelope");
	}
	const [ivText, tagText, dataText] = parts as [string, string, string];
	const iv = Buffer.from(ivText, "base64url");
	const tag = Buffer.from(tagText, "base64url");
	const data = Buffer.from(dataText, "base64url");
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** True when a stored rubric is an encrypted envelope rather than legacy plaintext. */
export function isEncryptedRubric(payload: string): boolean {
	return payload.startsWith(RUBRIC_PREFIX);
}

/** Shape helper for tests and callers that inspect envelopes. */
export function parseEnvelope(payload: string): RubricCipher | undefined {
	if (!isEncryptedRubric(payload)) return undefined;
	const parts = payload.slice(RUBRIC_PREFIX.length).split("|");
	if (parts.length !== 3) return undefined;
	const [iv, tag, data] = parts as [string, string, string];
	return { iv, tag, data };
}
