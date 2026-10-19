/**
 * Shared budget measurement (G4 ratchet + src-budgets cap): one home for the
 * line-count and out-degree semantics so the two gates cannot drift apart.
 * Pure, no store access — importable by gates and tests alike.
 */

const STATIC_IMPORT_RE = /^[ \t]*import\s+(?:[^;"']*?\sfrom\s+)?["'](\.[^"']+)["']/gm;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;
const REEXPORT_RE = /^[ \t]*export\s+[^;]*?\sfrom\s+["'](\.[^"']+)["']/gm;

/** wc -l semantics: the number of newline characters. */
export function lineCount(text: string): number {
	let n = 0;
	for (const ch of text) {
		if (ch === "\n") n += 1;
	}
	return n;
}

/** Distinct relative module specifiers (type-only edges count: they still declare a layer direction). */
export function outDegree(text: string): string[] {
	const seen = new Set<string>();
	for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE, REEXPORT_RE]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			const spec = m[1];
			if (spec !== undefined) seen.add(spec.replace(/\.js$/, ""));
		}
	}
	return [...seen];
}
