/**
 * The card's global review-settings surface: one GET plus one POST under the
 * same card API prefix. Unlike the memory/skill routes this surface is not
 * partitioned by workspace — `review.*` is plugin-global config, so neither
 * direction takes a `root` parameter.
 *
 * Reads come from the live volatile snapshot the scheduler itself re-reads
 * per drain; writes merge through the host `configEditor` (the profile patch
 * stays the single source of truth, the database never stores config).
 * Handlers never throw past the response: malformed input maps to 400,
 * an oversized body to 413, a missing write path to 503, a failed save
 * to 500.
 */
import {
	sendJson,
	type CardRequest,
	type CardResponse,
	type CardRoute,
} from "./card-http.js";

/** URL of the review-settings endpoint (kind-exact route registered under it). */
export const CARD_API_REVIEW_SETTINGS_PATH = "/dsh-continual-evolve/api/v1/review-settings";

/** Cap on a POST body: settings fit in a few hundred bytes, anything larger is a mistake. */
const MAX_SETTINGS_BODY_BYTES = 64 * 1024;

/** The five editable review fields. `enabled` is mount-time (restart to apply); the rest take effect on the next drain. */
export interface ReviewSettingsSnapshot {
	enabled: boolean;
	dryRun: boolean;
	dailyBudget: number;
	batchSize: number;
	staleDays: number;
}

/** The host-backed read/write pair the route is mounted with. */
export interface ReviewSettingsDeps {
	/** Live volatile snapshot (same source the scheduler re-reads per drain). */
	read(): ReviewSettingsSnapshot;
	/** Merge a validated partial patch through `configEditor.edit`. */
	save(patch: Partial<ReviewSettingsSnapshot>): Promise<void>;
}

type PatchResult = { ok: true; patch: Partial<ReviewSettingsSnapshot> } | { ok: false; errors: string[] };

const KNOWN_KEYS = ["enabled", "dryRun", "dailyBudget", "batchSize", "staleDays"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isNatural(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Validate a POST payload into a partial patch. Unknown fields are rejected
 * (a misspelled key silently doing nothing would be worse than a 400), and
 * at least one known field is required.
 */
export function parseReviewSettingsPatch(body: unknown): PatchResult {
	if (!isPlainRecord(body)) {
		return { ok: false, errors: ["body must be a JSON object"] };
	}
	const errors: string[] = [];
	const patch: Partial<ReviewSettingsSnapshot> = {};
	for (const key of Object.keys(body)) {
		if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
			errors.push(`unknown field "${key}"`);
		}
	}
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== "boolean") {
			errors.push('field "enabled" must be a boolean');
		} else {
			patch.enabled = body.enabled;
		}
	}
	if (body.dryRun !== undefined) {
		if (typeof body.dryRun !== "boolean") {
			errors.push('field "dryRun" must be a boolean');
		} else {
			patch.dryRun = body.dryRun;
		}
	}
	if (body.dailyBudget !== undefined) {
		if (!isNatural(body.dailyBudget)) {
			errors.push('field "dailyBudget" must be a non-negative integer');
		} else {
			patch.dailyBudget = body.dailyBudget;
		}
	}
	if (body.batchSize !== undefined) {
		if (!isNatural(body.batchSize) || body.batchSize < 1) {
			errors.push('field "batchSize" must be an integer >= 1');
		} else {
			patch.batchSize = body.batchSize;
		}
	}
	if (body.staleDays !== undefined) {
		if (!isNatural(body.staleDays)) {
			errors.push('field "staleDays" must be a non-negative integer');
		} else {
			patch.staleDays = body.staleDays;
		}
	}
	if (errors.length > 0) {
		return { ok: false, errors };
	}
	if (Object.keys(patch).length === 0) {
		return { ok: false, errors: ["body must carry at least one review field"] };
	}
	return { ok: true, patch };
}

type BodyRequest = CardRequest & {
	body?: unknown;
	on?: (event: string, listener: (...args: never[]) => void) => unknown;
};

/** Read a JSON POST body: a pre-parsed `body` wins (tests, forwarding hosts), else the Node stream is accumulated. */
async function readJsonBody(request: CardRequest): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
	const direct = (request as BodyRequest).body;
	if (direct !== undefined) {
		if (typeof direct === "string") {
			try {
				return { ok: true, value: JSON.parse(direct) };
			} catch {
				return { ok: false, status: 400, error: "body is not valid JSON" };
			}
		}
		return { ok: true, value: direct };
	}
	const on = (request as BodyRequest).on;
	if (typeof on !== "function") {
		return { ok: false, status: 400, error: "POST body is required" };
	}
	return new Promise((resolve) => {
		let size = 0;
		const chunks: Buffer[] = [];
		let settled = false;
		const fail = (status: number, error: string): void => {
			if (!settled) {
				settled = true;
				resolve({ ok: false, status, error });
			}
		};
		try {
			on.call(request, "data", ((chunk: unknown) => {
				if (settled) {
					return;
				}
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
				size += buffer.length;
				if (size > MAX_SETTINGS_BODY_BYTES) {
					fail(413, "settings body exceeds the 64 KiB limit");
					return;
				}
				chunks.push(buffer);
			}) as never);
			on.call(request, "end", (() => {
				if (settled) {
					return;
				}
				settled = true;
				const text = Buffer.concat(chunks).toString("utf8");
				if (text.trim().length === 0) {
					resolve({ ok: false, status: 400, error: "POST body is required" });
					return;
				}
				try {
					resolve({ ok: true, value: JSON.parse(text) });
				} catch {
					resolve({ ok: false, status: 400, error: "body is not valid JSON" });
				}
			}) as never);
			on.call(request, "error", (() => {
				fail(400, "failed to read the POST body");
			}) as never);
		} catch {
			fail(400, "failed to read the POST body");
		}
	});
}

/**
 * Build the kind-exact review-settings route. GET answers the live snapshot;
 * POST validates a partial patch and persists it through `deps.save`.
 */
export function reviewSettingsRoute(deps: ReviewSettingsDeps): CardRoute {
	return {
		kind: "exact",
		path: CARD_API_REVIEW_SETTINGS_PATH,
		handler(request: CardRequest, response: CardResponse) {
			const method = request.method ?? "GET";
			if (method === "GET") {
				sendJson(response, 200, deps.read());
				return;
			}
			if (method !== "POST") {
				response.writeHead(405, { allow: "GET, POST" });
				response.end();
				return;
			}
			void (async () => {
				const body = await readJsonBody(request);
				if (!body.ok) {
					sendJson(response, body.status, { error: body.error });
					return;
				}
				const parsed = parseReviewSettingsPatch(body.value);
				if (!parsed.ok) {
					sendJson(response, 400, { error: parsed.errors.join("; ") });
					return;
				}
				try {
					await deps.save(parsed.patch);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const gone = /no longer (available|active|configurable)/i.test(message);
					sendJson(response, gone ? 503 : 500, { error: message });
					return;
				}
				sendJson(response, 200, deps.read());
			})();
		},
	};
}
