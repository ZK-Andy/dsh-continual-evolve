/**
 * Tests for the memory extraction benchmark: precision/recall over labeled
 * facts, duplicate creates, stale operations, noise (thin content and the
 * exclusion patterns), correct archival of outdated facts, and grading.
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_MEMORY_GRADE_THRESHOLDS,
	gradeMemoryScore,
	scoreMemoryExtraction,
	type MemoryBenchmarkEdit,
	type MemoryBenchmarkReference,
} from "../src/memory-benchmark.js";
import type { HarnessEntry } from "../src/types.js";
import { MEMORY_TYPE_KEY } from "../src/types.js";

function manifestEntry(id: string, title: string, content: string, archived = false): HarnessEntry {
	return {
		id,
		kind: "memory",
		title,
		content,
		path: "general",
		scope: "global",
		reference: {},
		arguments: {},
		metadata: { [MEMORY_TYPE_KEY]: "user", ...(archived ? { archivedAt: "2026-09-25T00:00:00.000Z" } : {}) },
		source: "evolve",
		created_at: "2026-09-25T00:00:00.000Z",
		updated_at: "2026-09-25T00:00:00.000Z",
		version: 1,
	};
}

const REFERENCE: MemoryBenchmarkReference = {
	facts: [
		{ id: "dark-theme", memoryType: "user", mustContain: ["深色", "主题"] },
		{ id: "pnpm", memoryType: "project", mustContain: ["pnpm"] },
		{ id: "old-registry", memoryType: "reference", mustContain: ["registry mirror"], outdated: true },
	],
};

function create(title: string, content: string): MemoryBenchmarkEdit {
	return { action: "create", title, content };
}

describe("scoreMemoryExtraction", () => {
	it("scores a perfect proposal at full precision and recall", () => {
		const score = scoreMemoryExtraction(REFERENCE, [
			create("深色主题偏好", "用户偏好深色主题开发环境"),
			create("包管理用 pnpm", "本项目统一用 pnpm 安装依赖"),
			{ action: "archive", id: "old-registry-entry", title: "registry mirror", content: "旧 registry mirror 入口" },
		], []);
		expect(score.precision).toBe(1);
		expect(score.recall).toBe(1);
		expect(score.duplicate).toBe(0);
		expect(score.stale).toBe(0);
		expect(score.noise).toBe(0);
		expect(score.uncoveredFactIds).toEqual([]);
		expect(gradeMemoryScore(score).pass).toBe(true);
	});

	it("measures partial recall with uncovered facts listed", () => {
		const score = scoreMemoryExtraction(REFERENCE, [
			create("深色主题偏好", "用户偏好深色主题开发环境"),
		], []);
		expect(score.precision).toBe(1);
		expect(score.recall).toBe(0.5);
		expect(score.uncoveredFactIds).toEqual(["pnpm"]);
		expect(gradeMemoryScore(score).pass).toBe(false);
	});

	it("flags creates that duplicate manifest entries", () => {
		const manifest = [manifestEntry("pnpm-existing", "包管理 pnpm", "本项目统一用 pnpm 安装依赖，请用 pnpm 管理包")];
		const score = scoreMemoryExtraction(REFERENCE, [
			create("包管理 pnpm", "本项目统一用 pnpm 安装依赖，请用 pnpm 管理包"),
		], manifest);
		expect(score.duplicate).toBe(1);
		expect(score.edits[0]?.duplicateOf).toBe("pnpm-existing");
		expect(score.precision).toBe(0);
	});

	it("flags re-proposals of outdated facts and removals of live ones", () => {
		const score = scoreMemoryExtraction(REFERENCE, [
			create("旧镜像", "继续用 registry mirror 加速下载"),
			{ action: "delete", id: "dark-live", title: "深色主题偏好", content: "用户偏好深色主题开发环境" },
		], []);
		expect(score.stale).toBe(2);
		expect(score.recall).toBe(0);
	});

	it("flags unmatched and exclusion-list material as noise", () => {
		const score = scoreMemoryExtraction(REFERENCE, [
			create("调试记录", "今天花了三小时调试登录跳转的中间过程记录"),
			create("提交记录", "用 git commit abc1234 提交了修改"),
			create("短", "太短"),
		], []);
		expect(score.noise).toBe(3);
		expect(score.precision).toBe(0);
		expect(score.edits[1]?.noisyReason).toContain("exclusion pattern");
		expect(score.edits[2]?.noisyReason).toContain("thin content");
	});

	it("treats an empty proposal as precise but uncovering", () => {
		const score = scoreMemoryExtraction(REFERENCE, [], []);
		expect(score.precision).toBe(1);
		expect(score.recall).toBe(0);
		expect(gradeMemoryScore(score, { minPrecision: 1, minRecall: 0, maxDuplicate: 0, maxStale: 0, maxNoise: 0 }).pass).toBe(true);
	});

	it("grades against explicit thresholds with named failures", () => {
		const score = scoreMemoryExtraction(REFERENCE, [create("调试记录", "今天花了三小时调试登录跳转的中间过程记录")], []);
		const graded = gradeMemoryScore(score);
		expect(graded.pass).toBe(false);
		expect(graded.failures.join(" ")).toContain("precision");
		expect(graded.failures.join(" ")).toContain("recall");
		expect(graded.failures.join(" ")).toContain("noise");
	});

	it("scores updates: live matches land, misses are noise, outdated re-proposals are stale", () => {
		const matched = scoreMemoryExtraction(REFERENCE, [
			{ action: "update", id: "pnpm", title: "包管理用 pnpm", content: "本项目统一用 pnpm 安装依赖" },
		], []);
		expect(matched.edits[0]?.matchedFactIds).toEqual(["pnpm"]);
		expect(matched.stale).toBe(0);
		expect(matched.noise).toBe(0);

		const missed = scoreMemoryExtraction(REFERENCE, [
			{ action: "update", id: "other", title: "无关的午餐记录和天气", content: "今天午饭吃了牛肉面条配蒜瓣还喝了免费的汤水外面在下雨" },
		], []);
		expect(missed.noise).toBe(1);
		expect(missed.edits[0]?.noisyReason).toContain("matches no reference fact");

		const stale = scoreMemoryExtraction(REFERENCE, [
			{ action: "update", id: "old-registry", title: "registry mirror", content: "继续用 registry mirror 加速" },
		], []);
		expect(stale.stale).toBe(1);
		expect(stale.edits[0]?.staleReason).toContain("old-registry");
	});

	it("scores removals by target: archived re-archives match, live removals are stale, unknown are noise", () => {
		const manifest = [
			manifestEntry("archived-one", "旧条目", "早已归档的旧条目正文内容足够长", true),
			manifestEntry("live-one", "深色主题偏好", "用户偏好深色主题开发环境的完整描述正文", false),
		];
		const reArchive = scoreMemoryExtraction(REFERENCE, [{ action: "archive", id: "archived-one" }], manifest);
		expect(reArchive.stale).toBe(0);
		expect(reArchive.noise).toBe(0);
		expect(reArchive.edits[0]?.matchedFactIds).toEqual(["archived:archived-one"]);

		const liveRemoval = scoreMemoryExtraction(REFERENCE, [{ action: "delete", id: "live-one" }], manifest);
		expect(liveRemoval.stale).toBe(1);
		expect(liveRemoval.edits[0]?.staleReason).toContain("live-one");

		const unknown = scoreMemoryExtraction(REFERENCE, [{ action: "delete", id: "ghost" }], manifest);
		expect(unknown.noise).toBe(1);
		expect(unknown.edits[0]?.noisyReason).toBe("removal matches no reference fact");
	});

	it("treats an outdated-only reference as fully recalled and names duplicate/stale failures", () => {
		const outdatedOnly = { facts: [{ id: "old", memoryType: "reference", mustContain: ["registry mirror"], outdated: true }] };
		const empty = scoreMemoryExtraction(outdatedOnly, [], []);
		expect(empty.recall).toBe(1);
		const graded = gradeMemoryScore({ ...empty, duplicate: 2, stale: 1, precision: 1, recall: 1, noise: 0 }, DEFAULT_MEMORY_GRADE_THRESHOLDS);
		expect(graded.pass).toBe(false);
		expect(graded.failures.join(" ")).toContain("duplicate");
		expect(graded.failures.join(" ")).toContain("stale");
	});
});
