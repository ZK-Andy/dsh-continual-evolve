/**
 * The agent-context helper: which workspace a session belongs to. A pure
 * function over the host's agent shape (duck-typed, never throws), shared
 * by injection, tools, and both autonomous loops — so it lives in the
 * application-service layer, not in any presentation module.
 */
import { isAbsolute, resolve } from "node:path";

/** Minimal agent shape the helper needs (duck-typed). */
interface CwdAgentLike {
	session?: {
		header?: {
			cwd?: unknown;
			meta?: { cwd?: unknown };
		};
	};
	id?: unknown;
}

/**
 * The assembling agent's validated absolute cwd, or undefined when absent.
 * @param agent - The host agent object (untrusted shape, never throws).
 * @returns The resolved absolute cwd, undefined when missing or relative.
 */
export function cwdOf(agent: unknown): string | undefined {
	try {
		const header = (agent as CwdAgentLike | undefined)?.session?.header;
		const raw = header?.cwd ?? header?.meta?.cwd;
		if (typeof raw !== "string" || raw.trim().length === 0) {
			return undefined;
		}
		const cwd = raw.trim();
		if (!isAbsolute(cwd)) {
			return undefined;
		}
		return resolve(cwd);
	} catch {
		return undefined;
	}
}
