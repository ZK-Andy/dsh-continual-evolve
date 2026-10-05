/**
 * One-time migration from the MD-era store: `<workspace>/.evolve/memory/`
 * files are imported into the central database under the workspace's own
 * partition, then the directory is renamed aside (`memory-imported-<date>/`)
 * — never deleted. Runs lazily per workspace on first contact (injection
 * assembly or card read); the `md-imported` state flag keeps it idempotent
 * even when the rename fails.
 *
 * Import is lossless by design: unknown types map to `reference`, missing
 * hooks are synthesized from the body, and only the hard gates (secret
 * screen) can skip a file — skipped files stay in the renamed directory for
 * manual salvage.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { slugifyId, type MemoryType } from "./memory-rules.js";
import { MD_IMPORT_STATE_KEY, type MemoryStore } from "./store.js";

/** The MD-era index file (imported rows come from the other .md files). */
const MD_INDEX_FILE = "MEMORY.md";

/** What one workspace's migration did. */
export interface MdImportResult {
	workspaceId: string;
	/** Records imported (existing ids from a partial earlier run don't count). */
	imported: number;
	/** Records skipped by a hard gate (reasons in `errors`). */
	skipped: number;
	/** The renamed-aside directory, when the rename succeeded. */
	archiveDir: string | null;
	errors: string[];
}

/** Run the migration for one workspace root. Never throws past its result. */
export function importWorkspaceMd(store: MemoryStore, cwd: string): MdImportResult {
	const workspaceId = cwd;
	const absent: MdImportResult = { workspaceId, imported: 0, skipped: 0, archiveDir: null, errors: [] };
	if (store.state(workspaceId, MD_IMPORT_STATE_KEY) !== undefined) {
		return absent;
	}
	const memoryDir = join(cwd, ".evolve", "memory");
	if (!existsSync(memoryDir) || !statSync(memoryDir).isDirectory()) {
		store.setState(workspaceId, MD_IMPORT_STATE_KEY, new Date().toISOString());
		return absent;
	}
	const result = importMemoryDir(store, workspaceId, memoryDir);
	const archiveDir = renameAside(memoryDir);
	if (archiveDir !== null) {
		result.archiveDir = archiveDir;
	} else {
		result.errors.push("the old directory could not be renamed; import flag set anyway (imports are idempotent)");
	}
	store.setState(workspaceId, MD_IMPORT_STATE_KEY, new Date().toISOString());
	return result;
}

/** Import every non-index .md file of an MD-era store directory. */
function importMemoryDir(store: MemoryStore, workspaceId: string, memoryDir: string): MdImportResult {
	const result: MdImportResult = { workspaceId, imported: 0, skipped: 0, archiveDir: null, errors: [] };
	const files = readdirSync(memoryDir)
		.filter((file) => file.endsWith(".md") && file !== MD_INDEX_FILE)
		.sort();
	for (const file of files) {
		try {
			const parsed = parseMdMemory(readFileSync(join(memoryDir, file), "utf8"), basename(file, ".md"));
			if (store.get(workspaceId, parsed.id) !== undefined) {
				continue;
			}
			const outcomes = store.applyProposals(
				{ workspaceId, trigger: "import", decision: `md migration: ${file}` },
				[
					{
						action: "create",
						id: parsed.id,
						type: parsed.type,
						title: parsed.title,
						description: parsed.description,
						body: parsed.body,
					},
				],
			);
			if (outcomes[0]?.ok === true) {
				result.imported += 1;
			} else {
				result.skipped += 1;
				result.errors.push(`${file}: ${outcomes[0]?.reason ?? "unknown rejection"}`);
			}
		} catch (error) {
			result.skipped += 1;
			result.errors.push(`${file}: unreadable (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	return result;
}

/** A parsed MD-era memory file. */
interface ParsedMdMemory {
	id: string;
	type: MemoryType;
	title: string;
	description: string;
	body: string;
}

const VALID_TYPES: readonly string[] = ["user", "feedback", "reference"];

/**
 * Parse one MD-era file: frontmatter `name` / `description` / `type` (type
 * may sit under a `metadata:` block), body = everything after the closing
 * `---`. Anything missing or malformed is synthesized from the filename and
 * body rather than dropped — migration must not lose.
 */
function parseMdMemory(text: string, fileBase: string): ParsedMdMemory {
	const fields = { name: "", description: "", type: "" };
	let body = text;
	if (text.startsWith("---")) {
		const blockEnd = text.indexOf("\n---", 3);
		if (blockEnd >= 0) {
			for (const line of text.slice(3, blockEnd).split("\n")) {
				const match = /^(name|description|type):\s*(.*)$/.exec(line.trim());
				if (match?.[1] !== undefined && match?.[2] !== undefined) {
					const key = match[1] as keyof typeof fields;
					fields[key] = match[2].trim().replace(/^["']|["']$/g, "");
				}
			}
			body = text.slice(blockEnd + 4);
		}
	}
	const title = fields.name.length > 0 ? fields.name : fileBase;
	const type = (VALID_TYPES.includes(fields.type) ? fields.type : "reference") as MemoryType;
	const description = fields.description.length > 0 ? fields.description : firstLine(body, 200);
	return {
		id: fields.name.length > 0 && slugifyId(fields.name) === fields.name ? fields.name : slugifyId(title),
		type,
		title,
		description: description.length > 0 ? description : fileBase,
		body: body.trim().length > 0 ? body.trim() : fields.name,
	};
}

/** First non-empty line, capped — the synthesized relevance hook. */
function firstLine(text: string, cap: number): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim().replace(/^#+\s*/, "").replace(/^-\s*/, "");
		if (trimmed.length > 0) {
			return trimmed.length > cap ? `${trimmed.slice(0, cap - 1)}…` : trimmed;
		}
	}
	return "";
}

/** Rename the imported directory aside; null when the rename failed. */
function renameAside(memoryDir: string): string | null {
	const stamp = new Date().toISOString().slice(0, 10);
	const base = join(memoryDir, "..", `memory-imported-${stamp}`);
	let target = base;
	for (let attempt = 2; existsSync(target); attempt += 1) {
		target = `${base}-${attempt}`;
	}
	try {
		renameSync(memoryDir, target);
		return target;
	} catch {
		return null;
	}
}
