import { describe, expect, it, vi } from "vitest";
import {
	CARD_API_REVIEW_SETTINGS_PATH,
	parseReviewSettingsPatch,
	reviewSettingsRoute,
	type ReviewSettingsDeps,
	type ReviewSettingsSnapshot,
} from "../src/pages/memory-card/settings.js";
import type { CardRequest, CardResponse } from "../src/pages/memory-card/card-http.js";

const SNAPSHOT: ReviewSettingsSnapshot = {
	enabled: true,
	dryRun: true,
	dailyBudget: 100,
	batchSize: 10,
	staleDays: 30,
};

function depsWith(overrides: Partial<ReviewSettingsDeps> = {}): ReviewSettingsDeps & { saved: unknown[] } {
	const saved: unknown[] = [];
	return {
		saved,
		read: () => ({ ...SNAPSHOT }),
		save: async (patch) => {
			saved.push(patch);
		},
		...overrides,
	};
}

interface Recorded {
	status: number;
	body: string;
	ended: boolean;
}

function record(): { recorded: Recorded; response: CardResponse } {
	const recorded: Recorded = { status: 0, body: "", ended: false };
	const response = {
		writeHead(status: number) {
			recorded.status = status;
			return response;
		},
		end(body?: string) {
			recorded.ended = true;
			recorded.body = body ?? "";
		},
	} as CardResponse;
	return { recorded, response };
}

async function flush(times = 5): Promise<void> {
	for (let index = 0; index < times; index++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function json(recorded: Recorded): unknown {
	return JSON.parse(recorded.body);
}

describe("parseReviewSettingsPatch", () => {
	it("accepts a partial patch", () => {
		expect(parseReviewSettingsPatch({ dryRun: false })).toEqual({ ok: true, patch: { dryRun: false } });
		expect(parseReviewSettingsPatch({ enabled: true, dailyBudget: 50, batchSize: 5, staleDays: 7 })).toEqual({
			ok: true,
			patch: { enabled: true, dailyBudget: 50, batchSize: 5, staleDays: 7 },
		});
	});

	it("rejects unknown fields, wrong types, and empty objects", () => {
		expect(parseReviewSettingsPatch({ dry_run: false }).ok).toBe(false);
		expect(parseReviewSettingsPatch({ dryRun: "no" }).ok).toBe(false);
		expect(parseReviewSettingsPatch({ dailyBudget: 1.5 }).ok).toBe(false);
		expect(parseReviewSettingsPatch({ batchSize: 0 }).ok).toBe(false);
		expect(parseReviewSettingsPatch({ staleDays: -1 }).ok).toBe(false);
		expect(parseReviewSettingsPatch({}).ok).toBe(false);
		expect(parseReviewSettingsPatch(null).ok).toBe(false);
		expect(parseReviewSettingsPatch("dryRun").ok).toBe(false);
	});
});

describe("reviewSettingsRoute", () => {
	it("answers GET with the live snapshot", () => {
		const deps = depsWith({ read: () => ({ ...SNAPSHOT, dryRun: false }) });
		const { recorded, response } = record();
		reviewSettingsRoute(deps).handler({ method: "GET", url: CARD_API_REVIEW_SETTINGS_PATH }, response);
		expect(recorded.status).toBe(200);
		expect(json(recorded)).toEqual({ ...SNAPSHOT, dryRun: false });
	});

	it("rejects non-GET/POST methods", () => {
		const { recorded, response } = record();
		reviewSettingsRoute(depsWith()).handler({ method: "DELETE", url: CARD_API_REVIEW_SETTINGS_PATH }, response);
		expect(recorded.status).toBe(405);
	});

	it("saves a valid POST and answers the fresh snapshot", async () => {
		let current = { ...SNAPSHOT };
		const deps = depsWith({
			read: () => ({ ...current }),
			save: async (patch) => {
				current = { ...current, ...patch };
			},
		});
		const { recorded, response } = record();
		reviewSettingsRoute(deps).handler(
			{ method: "POST", url: CARD_API_REVIEW_SETTINGS_PATH, body: { dryRun: false } } as CardRequest,
			response,
		);
		await flush();
		expect(recorded.status).toBe(200);
		expect(json(recorded)).toEqual({ ...SNAPSHOT, dryRun: false });
	});

	it("maps validation failures to 400", async () => {
		const save = vi.fn();
		const deps = depsWith({ save });
		const { recorded, response } = record();
		reviewSettingsRoute(deps).handler(
			{ method: "POST", url: CARD_API_REVIEW_SETTINGS_PATH, body: { batchSize: 0 } } as CardRequest,
			response,
		);
		await flush();
		expect(recorded.status).toBe(400);
		expect(save).not.toHaveBeenCalled();
	});

	it("maps a stale entry to 503 and other save failures to 500", async () => {
		const gone = depsWith({
			save: async () => {
				throw new Error("Configuration entry is no longer available");
			},
		});
		const first = record();
		reviewSettingsRoute(gone).handler(
			{ method: "POST", url: CARD_API_REVIEW_SETTINGS_PATH, body: { dryRun: false } } as CardRequest,
			first.response,
		);
		await flush();
		expect(first.recorded.status).toBe(503);

		const broken = depsWith({
			save: async () => {
				throw new Error("disk blew up");
			},
		});
		const second = record();
		reviewSettingsRoute(broken).handler(
			{ method: "POST", url: CARD_API_REVIEW_SETTINGS_PATH, body: { dryRun: false } } as CardRequest,
			second.response,
		);
		await flush();
		expect(second.recorded.status).toBe(500);
	});

	it("reads a streamed Node body and rejects oversized payloads", async () => {
		const listeners = new Map<string, Array<(...args: never[]) => void>>();
		const stream = {
			method: "POST",
			url: CARD_API_REVIEW_SETTINGS_PATH,
			on: (event: string, listener: (...args: never[]) => void) => {
				const list = listeners.get(event) ?? [];
				list.push(listener);
				listeners.set(event, list);
				return stream;
			},
		} as unknown as CardRequest;
		const deps = depsWith();
		const { recorded, response } = record();
		reviewSettingsRoute(deps).handler(stream, response);
		const emit = (event: string, ...args: never[]): void => {
			for (const listener of listeners.get(event) ?? []) {
				listener(...args);
			}
		};
		emit("data", Buffer.from(JSON.stringify({ staleDays: 7 })) as never);
		emit("end" as never);
		await flush();
		expect(recorded.status).toBe(200);
		expect(deps.saved).toEqual([{ staleDays: 7 }]);

		const bigListeners = new Map<string, Array<(...args: never[]) => void>>();
		const big = {
			method: "POST",
			url: CARD_API_REVIEW_SETTINGS_PATH,
			on: (event: string, listener: (...args: never[]) => void) => {
				const list = bigListeners.get(event) ?? [];
				list.push(listener);
				bigListeners.set(event, list);
				return big;
			},
		} as unknown as CardRequest;
		const second = record();
		reviewSettingsRoute(depsWith()).handler(big, second.response);
		for (const listener of bigListeners.get("data") ?? []) {
			listener(Buffer.alloc(70 * 1024) as never);
		}
		await flush();
		expect(second.recorded.status).toBe(413);
	});

	it("accepts a pre-serialized string body and rejects broken JSON", async () => {
		const deps = depsWith();
		const first = record();
		reviewSettingsRoute(deps).handler(
			{ method: "POST", url: CARD_API_REVIEW_SETTINGS_PATH, body: JSON.stringify({ dryRun: false }) } as CardRequest,
			first.response,
		);
		await flush();
		expect(first.recorded.status).toBe(200);
		expect(deps.saved).toEqual([{ dryRun: false }]);

		const second = record();
		reviewSettingsRoute(depsWith()).handler(
			{ method: "POST", url: CARD_API_REVIEW_SETTINGS_PATH, body: "{oops" } as CardRequest,
			second.response,
		);
		await flush();
		expect(second.recorded.status).toBe(400);
	});

	it("rejects a POST with no body source at all", async () => {
		const { recorded, response } = record();
		reviewSettingsRoute(depsWith()).handler({ method: "POST", url: CARD_API_REVIEW_SETTINGS_PATH }, response);
		await flush();
		expect(recorded.status).toBe(400);
	});

	it("rejects an enabled field of the wrong type", async () => {
		const save = vi.fn();
		const { recorded, response } = record();
		reviewSettingsRoute(depsWith({ save })).handler(
			{ method: "POST", url: CARD_API_REVIEW_SETTINGS_PATH, body: { enabled: "yes" } } as CardRequest,
			response,
		);
		await flush();
		expect(recorded.status).toBe(400);
		expect(save).not.toHaveBeenCalled();
	});

	it("reads streamed bodies through every failure shape", async () => {
		function streamed(): {
			request: CardRequest;
			emit(event: string, ...args: never[]): void;
		} {
			const listeners = new Map<string, Array<(...args: never[]) => void>>();
			const request = {
				method: "POST",
				url: CARD_API_REVIEW_SETTINGS_PATH,
				on: (event: string, listener: (...args: never[]) => void) => {
					const list = listeners.get(event) ?? [];
					list.push(listener);
					listeners.set(event, list);
					return request;
				},
			} as unknown as CardRequest;
			return {
				request,
				emit: (event: string, ...args: never[]) => {
					for (const listener of listeners.get(event) ?? []) {
						listener(...args);
					}
				},
			};
		}

		// Empty stream.
		const empty = streamed();
		const emptyRecorded = record();
		reviewSettingsRoute(depsWith()).handler(empty.request, emptyRecorded.response);
		empty.emit("end" as never);
		await flush();
		expect(emptyRecorded.recorded.status).toBe(400);

		// Invalid JSON over the stream, then a late duplicate end.
		const broken = streamed();
		const brokenRecorded = record();
		reviewSettingsRoute(depsWith()).handler(broken.request, brokenRecorded.response);
		broken.emit("data", Buffer.from("{oops") as never);
		broken.emit("end" as never);
		broken.emit("end" as never);
		await flush();
		expect(brokenRecorded.recorded.status).toBe(400);

		// Stream error event.
		const failed = streamed();
		const failedRecorded = record();
		reviewSettingsRoute(depsWith()).handler(failed.request, failedRecorded.response);
		failed.emit("error", new Error("socket hung up") as never);
		await flush();
		expect(failedRecorded.recorded.status).toBe(400);

		// Subscribing itself throws.
		const throwing = { method: "POST", url: CARD_API_REVIEW_SETTINGS_PATH } as CardRequest;
		(throwing as unknown as { on: unknown }).on = () => {
			throw new Error("no stream");
		};
		const throwingRecorded = record();
		reviewSettingsRoute(depsWith()).handler(throwing, throwingRecorded.response);
		await flush();
		expect(throwingRecorded.recorded.status).toBe(400);
	});
});
