import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mountCreatorSkillsWhenAvailable,
	mountExtractionWhenAvailable,
	mountReviewWhenAvailable,
	mountToolsWhenAvailable,
	type StoreState,
} from "../src/assemble.js";
import type { HostContext } from "../src/index.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

interface TestLog {
	events: string[];
	log: { warn(event: string, message: string): void; info(event: string, message: string): void };
}

function makeLog(): TestLog {
	const events: string[] = [];
	return {
		events,
		log: {
			warn: (event: string) => events.push(`warn:${event}`),
			info: (event: string) => events.push(`info:${event}`),
		},
	};
}

let store: MemoryStore;
let dbDir = "";

beforeEach(async () => {
	dbDir = mkdtempSync(join(tmpdir(), "evolve-assemble-db-"));
	store = await openMemoryStore(join(dbDir, "memory.db"));
});

afterEach(() => {
	store.close();
	rmSync(dbDir, { recursive: true, force: true });
});

function fullExtractionConfig(extraction: boolean): {
	memoryIndex: { enabled: boolean; guide: boolean; order: number; maxChars: number; extraction: boolean };
} {
	return { memoryIndex: { enabled: true, guide: true, order: 400, maxChars: 6000, extraction } };
}

/** A host stub carrying nested inject plus the scheduler event subscription. */
function fakeHost(
	scoped: unknown,
	heard: string[],
): HostContext {
	return {
		systemPrompt: { section: () => {} },
		inject: (_services: string[], callback: (scoped: unknown) => void) => callback(scoped),
		on: (event: string, _handler: (...args: never[]) => void) => heard.push(event),
	} as HostContext;
}

function reviewSchedule(enabled: boolean): {
	enabled: boolean;
	read(): { dryRun: boolean; dailyBudget: number; batchSize: number; staleDays: number };
} {
	return { enabled, read: () => ({ dryRun: true, dailyBudget: 100, batchSize: 10, staleDays: 30 }) };
}

describe("shared mount assembly", () => {
	it("mounts the creator skills through nested inject and logs registration", () => {
		const events: string[] = [];
		const log = {
			warn: (event: string) => events.push(`warn:${event}`),
			info: (event: string) => events.push(`info:${event}`),
		};
		let registered = 0;
		const host = {
			inject: (services: string[], callback: (scoped: unknown) => void) => {
				expect(services).toEqual(["skills"]);
				callback({ skills: { registerProvider: () => registered++ } });
			},
		};
		mountCreatorSkillsWhenAvailable(host, log);
		expect(registered).toBe(1);
		expect(events).toContain("info:creator-skills-registered");
	});

	it("creator-skills mount degrades with a warning when inject or service is missing", () => {
		const events: string[] = [];
		const log = {
			warn: (event: string) => events.push(`warn:${event}`),
			info: (event: string) => events.push(`info:${event}`),
		};
		mountCreatorSkillsWhenAvailable({}, log);
		mountCreatorSkillsWhenAvailable({ inject: (_services: string[], callback: (scoped: unknown) => void) => callback({}) }, log);
		expect(events).toEqual(["warn:creator-skills-not-mounted", "warn:creator-skills-empty"]);
	});

	it("tools mount warns when the host has no inject or no tools service", () => {
		const { events, log } = makeLog();
		const state: StoreState = { store: undefined, toolsAvailable: false };
		const noInject = { systemPrompt: { section: () => {} } } as HostContext;
		mountToolsWhenAvailable(noInject, store, state, log);
		const noTools = {
			systemPrompt: { section: () => {} },
			inject: (_services: string[], callback: (scoped: unknown) => void) => callback({}),
		} as HostContext;
		mountToolsWhenAvailable(noTools, store, state, log);
		expect(events).toEqual(["warn:tools-not-mounted", "warn:tools-empty"]);
		expect(state.toolsAvailable).toBe(false);
	});

	it("tools mount registers and flags availability", () => {
		const { events, log } = makeLog();
		const state: StoreState = { store: undefined, toolsAvailable: false };
		let registered = 0;
		const host = fakeHost({ tools: { register: () => registered++ } }, []);
		mountToolsWhenAvailable(host, store, state, log);
		expect(registered).toBe(2);
		expect(state.toolsAvailable).toBe(true);
		expect(events).toContain("info:evolve-tools-registered");
	});

	it("extraction mount stays off when disabled or the host cannot arm it", () => {
		const { events, log } = makeLog();
		const noInject = { systemPrompt: { section: () => {} } } as HostContext;
		mountExtractionWhenAvailable(noInject, store, fullExtractionConfig(false), log);
		mountExtractionWhenAvailable(noInject, store, fullExtractionConfig(true), log);
		expect(events).toEqual(["info:extraction-disabled", "warn:extraction-not-armed"]);
	});

	it("extraction mount warns when the session surface is missing", () => {
		const { events, log } = makeLog();
		const host = fakeHost({}, []);
		mountExtractionWhenAvailable(host, store, fullExtractionConfig(true), log);
		expect(events).toContain("warn:extraction-no-surface");
	});

	it("extraction mount arms the scheduler and resolves routes per call", () => {
		const { events, log } = makeLog();
		const heard: string[] = [];
		const disposers: Array<() => void> = [];
		const scoped = {
			sessionQuery: { readSurface: () => [] },
			llm: undefined,
			get: (_name: string) => undefined,
			effect: (callback: () => () => void) => {
				disposers.push(callback());
			},
		};
		const host = fakeHost(scoped, heard);
		mountExtractionWhenAvailable(host, store, fullExtractionConfig(true), log);
		expect(heard).toContain("agent/turn-stopping");
		expect(disposers).toHaveLength(1);
		for (const dispose of disposers) dispose();
		expect(events).not.toContain("warn:extraction-no-surface");
	});

	it("review mount stays off when disabled or the host cannot arm it", () => {
		const { events, log } = makeLog();
		const noInject = { systemPrompt: { section: () => {} } } as HostContext;
		mountReviewWhenAvailable(noInject, store, reviewSchedule(false), log);
		mountReviewWhenAvailable(noInject, store, reviewSchedule(true), log);
		expect(events).toEqual(["info:review-disabled", "warn:review-not-armed"]);
	});

	it("review mount arms the scheduler and keeps the disposer on the fiber", () => {
		const { events, log } = makeLog();
		const heard: string[] = [];
		const disposers: Array<() => void> = [];
		const scoped = {
			llm: undefined,
			effect: (callback: () => () => void) => {
				disposers.push(callback());
			},
		};
		const host = fakeHost(scoped, heard);
		mountReviewWhenAvailable(host, store, reviewSchedule(true), log);
		expect(heard).toContain("agent/turn-stopping");
		expect(disposers).toHaveLength(1);
		for (const dispose of disposers) dispose();
		expect(events).toContain("info:review-armed");
	});

	it("review mount arms without a fiber effect", () => {
		const { events, log } = makeLog();
		const heard: string[] = [];
		const host = fakeHost({ llm: undefined }, heard);
		mountReviewWhenAvailable(host, store, reviewSchedule(true), log);
		expect(heard).toContain("agent/turn-stopping");
		expect(events).toContain("info:review-armed");
	});
});
