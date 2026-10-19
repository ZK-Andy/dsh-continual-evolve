/**
 * Shared field helpers for the unified tool executors: string narrowing
 * and the read-limit clamp. One copy — the two kind executors
 * (`evolve-memory.js`, `evolve-skills.js`) and the
 * dispatcher (`evolve-tools.js`) all import from here.
 */

/**
 * Narrow an unknown tool argument to a string field.
 * @param value - The raw argument value.
 * @returns The string, or undefined when absent or mistyped.
 */
export function stringField(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Clamp a read limit to 1..10, defaulting to 3 on garbage.
 * @param value - The raw limit argument.
 * @returns The clamped limit.
 */
export function clampLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 3;
	}
	return Math.min(10, Math.max(1, Math.floor(value)));
}
