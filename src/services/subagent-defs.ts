/**
 * Every subagent this plugin runs, declared in one table.
 *
 * A definition carries the job's identity, its whole instruction (system
 * prompt), its output-budget fallback and its answer parser. Feature code
 * loads definitions from here and never writes a prompt or a budget inline;
 * adding a job means adding a row, and a job with no row cannot be called.
 *
 * The four review jobs are separate definitions on purpose: the memory rubric
 * requires a memory to survive having its repo name stripped, while a project
 * skill is *supposed* to be repo-bound, so one prompt cannot serve both.
 */
import {
	EXTRACTION_CHEAP_SYSTEM_PROMPT,
	EXTRACTION_SYSTEM_PROMPT,
	parseCheapAnswer,
	parseExtractionAnswer,
	type CheapVerdict,
	type ParsedAnswer,
} from "./extraction-prompt.js";
import {
	parseEvolveAnswer,
	parseGateAnswer,
	REVIEW_MEMORY_CHEAP_SYSTEM_PROMPT,
	REVIEW_MEMORY_SYSTEM_PROMPT,
	REVIEW_SKILL_CHEAP_SYSTEM_PROMPT,
	REVIEW_SKILL_SYSTEM_PROMPT,
	type EvolveVerdict,
	type GateVerdict,
} from "./review-prompt.js";
import { dateBaseline } from "./prompt-date.js";
import type { SubagentContext, SubagentDefinition } from "./subagent.js";

/**
 * Output-budget fallbacks, used only for adapters that advertise no
 * per-request cap of their own. A gate verdict is one JSON object plus the
 * reasoning a thinking model spends before emitting it; the evolve/proposal
 * calls additionally carry full replacement bodies.
 */
export const GATE_MAX_TOKENS = 1024;
export const EVOLVE_MAX_TOKENS = 4096;
export const EXTRACTION_MAX_TOKENS = 4096;

/**
 * Bind one instruction to the run's clock.
 *
 * Every job here reads item text that can name dates, and a direct call
 * carries no clock of its own — so "today" is instruction, not data, and it
 * arrives as the same appended line for every job in the ring.
 */
const withDateBaseline = (instruction: string) => (context: SubagentContext): string =>
	`${instruction}\n\n${dateBaseline(context.today)}`;

/** The memory cheap gate: is this entry worth a close look at all? */
export const reviewGateMemory: SubagentDefinition<GateVerdict | null> = {
	id: "review-gate-memory",
	system: withDateBaseline(REVIEW_MEMORY_CHEAP_SYSTEM_PROMPT),
	maxTokens: GATE_MAX_TOKENS,
	parse: (text) => parseGateAnswer(text),
};

/** The skill cheap gate: same question, scope-relative home rules. */
export const reviewGateSkill: SubagentDefinition<GateVerdict | null> = {
	id: "review-gate-skill",
	system: withDateBaseline(REVIEW_SKILL_CHEAP_SYSTEM_PROMPT),
	maxTokens: GATE_MAX_TOKENS,
	parse: (text) => parseGateAnswer(text),
};

/** The memory evolve pass: five-dimension judgment plus the proposed rewrite. */
export const reviewEvolveMemory: SubagentDefinition<EvolveVerdict | null> = {
	id: "review-evolve-memory",
	system: withDateBaseline(REVIEW_MEMORY_SYSTEM_PROMPT),
	maxTokens: EVOLVE_MAX_TOKENS,
	parse: (text) => parseEvolveAnswer(text),
};

/** The skill evolve pass: scope-relative reuse, executability, duplication. */
export const reviewEvolveSkill: SubagentDefinition<EvolveVerdict | null> = {
	id: "review-evolve-skill",
	system: withDateBaseline(REVIEW_SKILL_SYSTEM_PROMPT),
	maxTokens: EVOLVE_MAX_TOKENS,
	parse: (text) => parseEvolveAnswer(text),
};

/** The extraction pre-gate: does this increment hold anything worth proposing? */
export const extractionGate: SubagentDefinition<CheapVerdict | null> = {
	id: "extraction-gate",
	system: withDateBaseline(EXTRACTION_CHEAP_SYSTEM_PROMPT),
	maxTokens: GATE_MAX_TOKENS,
	parse: (text) => parseCheapAnswer(text),
};

/** The extraction proposal call: the run's one expensive call. */
export const extractionMain: SubagentDefinition<ParsedAnswer> = {
	id: "extraction-main",
	system: withDateBaseline(EXTRACTION_SYSTEM_PROMPT),
	maxTokens: EXTRACTION_MAX_TOKENS,
	parse: (text) => parseExtractionAnswer(text),
};

/** Every definition, for the "which jobs exist" read and the id-uniqueness check. */
export const SUBAGENT_DEFINITIONS: readonly SubagentDefinition<unknown>[] = [
	reviewGateMemory,
	reviewGateSkill,
	reviewEvolveMemory,
	reviewEvolveSkill,
	extractionGate,
	extractionMain,
];

/** The gate definition one review candidate loads, by item kind. */
export const REVIEW_GATE_BY_KIND: Readonly<Record<"memory" | "skill", SubagentDefinition<GateVerdict | null>>> = {
	memory: reviewGateMemory,
	skill: reviewGateSkill,
};

/** The evolve definition one review candidate loads, by item kind. */
export const REVIEW_EVOLVE_BY_KIND: Readonly<Record<"memory" | "skill", SubagentDefinition<EvolveVerdict | null>>> = {
	memory: reviewEvolveMemory,
	skill: reviewEvolveSkill,
};
