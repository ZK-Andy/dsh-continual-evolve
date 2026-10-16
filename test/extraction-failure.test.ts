import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FAILURE_STATE_PREFIX,
	backoffUntil,
	clearRouteFailure,
	failureStateKey,
	parseRouteFailure,
	readRouteFailure,
	routeRefOf,
	writeRouteFailure,
} from "../src/services/extraction-failure.js";
import { FAILURE_STATE_RETENTION_DAYS, pruneFailureState } from "../src/services/retention.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let store: MemoryStore;
const WS = "/tmp/work/failure-tests";
const HOUR = 60 * 60_000;

beforeEach(async () => {
	store = await openMemoryStore(join(mkdtempSync(join(tmpdir(), "evolve-failure-")), "memory.db"));
});

afterEach(() => {
	store.close();
});

describe("backoffUntil", () => {
	it("retries the first failure at once and then climbs to a six-hour cap", () => {
		const now = 1_000_000;
		expect(backoffUntil(0, now)).toBe(now);
		expect(backoffUntil(1, now)).toBe(now);
		expect(backoffUntil(2, now)).toBe(now + 5 * 60_000);
		expect(backoffUntil(3, now)).toBe(now + 15 * 60_000);
		expect(backoffUntil(4, now)).toBe(now + HOUR);
		expect(backoffUntil(5, now)).toBe(now + 6 * HOUR);
		expect(backoffUntil(50, now)).toBe(now + 6 * HOUR);
	});
});

describe("the failure record", () => {
	it("round-trips a record and compares routes as one reference", () => {
		writeRouteFailure(store, WS, "sess-1", { count: 2, until: 1234, route: routeRefOf("p", "m") });

		expect(readRouteFailure(store, WS, "sess-1")).toEqual({ count: 2, until: 1234, route: "p/m" });
		expect(readRouteFailure(store, WS, "other-session")).toBeUndefined();
		expect(routeRefOf(undefined, undefined)).toBe("?/?");

		clearRouteFailure(store, WS, "sess-1");
		expect(readRouteFailure(store, WS, "sess-1")).toBeUndefined();
	});

	it("reads anything that is not a record as no record", () => {
		expect(parseRouteFailure(undefined)).toBeUndefined();
		expect(parseRouteFailure("{not json")).toBeUndefined();
		expect(parseRouteFailure("[]")).toBeUndefined();
		expect(parseRouteFailure('{"count":1}')).toBeUndefined();
		expect(parseRouteFailure('{"count":"1","until":2,"route":"p/m"}')).toBeUndefined();

		// A store that cannot answer (a closed handle) reads as no record: this
		// read sits on the scheduler's synchronous path.
		store.setState(WS, failureStateKey("sess-2"), "garbage");
		expect(readRouteFailure(store, WS, "sess-2")).toBeUndefined();
		const closed = {
			...store,
			state: () => {
				throw new Error("database is not open");
			},
		} as unknown as MemoryStore;
		expect(readRouteFailure(closed, WS, "sess-2")).toBeUndefined();
	});
});

describe("pruneFailureState", () => {
	it("drops spent records once their backoff is long over, and leaves the rest", () => {
		const now = Date.parse("2026-10-17T00:00:00.000Z");
		const long = FAILURE_STATE_RETENTION_DAYS * 24 * HOUR;
		writeRouteFailure(store, WS, "quiet-session", { count: 3, until: now - long - HOUR, route: "p/m" });
		writeRouteFailure(store, WS, "live-session", { count: 1, until: now - HOUR, route: "p/m" });
		store.setState(WS, `${FAILURE_STATE_PREFIX}hand-written`, "not a record");

		expect(pruneFailureState(store, now)).toBe(1);
		expect(store.listState(FAILURE_STATE_PREFIX).map((row) => row.key).sort()).toEqual([
			`${FAILURE_STATE_PREFIX}hand-written`,
			`${FAILURE_STATE_PREFIX}live-session`,
		]);
		expect(pruneFailureState(store, now)).toBe(0);
	});
});
