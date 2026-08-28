/**
 * Tests for the 2026-08-22 promotion policy: project-scope markers, content
 * overlap dedup, thin-content floor, and the policy resolver — the
 * mechanical guards that keep the cross-session global store portable,
 * duplicate-free, and free of framing-heavy one-liners.
 */
import { describe, expect, it } from "vitest";
import {
	contentOverlap,
	DEFAULT_PROMOTION_POLICY,
	mostSimilarGlobalEntry,
	normalizedTokens,
	projectScopedReason,
	resolvePromotionPolicy,
	secretLeakReason,
} from "../src/promotion.js";
import { filterPromotable, splitPromoteBlocked, type WrapupCandidate, type WrapupItem } from "../src/wrapup.js";
import { emptyHarnessState } from "../src/types.js";

const PORTABLE =
	"Prefer small evidence-backed edits and verify assumptions against the actual repository state before writing any code change.";

function globalWith(id: string, title: string, content: string): ReturnType<typeof emptyHarnessState> {
	const state = emptyHarnessState();
	state.entries.memory[id] = {
		id,
		kind: "memory",
		title,
		content,
		path: "general",
		scope: "global",
		reference: {},
		arguments: {},
		metadata: {},
		source: "evolve",
		created_at: "2026-08-22T00:00:00.000Z",
		updated_at: "2026-08-22T00:00:00.000Z",
		version: 1,
	};
	return state;
}

function candidateOf(overrides: Partial<WrapupCandidate> = {}): WrapupCandidate {
	return {
		kind: "memory",
		id: "cand_1",
		title: "持久结论",
		content: PORTABLE,
		path: "general",
		version: 1,
		metadata: {},
		coveredGlobally: false,
		globalHints: [],
		injectionCount: 0,
		stale: false,
		...overrides,
	};
}

function promoteItem(key = "memory:cand_1"): WrapupItem {
	return { key, verdict: "promote", reason: "durable" };
}

describe("projectScopedReason", () => {
	it("flags absolute POSIX paths and session ids", () => {
		expect(projectScopedReason("config lives in /home/zk/app", DEFAULT_PROMOTION_POLICY)).toMatch(/project-scoped/);
		expect(projectScopedReason("see session-1a2b3c4d for details", DEFAULT_PROMOTION_POLICY)).toMatch(/project-scoped/);
	});

	it("accepts portable prose including the bare word home", () => {
		expect(projectScopedReason(PORTABLE + " We were at home with the concept of users.", DEFAULT_PROMOTION_POLICY)).toBeUndefined();
	});
});

describe("contentOverlap / mostSimilarGlobalEntry", () => {
	it("scores identical content at 1 and unrelated text near 0", () => {
		expect(contentOverlap(PORTABLE, PORTABLE)).toBe(1);
		expect(contentOverlap(PORTABLE, "数据库迁移必须在低峰期执行并提前通知所有依赖方。")).toBeLessThan(0.2);
	});

	it("normalizes CJK via bigrams so reworded duplicates still overlap", () => {
		expect(normalizedTokens("初始化顺序应优先适配编码代理").size).toBeGreaterThan(3);
	});

	it("finds the most similar non-archived global entry above threshold", () => {
		const state = globalWith("existing", "持久结论", PORTABLE);
		expect(mostSimilarGlobalEntry(state, "memory", "持久结论二", PORTABLE + " 微调。", DEFAULT_PROMOTION_POLICY)?.id).toBe("existing");
		expect(mostSimilarGlobalEntry(state, "memory", "完全不同的话题", "数据库迁移必须在低峰期执行。", DEFAULT_PROMOTION_POLICY)).toBeUndefined();
	});
});

describe("filterPromotable guards", () => {
	it("skips project-scoped candidates with an explainable reason", () => {
		const state = emptyHarnessState();
		const candidate = candidateOf({ content: PORTABLE + " 配置位于 /home/zk/app/config。" });
		const { promotable, skipped } = filterPromotable([promoteItem()], state, [candidate]);
		expect(promotable).toHaveLength(0);
		expect(skipped[0]?.reason).toContain("project-scoped");
	});

	it("skips thin candidates below the floor", () => {
		const { promotable, skipped } = filterPromotable([promoteItem()], emptyHarnessState(), [
			candidateOf({ content: "短句。" }),
		]);
		expect(promotable).toHaveLength(0);
		expect(skipped[0]?.reason).toContain("too thin");
	});

	it("skips near-duplicates of existing global entries and says which one", () => {
		const state = globalWith("existing", "旧条目", PORTABLE);
		const { promotable, skipped } = filterPromotable([promoteItem()], state, [candidateOf()]);
		expect(promotable).toHaveLength(0);
		expect(skipped[0]?.reason).toContain("near-duplicate of global memory:existing");
	});

	it("promotes a portable, substantial, novel candidate", () => {
		const { promotable, skipped } = filterPromotable([promoteItem()], emptyHarnessState(), [candidateOf()]);
		expect(promotable).toHaveLength(1);
		expect(skipped).toHaveLength(0);
	});
});

describe("splitPromoteBlocked guards", () => {
	const item = (content: string): WrapupItem => ({
		key: "memory:cand_1",
		verdict: "archive",
		reason: "mixed",
		promote: { title: "清洗后的结论", content },
	});

	it("blocks a project-scoped cleaned payload", () => {
		expect(splitPromoteBlocked(item(PORTABLE + " 路径见 /mnt/data/cache。"), emptyHarnessState(), "memory")).toContain(
			"project-scoped",
		);
	});

	it("blocks a too-thin cleaned payload", () => {
		expect(splitPromoteBlocked(item("太短"), emptyHarnessState(), "memory")).toContain("too thin");
	});

	it("allows a portable, substantial cleaned payload", () => {
		expect(splitPromoteBlocked(item(PORTABLE), emptyHarnessState(), "memory")).toBeUndefined();
	});
});

describe("secretLeakReason", () => {
	// Pattern-valid synthetic credentials, assembled at runtime so the pushed
	// source never contains a complete detectable literal (GitHub push
	// protection rejects pushes whose blobs match known token shapes).
	const SK = (body: string): string => `sk-${body}`;
	const SYNTHETIC_SECRETS: readonly string[] = [
		`connect with as_sk_${"abcdef1234567890"} and search`,
		`anthropic key ${SK(`ant-${"api03-abcdefghij0123456789"}`)}`,
		`openai key ${SK(`proj-${"abcdefghij0123456789"}`)}`,
		`github token ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`,
		`fine-grained github_pat_${"ABCDEFGHIJ1234_abcdefgh"}`,
		`aws key AK${"IAIOSFODNN7EXAMPLE"}`,
		`google key AI${"zaa1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R"}`,
		`slack token xox${"b-123456789-abcdefghijklmnop"}`,
		`npm grant npm_${"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8"}`,
		`-----BEGIN ${"RSA PRIVATE KEY"}-----`,
		`config: apiKey: "${"a1b2c3d4e5f6g7h8i9j0k1"}"`,
		`json {"password": "${"s3cr3tValue12345"}"}`,
	];

	it("flags credential-shaped literals across all families", () => {
		for (const content of SYNTHETIC_SECRETS) {
			expect(secretLeakReason(content), content).toMatch(/^possible .+ — secrets must never be sedimented/);
		}
	});

	const GHP = `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`;

	it("redacts the matched value in the reason", () => {
		const reason = secretLeakReason(`token ${GHP} in use`)!;
		expect(reason).toContain("ghp_ab…456");
		expect(reason).not.toContain(GHP);
	});

	it("accepts clean prose, bare mentions, and ALL-CAPS placeholders", () => {
		expect(secretLeakReason(PORTABLE)).toBeUndefined();
		expect(secretLeakReason("rotate your ghp_ tokens regularly and prefer fine-grained PATs")).toBeUndefined();
		expect(secretLeakReason('set apiKey: "YOUR_API_KEY_HERE" before first run')).toBeUndefined();
		expect(secretLeakReason("read the key from process.env instead of inlining it")).toBeUndefined();
	});
});

describe("secret guard in promotion paths", () => {
	const SECRET = `push with token ${`ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`}`;

	it("filterPromotable skips a secret-bearing candidate with a rotate instruction", () => {
		const { promotable, skipped } = filterPromotable([promoteItem()], emptyHarnessState(), [
			candidateOf({ content: `${PORTABLE} ${SECRET}` }),
		]);
		expect(promotable).toHaveLength(0);
		expect(skipped[0]?.reason).toContain("possible GitHub token");
	});

	it("splitPromoteBlocked blocks a cleaned payload carrying a credential", () => {
		const item: WrapupItem = {
			key: "memory:cand_1",
			verdict: "archive",
			reason: "mixed",
			promote: { title: "清洗后的结论", content: `${PORTABLE} ${SECRET}` },
		};
		expect(splitPromoteBlocked(item, emptyHarnessState(), "memory")).toContain("split promotion blocked");
	});
});

describe("resolvePromotionPolicy", () => {
	it("compiles custom patterns and falls back to defaults on invalid regex", () => {
		const policy = resolvePromotionPolicy({ blockPatterns: ["internal-codename", "(bad["] , minPromoteChars: 42 });
		expect(policy.blockPatterns.some((p) => p.source.includes("internal-codename"))).toBe(true);
		expect(policy.blockPatterns.length).toBeGreaterThanOrEqual(1);
		expect(policy.minPromoteChars).toBe(42);
	});
});
