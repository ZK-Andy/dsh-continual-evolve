/**
 * Card and settings-page mounting: the web-server routes plus the host
 * settings presentation policy. Split out of the plugin entry so the entry
 * keeps its line budget — this module owns every host-surface touch behind
 * the card (nested injects, `ctx.get` sibling reads, `configEditor` writes).
 */
import { mountCardRoutes, type CardWebServer } from "./card-routes.js";
import type { ReviewSettingsSnapshot } from "./review-settings.js";
import {
	REVIEW_DEFAULT_BATCH_SIZE,
	REVIEW_DEFAULT_DAILY_BUDGET,
	REVIEW_DEFAULT_DRY_RUN,
	REVIEW_DEFAULT_STALE_DAYS,
} from "../review.js";
import type { MemoryStore } from "../store.js";
import type { PluginLog } from "../plugin-log.js";
import { newestRegistryPath } from "../workspace-hint.js";
import type { EvolveConfig } from "../index.js";

/** The nested `inject` shape (cordis Context), mirroring the entry's local declaration. */
interface NestedInjectHost {
	inject(services: string[], callback: (scoped: unknown) => void): void;
}

/** The minimal host surface the card mount touches. */
interface CardHost {
	systemPrompt: {
		section(section: {
			name: string;
			order: number;
			text: string | ((context: { agent?: unknown }) => string);
		}): void;
	};
}

/**
 * Mount the card routes on the host web server through a nested inject, so
 * the plugin stays mountable on hosts without that service. Called once the
 * store is ready — the memory routes are projections of the store, not of files.
 *
 * The card's opening workspace comes from the host registry, read through
 * `ctx.get` on every request (the FAQ #2 sibling-service rule — the service is
 * optional, so it must not join the inject list, which would gate the mount).
 * The review-settings route is global (no `root`): reads come from the live
 * volatile snapshot, writes merge through `configEditor.edit` so the profile
 * patch stays the single source of truth. A host without `configEditor`
 * keeps the memory card; the settings POST then answers 503.
 */
export function mountCardWhenAvailable(host: CardHost, store: MemoryStore, config: EvolveConfig, log: PluginLog): void {
	const nested = host as CardHost & Partial<NestedInjectHost>;
	if (typeof nested.inject !== "function") {
		log.warn(
			"card-not-mounted",
			"host context exposes no inject — memory card routes not mounted (memory section unaffected)",
		);
		return;
	}
	const readReviewSettings = (): ReviewSettingsSnapshot => ({
		enabled: config.review?.enabled?.get() ?? true,
		dryRun: config.review?.dryRun?.get() ?? REVIEW_DEFAULT_DRY_RUN,
		dailyBudget: config.review?.dailyBudget?.get() ?? REVIEW_DEFAULT_DAILY_BUDGET,
		batchSize: config.review?.batchSize?.get() ?? REVIEW_DEFAULT_BATCH_SIZE,
		staleDays: config.review?.staleDays?.get() ?? REVIEW_DEFAULT_STALE_DAYS,
	});
	// Saves commit in submission order (the default-model `saveSelection`
	// precedent): a failed save rejects its caller without blocking later ones.
	let pendingSave: Promise<void> = Promise.resolve();
	const saveReviewSettings = (patch: Partial<ReviewSettingsSnapshot>): Promise<void> => {
		const run = pendingSave.then(() => persistReviewSettings(host, patch));
		pendingSave = run.catch(() => {});
		return run;
	};
	nested.inject(["webServer"], (scoped: unknown) => {
		const context = scoped as { webServer?: CardWebServer; get?: (name: string) => unknown };
		const webServer = context.webServer;
		if (webServer === undefined) {
			log.warn(
				"card-empty-server",
				"webServer service present but empty — memory card routes not mounted (memory section unaffected)",
			);
			return;
		}
		mountCardRoutes(webServer, store, {
			currentWorkspace: () => newestRegistryPath(context.get?.("workspaceRegistry")),
			reviewSettings: { read: readReviewSettings, save: saveReviewSettings },
		});
	});
}

/** Whether the value is a plain JSON record (merge base for the review patch). */
function isPatchRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Persist a validated review-settings patch through the host config editor.
 * The editor validates against the plugin schema, writes the profile patch
 * atomically, and reconciles the loader — volatile-only changes land without
 * a remount. Throws when the host has no writable path (the route maps that
 * to 503 with a hand-edit hint).
 */
async function persistReviewSettings(host: CardHost, patch: Partial<ReviewSettingsSnapshot>): Promise<void> {
	const context = host as CardHost & { get?: (name: string) => unknown; fiber?: { entry?: unknown } };
	const editor = (
		typeof context.get === "function" ? context.get.call(host, "configEditor") : undefined
	) as { edit?: unknown } | undefined;
	const entry = context.fiber?.entry;
	if (editor === undefined || typeof editor.edit !== "function" || entry === undefined) {
		throw new Error("review settings are not writable on this host — edit the profile patch manually");
	}
	await (editor.edit as (entry: unknown, change: (current: Record<string, unknown>) => Record<string, unknown>) => Promise<void>).call(
		editor,
		entry,
		(current: Record<string, unknown>) => ({
			...current,
			review: { ...(isPatchRecord(current.review) ? current.review : {}), ...patch },
		}),
	);
}

/**
 * Take the plugin's settings page policy: the settings card inside the
 * bundle page is the only settings UI, so the host must not auto-generate a
 * second form page for the volatile fields (the default-model precedent:
 * `settings.configure({ auto: false }, ownFiber)`). A host without the
 * `settings` service keeps its default behavior — injection and tools are
 * unaffected.
 */
export function mountSettingsPresentation(host: CardHost, log: PluginLog): void {
	const nested = host as CardHost & Partial<NestedInjectHost>;
	if (typeof nested.inject !== "function") {
		return;
	}
	nested.inject(["settings"], (scoped: unknown) => {
		const context = scoped as {
			settings?: { configure?: unknown };
			effect?: unknown;
		};
		const fiber = (host as { fiber?: unknown }).fiber;
		if (context.settings === undefined || typeof context.settings.configure !== "function" || fiber === undefined) {
			return;
		}
		try {
			const configure = context.settings.configure as (presentation: { auto: boolean }, owner: unknown) => () => void;
			if (typeof context.effect === "function") {
				(context.effect as (callback: () => () => void) => unknown).call(scoped, () => configure.call(context.settings, { auto: false }, fiber));
			} else {
				configure.call(context.settings, { auto: false }, fiber);
			}
		} catch (error) {
			log.warn(
				"settings-presentation-kept",
				`automatic settings page left enabled: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	});
}
