import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalPath, newestRegistryPath } from "../src/workspace-hint.js";

/** A registry stub holding whatever records the test hands it. */
function registryWith(rows: unknown): { list: () => unknown } {
	return { list: () => rows };
}

describe("newestRegistryPath", () => {
	it("picks the record with the newest updatedAt", () => {
		const path = newestRegistryPath(
			registryWith([
				{ path: "/ws/old", updatedAt: "2026-09-01T00:00:00.000Z" },
				{ path: "/ws/new", updatedAt: "2026-10-06T00:47:30.213Z" },
				{ path: "/ws/mid", updatedAt: "2026-10-05T11:04:47.282Z" },
			]),
		);
		expect(path).toBe("/ws/new");
	});

	it("skips records without a usable path or instant", () => {
		const path = newestRegistryPath(
			registryWith([
				{ updatedAt: "2026-10-06T00:00:00.000Z" },
				{ path: "   ", updatedAt: "2026-10-06T00:00:00.000Z" },
				{ path: 42, updatedAt: "2026-10-06T00:00:00.000Z" },
				{ path: "/ws/no-instant" },
				null,
				"garbage",
				{ path: " /ws/trimmed ", updatedAt: "2026-10-05T00:00:00.000Z" },
			]),
		);
		expect(path).toBe("/ws/trimmed");
	});

	it("answers undefined for every unusable service shape", () => {
		expect(newestRegistryPath(undefined)).toBeUndefined();
		expect(newestRegistryPath(null)).toBeUndefined();
		expect(newestRegistryPath({})).toBeUndefined();
		expect(newestRegistryPath({ list: "not a function" })).toBeUndefined();
		expect(newestRegistryPath(registryWith("not an array"))).toBeUndefined();
		expect(newestRegistryPath(registryWith([]))).toBeUndefined();
	});

	it("answers undefined instead of throwing when the service itself fails", () => {
		// A host service is untrusted input: the card's default may not break a route.
		expect(
			newestRegistryPath({
				list: () => {
					throw new Error("registry unavailable");
				},
			}),
		).toBeUndefined();
	});
});

describe("canonicalPath", () => {
	it("resolves a symlink to its target and a vanished path to its resolved spelling", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-hint-root-"));
		const link = join(dir, "link");
		symlinkSync(dir, link);
		expect(canonicalPath(link)).toBe(canonicalPath(dir));
		expect(canonicalPath(join(dir, "gone", "..", "missing"))).toBe(join(dir, "missing"));
		rmSync(dir, { recursive: true, force: true });
	});
});
