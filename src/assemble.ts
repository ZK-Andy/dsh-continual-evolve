/**
 * Shared mount assembly: the four host wirings — tools, extraction,
 * review, and the bundled creator skills. Split
 * out of the plugin entry so the entry keeps only config, host shapes, and
 * the apply orchestration — this module owns the nested-inject mounting the
 * entry delegates. Config unpacking (volatile `.get()`) stays the entry's
 * job: these functions only receive the resolved config the entry built.
 */
import { createExtractionScheduler, type LlmRuntime, type SchedulerHost } from "./services/extraction.js";
import { resolveCallRoute, type RouteResolver } from "./services/model-route.js";
import { createReviewScheduler, type ReviewSchedulerHost } from "./services/review-scheduler.js";
import type { SurfaceReader } from "./services/extraction-surface.js";
import { registerEvolveTools } from "./surfaces/evolve-tools.js";
import { packageAssetsDir, registerCreatorSkills } from "./surfaces/skill-provider.js";
import type { PluginLog } from "./services/plugin-log.js";
import type { MemoryStore } from "./store.js";
import type { HostContext, NestedInjectHost } from "./index.js";

/** Mutable plugin state the async store open fills in. */
export interface StoreState {
	store: MemoryStore | undefined;
	toolsAvailable: boolean;
}

/**
 * Build the route resolver a scheduler uses for its direct calls: the
 * session's current selection, its last request header, the agent's
 * creation-time options, the host's default model — the host's own order of
 * truth (`llm-call.ts` §The route).
 *
 * Both host services are read through `ctx.get` on every call and never join
 * an inject list — a host without them (or an older one) must keep working, and
 * their absence only moves the answer down the chain.
 */
function routeResolverOf(scoped: unknown, get: ((name: string) => unknown) | undefined): RouteResolver | undefined {
	if (typeof get !== "function") {
		return undefined;
	}
	const read = get.bind(scoped);
	return (agent: unknown) => resolveCallRoute(agent, read);
}

/**
 * Keep one scheduler's disposer on the owning fiber.
 *
 * Without this a remount (HMR, a live config edit) leaves the previous
 * listeners attached: two schedulers then drain the same boundary, and the
 * older one holds an LLM service the remount already replaced.
 */
function registerSchedulerDisposer(scoped: unknown, dispose: () => void): void {
	const effect = (scoped as { effect?: unknown }).effect;
	if (typeof effect === "function") {
		(effect as (callback: () => () => void) => unknown).call(scoped, () => dispose);
	}
}

/** Register the unified tools through a nested inject (see evolve-tools.ts). */
export function mountToolsWhenAvailable(host: HostContext, store: MemoryStore, state: StoreState, log: PluginLog): void {
	const nested = host as HostContext & Partial<NestedInjectHost>;
	if (typeof nested.inject !== "function") {
		log.warn(
			"tools-not-mounted",
			"host context exposes no inject — memory tools not registered (injection unaffected; explicit memory management falls back to telling the user)",
		);
		return;
	}
	nested.inject(["tools"], (scoped: unknown) => {
		const tools = (scoped as { tools?: unknown }).tools;
		if (tools === undefined || typeof (tools as { register?: unknown }).register !== "function") {
			log.warn(
				"tools-empty",
				"tools service present but empty — memory tools not registered (injection unaffected)",
			);
			return;
		}
		registerEvolveTools(tools as Parameters<typeof registerEvolveTools>[0], store);
		state.toolsAvailable = true;
		log.info("evolve-tools-registered", "evolve_write and evolve_read registered");
	});
}

/**
 * Arm the extraction scheduler through a nested inject: the session reader
 * and LLM services are siblings, so they are resolved inside the scoped
 * context while the event listeners use the plugin's own context. A host
 * without either service (or without `.on`) simply never arms — injection
 * and the explicit tools remain functional.
 */
export function mountExtractionWhenAvailable(host: HostContext, store: MemoryStore, extractionEnabled: boolean, log: PluginLog): void {
	if (!extractionEnabled) {
		log.info("extraction-disabled", "extraction disabled by config — injection and evolve_write remain active");
		return;
	}
	const nested = host as HostContext & Partial<NestedInjectHost>;
	const events = host as HostContext & Partial<SchedulerHost>;
	const on = events.on;
	if (typeof nested.inject !== "function" || typeof on !== "function") {
		log.warn("extraction-not-armed", "host context exposes no inject/on — extraction not armed (injection and tools unaffected)");
		return;
	}
	const schedulerHost: SchedulerHost = { on: (event, handler) => on.call(events, event, handler), log };
	nested.inject(["sessionQuery", "llm"], (scoped: unknown) => {
		const context = scoped as {
			sessionQuery?: unknown;
			llm?: unknown;
			get?: (name: string) => unknown;
		};
		const surface = context.sessionQuery as SurfaceReader | undefined;
		const llm = (context.llm ?? context.get?.("llm")) as LlmRuntime | undefined;
		if (surface === undefined || typeof surface.readSurface !== "function") {
			log.warn("extraction-no-surface", "sessionQuery service present but empty — extraction not armed (injection and tools unaffected)");
			return;
		}
		const resolveRoute = routeResolverOf(scoped, context.get);
		registerSchedulerDisposer(scoped, createExtractionScheduler(schedulerHost, {
			store, surface, llm,
			...(resolveRoute === undefined ? {} : { resolveRoute }),
		}));
	});
}

/**
 * Per-drain review timings, re-read live on every drain (volatile config).
 * Built by the assembly root (the only place that unpacks volatile config);
 * this module only receives the entry-built reader and switch.
 */
export interface ReviewTimings {
	dryRun: boolean;
	dailyBudget: number;
	batchSize: number;
	staleDays: number;
}

/** What the review loop needs from config: a mount-time switch plus a live reader. */
export interface ReviewSchedule {
	enabled: boolean;
	read(): ReviewTimings;
}

/**
 * Arm the review scheduler through a nested inject: the loop needs only the
 * LLM sibling (no trajectory reader — it judges stored items, not session
 * increments), so it mounts independently from extraction. Own prompts, own
 * budget, own ledger; the store's write gates are the only shared surface.
 */
export function mountReviewWhenAvailable(host: HostContext, store: MemoryStore, review: ReviewSchedule, log: PluginLog): void {
	if (review.enabled === false) {
		log.info("review-disabled", "review disabled by config — extraction and tools unaffected");
		return;
	}
	const nested = host as HostContext & Partial<NestedInjectHost>;
	const events = host as HostContext & Partial<ReviewSchedulerHost>;
	const on = events.on;
	if (typeof nested.inject !== "function" || typeof on !== "function") {
		log.warn("review-not-armed", "host context exposes no inject/on — review not armed (injection and tools unaffected)");
		return;
	}
	const schedulerHost: ReviewSchedulerHost = { on: (event, handler) => on.call(events, event, handler), log };
	nested.inject(["llm"], (scoped: unknown) => {
		const context = scoped as { llm?: unknown; get?: (name: string) => unknown };
		const llm = (context.llm ?? context.get?.("llm")) as LlmRuntime | undefined;
		const resolveRoute = routeResolverOf(scoped, context.get);
		registerSchedulerDisposer(scoped, createReviewScheduler(schedulerHost, {
			store, llm,
			...(resolveRoute === undefined ? {} : { resolveRoute }),
		}, {
			enabled: true,
			read: () => review.read(),
			minIntervalMs: 5 * 60 * 1000,
		}));
	});
}

/** The minimal plugin log face mount events report through. */
export interface SkillsMountLog {
	warn(event: string, message: string): void;
	info(event: string, message: string): void;
}

/** Nested-inject lookup shape (cast target only — the parameter stays `unknown`). */
interface SkillsMountHost {
	inject?: ((services: string[], callback: (scoped: unknown) => void) => void) | undefined;
}

/**
 * Register the bundled creator skills when the host has a skills service.
 * A host without nested inject (or without the service) degrades to a
 * warning — section and tools are unaffected.
 * @param host - The host context to look the skills service up in.
 * @param log - The plugin log face for mount events.
 */
export function mountCreatorSkillsWhenAvailable(host: unknown, log: SkillsMountLog): void {
	const inject = (host as SkillsMountHost).inject;
	if (typeof inject !== "function") {
		log.warn("creator-skills-not-mounted", "no host inject — creator skills not registered");
		return;
	}
	inject(["skills"], (scoped: unknown) => {
		const skills = (scoped as { skills?: unknown }).skills as Parameters<typeof registerCreatorSkills>[0] | undefined;
		if (skills === undefined || typeof skills.registerProvider !== "function") {
			log.warn("creator-skills-empty", "no skills service — creator skills not registered");
			return;
		}
		registerCreatorSkills(skills, packageAssetsDir());
		log.info("creator-skills-registered", "creator skills registered (bundled rank)");
	});
}
