/**
 * The evaluation matrix runner: executes every case × run as a TWO-STAGE
 * structured-output subagent pair, with the provider/model frozen to the
 * calling agent's own route.
 *
 * Stage 1 — executor: a fresh child performs the case task with its tools
 * and records CONCRETE EVIDENCE of what it did and found. It NEVER sees the
 * rubric (gap A1, evaluator/scorer separation): the agent under test cannot
 * optimize its behavior toward the grading criteria, and cannot grade its
 * own execution.
 *
 * Stage 2 — reviewer: an INDEPENDENT child grades the executor's evidence
 * strictly against the rubric. The rubric plaintext is decrypted in the host
 * and flows ONLY into this reviewer branch; the executor branch never
 * touches it. A separate model instance grading someone else's evidence
 * removes the self-serving bias of self-scoring.
 *
 * Failure-cell protocol (gap A2): a unit that cannot produce a score
 * (decrypt error, executor crash, reviewer crash, protocol error) returns a
 * cell with `status: "failed"` — NEVER a zero — so aggregation can exclude
 * it and the acceptance rule can reject rounds with too many failures instead
 * of silently averaging a 0 into the mean.
 *
 * Each cell carries the executor child's session id (gap A4): the score can
 * be drilled back to the exact session transcript that produced the evidence.
 *
 * Uses the host-plane `subagents` service (available in every profile) with
 * the native `outputSchema` structured-output seam: the provider validates
 * each child's reply against its cell schema, so the host never parses model
 * text for evaluations. (The workflow engine was rejected because the web
 * profile keeps it in a per-agent isolated realm a host plugin cannot
 * resolve.)
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createHash } from "node:crypto";
import type { BenchmarkCase, CellScore } from "./benchmark.js";
import { mapPool } from "./pool.js";
import { decryptRubric, deriveKey, DEV_RUBRIC_KEY } from "./rubric.js";

/** Key used when the caller did not resolve one: mirrors resolveRubricKey's last-resort dev fallback. */
function devRubricKey(): Buffer {
	return deriveKey(DEV_RUBRIC_KEY);
}

export interface EvaluateOptions {
	cases: readonly BenchmarkCase[];
	runs: number;
	passThreshold: number;
	/** Serialized harness state under test (the candidate's guidance). */
	harnessOverview: string;
	label: string;
	/** AES-256 key for the encrypted rubric envelopes (see src/rubric.ts). */
	rubricKey?: Buffer;
	signal?: AbortSignal;
}

/** Stage 1: the agent under test — sees the task, never the rubric. */
const EXECUTOR_SYSTEM_PROMPT = `You are one evaluation unit in a benchmark matrix.

You are the agent under evaluation. Perform the case task using your tools.
You are NOT asked to grade yourself: a separate evaluator will judge your
work against criteria you do not see. Instead, record CONCRETE, VERIFIABLE
EVIDENCE of what you did and found — the actual commands/reads you performed,
what the harness state contains, the exact text you produced. Evidence is
what your work will be scored from; vague self-assessment earns nothing.

The harness guidance attached to the state under test is included in the task.
Your reply is structured (see the requested output schema): caseId, run, and
evidence (the concrete artifact/report of your execution).`;

/** Stage 2: the independent grader — sees the rubric, never executes the task. */
const REVIEWER_SYSTEM_PROMPT = `You are an independent evaluator in a benchmark matrix.

You did NOT perform the task and you cannot interact with the runtime: grade
strictly from the EVIDENCE produced by the agent under evaluation, against
the rubric. The harness guidance under test is included for context so you
can judge whether the evidence genuinely reflects the state under test
(e.g. whether the agent actually inspected the harness store).

Score YOUR JUDGMENT of the evidence against the rubric criteria: a
0-100 score, and passed (true iff score >= the stated threshold). Cite in
notes the concrete rubric criteria and the evidence that supports the score.
Do not inflate: grade the evidence as presented, not what the agent might
have meant.`;

const EXECUTOR_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		caseId: { type: "string" },
		run: { type: "number" },
		evidence: { type: "string" },
	},
	required: ["caseId", "run", "evidence"],
};

const CELL_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		caseId: { type: "string" },
		run: { type: "number" },
		score: { type: "number" },
		passed: { type: "boolean" },
		notes: { type: "string" },
	},
	required: ["caseId", "run", "score", "passed", "notes"],
};

interface SubagentsService {
	start(
		name: string,
		request: {
			label?: string;
			prompt: { type: "text"; text: string }[];
			parent: Agent;
			signal: AbortSignal;
			outputSchema?: unknown;
		},
	): Promise<{
		/** The child's session id (Trace evidence pointer, gap A4). */
		id: string;
		result: Promise<{ output?: { type: string; text?: string }[]; structured?: unknown; stopReason?: string }>;
		dispose(): void;
	}>;
}

export interface EvaluationOutcome {
	label: string;
	cells: CellScore[];
	stopReason: string;
}

/** How many evaluation units may run concurrently (bounded subagent fan-out). */
export const DEFAULT_EVALUATION_CONCURRENCY = 4;

/** Evidence handed to the reviewer is capped so the grading call stays bounded. */
export const MAX_EVIDENCE_CHARS = 8000;

export async function evaluateState(ctx: Context, agent: Agent, options: EvaluateOptions): Promise<EvaluationOutcome> {
	if (!agent.options.provider || !agent.options.model) {
		throw new Error("evolve: benchmark evaluation requires a provider/model route");
	}
	const subagents = (ctx as unknown as { subagents?: SubagentsService }).subagents;
	if (!subagents) {
		throw new Error("evolve: benchmark evaluation requires the subagents service");
	}
	const units: { case: BenchmarkCase; run: number }[] = [];
	for (const c of options.cases) {
		for (let run = 1; run <= options.runs; run += 1) {
			units.push({ case: c, run });
		}
	}
	const cells = await mapPool(units, DEFAULT_EVALUATION_CONCURRENCY, (unit) =>
		runUnit(subagents, agent, options, unit.case, unit.run),
	);
	return { label: options.label, cells, stopReason: "completed" };
}

export interface ExecutorResult {
	caseId: string;
	run: number;
	evidence: string;
}

/** A cell that could not be produced: never a zero, excluded by aggregation. */
function failedCell(caseId: string, run: number, message: string): CellScore {
	return { caseId, run, status: "failed", score: 0, passed: false, notes: message };
}

/**
 * Deterministic hash of a case's statement + rubric envelope (gap A3):
 * a 16-char SHA-256 prefix, hex-encoded. Used to detect material changes
 * between reference and candidate evaluation runs.
 */
function caseHash(caseItem: BenchmarkCase): string {
	const material = `${caseItem.statement}\n${caseItem.rubric}`;
	return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

async function runUnit(
	subagents: SubagentsService,
	agent: Agent,
	options: EvaluateOptions,
	c: BenchmarkCase,
	run: number,
): Promise<CellScore> {
	// Gap C3: track wall-clock duration of the entire cell evaluation.
	const cellStart = Date.now();

	// The ONLY rubric decryption point: the envelope is opened here, in the
	// host, and the plaintext goes ONLY into the reviewer prompt — the
	// executor branch never touches it (gap A1).
	let rubric: string;
	try {
		rubric = decryptRubric(c.rubric, options.rubricKey ?? devRubricKey());
	} catch (cause) {
		return { ...failedCell(c.id, run, `rubric decrypt failed: ${cause instanceof Error ? cause.message : String(cause)}`), durationMs: Date.now() - cellStart };
	}

	// Runtime evidence (gap A3): record actual provider/model from the host,
	// and compute a material hash of the case for change detection.
	const actualProvider = agent.options.provider ?? "unknown";
	const actualModel = agent.options.model ?? "unknown";
	const hash = caseHash(c);

	// Stage 1: executor — task + evidence, NO rubric.
	let evidence: ExecutorResult;
	let sessionId: string | undefined;
	try {
		const executorRun = await subagents.start("spawn", {
			label: `${c.id} r${run} execute`,
			prompt: [
				{
					type: "text",
					text: [
						EXECUTOR_SYSTEM_PROMPT,
						"---",
						"Your harness guidance (state under test):",
						`<harness_overview>\n${options.harnessOverview}\n</harness_overview>`,
						`Case ${c.id} — task (statement):\n${c.statement}`,
						`Run ${run} of ${options.runs}.`,
						"Execute the task with your tools, then produce the structured evidence.",
					].join("\n\n"),
				},
			],
			parent: agent,
			signal: options.signal ?? new AbortController().signal,
			outputSchema: EXECUTOR_SCHEMA,
		});
		try {
			const settled = await executorRun.result;
			if (settled.stopReason !== "completed") {
				throw new Error(`executor stopped: ${settled.stopReason ?? "unknown"}`);
			}
			const parsed =
				normalizeExecutor(settled.structured, c.id, run) ?? fromEvidenceText(settled.output, c.id, run);
			if (!parsed) {
				throw new Error("executor returned neither a structured value nor usable text");
			}
			evidence = parsed;
			sessionId = executorRun.id || undefined;
		} finally {
			executorRun.dispose();
		}
	} catch (cause) {
		return { ...failedCell(c.id, run, `executor failed: ${cause instanceof Error ? cause.message : String(cause)}`), provider: actualProvider, model: actualModel, caseHash: hash, durationMs: Date.now() - cellStart };
	}

	// Stage 2: independent reviewer — rubric + evidence, NO task execution.
	try {
		const reviewerRun = await subagents.start("spawn", {
			label: `${c.id} r${run} grade`,
			prompt: [
				{
					type: "text",
					text: [
						REVIEWER_SYSTEM_PROMPT,
						"---",
						"Your harness guidance (state under test):",
						`<harness_overview>\n${options.harnessOverview}\n</harness_overview>`,
						`Case ${c.id} — task (statement):\n${c.statement}`,
						`Rubric — grade the evidence strictly against these criteria:\n${rubric}`,
						`Evidence produced by the agent under evaluation:\n<evidence>\n${trimEvidence(evidence.evidence)}\n</evidence>`,
						`Run ${run} of ${options.runs}. passThreshold = ${options.passThreshold}.`,
						"Produce the structured score.",
					].join("\n\n"),
				},
			],
			parent: agent,
			signal: options.signal ?? new AbortController().signal,
			outputSchema: CELL_SCHEMA,
		});
		try {
			const settled = await reviewerRun.result;
			if (settled.stopReason !== "completed") {
				throw new Error(`reviewer stopped: ${settled.stopReason ?? "unknown"}`);
			}
			const cell =
				normalizeCell(settled.structured, c.id, run, options.passThreshold) ??
				fromOutputText(settled.output, c.id, run, options.passThreshold);
			if (!cell) {
				throw new Error("reviewer returned neither a structured value nor usable text");
			}
			return { ...cell, ...(sessionId !== undefined ? { sessionId } : {}), provider: actualProvider, model: actualModel, caseHash: hash, durationMs: Date.now() - cellStart };
		} finally {
			reviewerRun.dispose();
		}
	} catch (cause) {
		return { ...failedCell(c.id, run, `reviewer failed: ${cause instanceof Error ? cause.message : String(cause)}`), provider: actualProvider, model: actualModel, caseHash: hash, durationMs: Date.now() - cellStart };
	}
}

/** Cap the evidence handed to the reviewer so the grading call stays bounded. */
function trimEvidence(text: string): string {
	if (text.length <= MAX_EVIDENCE_CHARS) return text;
	return `${text.slice(0, MAX_EVIDENCE_CHARS)}\n…[evidence truncated at ${MAX_EVIDENCE_CHARS} chars]`;
}

/** Validate a provider-validated executor result; returns undefined when malformed. */
export function normalizeExecutor(value: unknown, caseId: string, run: number): ExecutorResult | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const evidence = typeof record["evidence"] === "string" ? record["evidence"] : "";
	if (evidence.trim().length === 0) return undefined;
	return {
		caseId: typeof record["caseId"] === "string" && record["caseId"].length > 0 ? record["caseId"] : caseId,
		run: typeof record["run"] === "number" && Number.isFinite(record["run"]) ? Math.trunc(record["run"]) : run,
		evidence,
	};
}

/** Fallback: recover the executor result from its text blocks when no structured value arrived. */
function fromEvidenceText(
	blocks: { type: string; text?: string }[] | undefined,
	caseId: string,
	run: number,
): ExecutorResult | undefined {
	if (!Array.isArray(blocks)) return undefined;
	const text = blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	try {
		return normalizeExecutor(JSON.parse(trimmed) as unknown, caseId, run);
	} catch {
		// Not JSON — keep the raw text as the evidence.
		return { caseId, run, evidence: trimmed };
	}
}

/** Validate a provider-validated structured cell; returns undefined when malformed. */
export function normalizeCell(value: unknown, caseId: string, run: number, passThreshold: number): CellScore | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const score = Number(record["score"]);
	if (!Number.isFinite(score)) return undefined;
	return {
		caseId: typeof record["caseId"] === "string" && record["caseId"].length > 0 ? record["caseId"] : caseId,
		run: typeof record["run"] === "number" && Number.isFinite(record["run"]) ? Math.trunc(record["run"]) : run,
		status: "ok",
		score: Math.min(100, Math.max(0, score)),
		passed: record["passed"] === true || score >= passThreshold,
		notes: typeof record["notes"] === "string" ? record["notes"] : "",
	};
}

/** Fallback: recover a cell from the child's text blocks when no structured value arrived. */
function fromOutputText(
	blocks: { type: string; text?: string }[] | undefined,
	caseId: string,
	run: number,
	passThreshold: number,
): CellScore | undefined {
	if (!Array.isArray(blocks)) return undefined;
	const text = blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	if (text.length === 0) return undefined;
	try {
		const value = JSON.parse(text) as unknown;
		return normalizeCell(value, caseId, run, passThreshold);
	} catch {
		return undefined;
	}
}