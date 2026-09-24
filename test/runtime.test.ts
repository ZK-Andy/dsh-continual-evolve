/**
 * Tests for the runtime gate switch (#21 P2): pause/resume persistence
 * with fail-open reads — a missing or corrupt file means "running", never
 * a silently wedged-shut gate.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isGatePaused, loadGateRuntime, runtimePath, saveGateRuntime } from "../src/runtime.js";

describe("loadGateRuntime", () => {
	it("reports running when the file is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-runtime-"));
		try {
			expect(loadGateRuntime(dir)).toMatchObject({ version: 2, enabled: false, paused: false });
			expect(isGatePaused(dir)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails open on corrupt or non-object content", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-runtime-corrupt-"));
		try {
			mkdirSync(join(dir, "evolve"), { recursive: true });
			writeFileSync(runtimePath(dir), "{not json", "utf8");
			expect(isGatePaused(dir)).toBe(false);
			writeFileSync(runtimePath(dir), "[1,2,3]", "utf8");
			expect(loadGateRuntime(dir).paused).toBe(false);
			writeFileSync(runtimePath(dir), "null", "utf8");
			expect(isGatePaused(dir)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("round-trips pause and resume with timestamps", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-runtime-roundtrip-"));
		try {
			saveGateRuntime(dir, true);
			const paused = loadGateRuntime(dir);
			expect(paused.paused).toBe(true);
			expect(typeof paused.updatedAt).toBe("string");
			expect(isGatePaused(dir)).toBe(true);
			saveGateRuntime(dir, false);
			expect(isGatePaused(dir)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats a missing paused field as running", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-runtime-shape-"));
		try {
			mkdirSync(join(dir, "evolve"), { recursive: true });
			writeFileSync(runtimePath(dir), JSON.stringify({ version: 1 }), "utf8");
			expect(isGatePaused(dir)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
