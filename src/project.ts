/**
 * Project scope identity: the third harness layer between session-local
 * staging and the cross-project global store.
 *
 * A project is identified by the session's validated absolute `cwd`
 * (stable slug + sha256, mirroring ZCode's `project-root.ts`), so every
 * session opened in the same workspace shares one project store while
 * different checkouts never collide. All helpers are pure and never throw —
 * a missing cwd simply means "no project layer" (the caller degrades to
 * global+local, the same shape as an empty project store).
 */
import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";

/**
 * Stable project key for a workspace. `workspaceIdentity` (when set)
 * replaces the path as the hash source so renamed checkouts of the same
 * logical project keep one store.
 */
export function resolveProjectKey(workspacePath: string, workspaceIdentity?: string): string {
	const identity = workspaceIdentity?.trim();
	const normalized = resolve(workspacePath);
	const keySource = identity && identity.length > 0 ? identity : process.platform === "win32" ? normalized.toLowerCase() : normalized;
	const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
	const slug = identity && identity.length > 0 ? "project" : sanitizeSlug(basename(normalized) || "project");
	return `${slug}-${hash}`;
}

function sanitizeSlug(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug.length > 0 ? slug : "project";
}

/** Defense for externally supplied keys (explicit opts): single safe segment. */
export function sanitizeProjectKey(key: string): string {
	const cleaned = key
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return cleaned.length > 0 ? cleaned : "project";
}

/** Minimal agent shape the project-key derivation needs (duck-typed). */
export interface ProjectKeyAgentLike {
	session?: {
		header?: {
			cwd?: unknown;
			meta?: { cwd?: unknown };
		};
	};
}

/**
 * Derive the project key from an assembling agent's session cwd. Returns
 * undefined when no validated absolute cwd is present — the caller then
 * skips the project layer rather than failing the whole assembly.
 */
export function projectKeyOf(agent: unknown, opts?: { workspaceIdentity?: string }): string | undefined {
	try {
		const header = (agent as ProjectKeyAgentLike | undefined)?.session?.header;
		const raw = header?.cwd ?? header?.meta?.cwd;
		if (typeof raw !== "string" || raw.trim().length === 0) {
			return undefined;
		}
		const cwd = raw.trim();
		if (!isAbsolute(cwd)) {
			return undefined;
		}
		return resolveProjectKey(cwd, opts?.workspaceIdentity);
	} catch {
		return undefined;
	}
}
