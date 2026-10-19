import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	feedbackWhyHowMissing,
	fieldGateReasons,
	identityRejectReason,
	isValidMemoryId,
	MEMORY_BODY_LIMIT,
	MEMORY_DESCRIPTION_LIMIT,
	MEMORY_TITLE_LIMIT,
	secretLeakReason,
	slugifyId,
} from "../src/services/memory-rules.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

describe("isValidMemoryId", () => {
	it("accepts kebab slugs", () => {
		expect(isValidMemoryId("dsh-config")).toBe(true);
		expect(isValidMemoryId("a")).toBe(true);
		expect(isValidMemoryId("m-1a2b3c4d")).toBe(true);
	});

	it("rejects non-kebab shapes and overlong ids", () => {
		expect(isValidMemoryId("")).toBe(false);
		expect(isValidMemoryId("Fedora-Env")).toBe(false);
		expect(isValidMemoryId("-lead")).toBe(false);
		expect(isValidMemoryId("trail-")).toBe(false);
		expect(isValidMemoryId("dou--ble")).toBe(false);
		expect(isValidMemoryId("有中文")).toBe(false);
		expect(isValidMemoryId("a".repeat(81))).toBe(false);
	});
});

describe("slugifyId", () => {
	it("slugifies ascii titles", () => {
		expect(slugifyId("DSH Config Locations!")).toBe("dsh-config-locations");
	});

	it("falls back to a hash for CJK-only titles", () => {
		const id = slugifyId("配置位置");
		expect(id).toMatch(/^m-[0-9a-f]{8}$/);
		// Deterministic for the same title, distinct across titles.
		expect(slugifyId("配置位置")).toBe(id);
		expect(slugifyId("另一条")).not.toBe(id);
	});

	it("caps the slug at 80 characters", () => {
		expect(slugifyId("ab ".repeat(60)).length).toBeLessThanOrEqual(80);
	});
});

describe("feedbackWhyHowMissing", () => {
	it("accepts bold and plain spellings", () => {
		expect(feedbackWhyHowMissing("规则\n**Why:** 因为\n**How to apply:** 这样")).toBe("");
		expect(feedbackWhyHowMissing("规则\nWhy: 因为\nHow to apply: 这样")).toBe("");
	});

	it("names the missing lines", () => {
		expect(feedbackWhyHowMissing("只有 Why: 有")).toBe("How to apply:");
		expect(feedbackWhyHowMissing("只有 **How to apply:** 有")).toBe("Why:");
		expect(feedbackWhyHowMissing("两个都没有")).toBe("Why:、How to apply:");
	});
});

describe("secretLeakReason", () => {
	it("flags realistic credentials", () => {
		expect(secretLeakReason("key = sk-ant-api03-abcdefghijklmnop")).toBeDefined();
		expect(secretLeakReason("token ghp_0123456789abcdefghijklmnopqrstuv")).toBeDefined();
		expect(secretLeakReason("AKIAIOSFODNN7EXAMPLE")).toBeDefined();
		expect(secretLeakReason("apiKey: '0123456789abcdefghij'")).toBeDefined();
		expect(secretLeakReason("-----BEGIN RSA PRIVATE KEY-----")).toBeDefined();
		expect(secretLeakReason("as_sk_0123456789")).toBeDefined();
	});

	it("passes placeholders and prose", () => {
		expect(secretLeakReason("YOUR_API_KEY_HERE")).toBeUndefined();
		expect(secretLeakReason("API_KEY= 设置在 ~/.dsh/.env")).toBeUndefined();
		expect(secretLeakReason("用 Exa 搜索，定价 $7/1k")).toBeUndefined();
	});
});

describe("fieldGateReasons", () => {
	const ok = { type: "user" as const, title: "t", description: "d", body: "b", scope: "project" as const };

	it("passes a well-formed record", () => {
		expect(fieldGateReasons(ok)).toEqual([]);
	});

	it("blocks an unknown scope", () => {
		expect(
			fieldGateReasons({ ...ok, scope: "global" as never }).some((r) => r.includes("scope")),
		).toBe(true);
	});

	it("blocks empty and oversized fields", () => {
		expect(fieldGateReasons({ ...ok, title: "" }).some((r) => r.includes("title"))).toBe(true);
		expect(fieldGateReasons({ ...ok, title: "x".repeat(MEMORY_TITLE_LIMIT + 1) }).some((r) => r.includes("title"))).toBe(true);
		expect(fieldGateReasons({ ...ok, description: "" }).some((r) => r.includes("description"))).toBe(true);
		expect(fieldGateReasons({ ...ok, description: "d".repeat(MEMORY_DESCRIPTION_LIMIT + 1) }).some((r) => r.includes("description"))).toBe(true);
		expect(fieldGateReasons({ ...ok, body: "" }).some((r) => r.includes("body"))).toBe(true);
		expect(fieldGateReasons({ ...ok, body: "b".repeat(MEMORY_BODY_LIMIT + 1) }).some((r) => r.includes("cap"))).toBe(true);
	});

	it("blocks unknown types and incomplete feedback bodies", () => {
		expect(fieldGateReasons({ ...ok, type: "project" as never }).some((r) => r.includes("type"))).toBe(true);
		expect(fieldGateReasons({ ...ok, type: "feedback" }).some((r) => r.includes("feedback"))).toBe(true);
		expect(
			fieldGateReasons({ ...ok, type: "feedback", body: "规则\n**Why:** 因\n**How to apply:** 用" }),
		).toEqual([]);
	});

	it("blocks secrets in any field", () => {
		expect(fieldGateReasons({ ...ok, body: "ghp_0123456789abcdefghijklmnopqrstuv" }).some((r) => r.includes("GitHub token"))).toBe(true);
	});
});

describe("identityRejectReason (P2 mechanical gate, single home)", () => {
	const allowed = new Set(["rule-a", "rule-b"]);

	it("passes well-formed in-allowlist identities", () => {
		expect(identityRejectReason({ action: "update", id: "rule-a" }, allowed)).toBeUndefined();
		expect(identityRejectReason({ action: "delete", id: "rule-b" }, allowed)).toBeUndefined();
		expect(identityRejectReason({ action: "create", type: "user", title: "全新规则" }, allowed)).toBeUndefined();
		expect(identityRejectReason({ action: "create", id: "brand-new", type: "feedback" }, allowed)).toBeUndefined();
	});

	it("rejects unknown actions", () => {
		expect(identityRejectReason({ action: "upsert", id: "rule-a" }, allowed)).toBe("unknown-action");
	});

	it("rejects forged update/delete ids (absent, malformed, or unknown)", () => {
		expect(identityRejectReason({ action: "update", id: "forged-id", body: "x" }, allowed)).toBe("unknown-id");
		expect(identityRejectReason({ action: "delete", id: "Bad_Id" }, allowed)).toBe("unknown-id");
		expect(identityRejectReason({ action: "update" }, allowed)).toBe("unknown-id");
	});

	it("lets colliding creates through (P4-b M1 versions them, no soft drop)", () => {
		expect(identityRejectReason({ action: "create", id: "rule-a", type: "user" }, allowed)).toBeUndefined();
		expect(identityRejectReason({ action: "create", type: "user", title: "Rule A" }, new Set(["rule-a"]))).toBeUndefined();
	});

	it("rejects bad types on any action", () => {
		expect(identityRejectReason({ action: "create", id: "n", type: "project" }, allowed)).toBe("bad-type");
		expect(identityRejectReason({ action: "update", id: "rule-a", type: "dream" }, allowed)).toBe("bad-type");
	});
});

describe("hard-gate parity (applyOne restates identityRejectReason)", () => {
	const WS = "/tmp/work/rules-parity";

	async function seededStore(): Promise<MemoryStore> {
		const dbPath = join(mkdtempSync(join(tmpdir(), "evolve-rules-parity-")), "memory.db");
		const fresh = await openMemoryStore(dbPath);
		expect(
			fresh.applyProposals(
				{ workspaceId: WS, trigger: "explicit", sessionId: "s1" },
				[{ action: "create", type: "user", title: "Rule A", description: "d", body: "b" }],
			)[0]?.ok,
		).toBe(true);
		return fresh;
	}

	it("agrees accept/reject with identityRejectReason (wording may differ)", () => {
		const cases = [
			{ action: "upsert", id: "rule-a" },
			{ action: "update", id: "forged-id", type: "user", title: "t", description: "d", body: "b" },
			{ action: "delete", id: "Bad_Id" },
		] as const;
		return (async () => {
			for (const proposal of cases) {
				const store = await seededStore();
				try {
					const allowed = new Set(store.list(WS).map((row) => row.id));
					const soft = identityRejectReason(proposal, allowed) === undefined;
					const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [proposal]);
					expect(outcome?.ok, JSON.stringify(proposal)).toBe(soft);
				} finally {
					store.close();
				}
			}
		})();
	});

	it("versions a substantive colliding create (M1) instead of dropping it", async () => {
		const store = await seededStore();
		try {
			const allowed = new Set(store.list(WS).map((row) => row.id));
			const proposal = { action: "create", id: "rule-a", type: "user", title: "t", description: "d", body: "b" } as const;
			expect(identityRejectReason(proposal, allowed)).toBeUndefined();
			const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [proposal]);
			expect(outcome?.ok).toBe(true);
			// M1 versions: the old row archives, exactly one versioned row goes active
			// (suffixes start at v2 by design).
			expect(store.list(WS).map((row) => row.id)).toEqual(["rule-a-v2"]);
			expect(store.get(WS, "rule-a")?.status).toBe("archived");
		} finally {
			store.close();
		}
	});

	it("fails closed on an exact-duplicate colliding create (soft passes, hard rejects)", async () => {
		// Intended divergence, pinned: the extraction screen drops body
		// duplicates first, so the hard gate only sees this on the explicit
		// path — where failing closed beats a silent double active row.
		const store = await seededStore();
		try {
			const allowed = new Set(store.list(WS).map((row) => row.id));
			const proposal = { action: "create", id: "rule-a", type: "user", title: "Rule A", description: "d", body: "b" } as const;
			expect(identityRejectReason(proposal, allowed)).toBeUndefined();
			const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [proposal]);
			expect(outcome?.ok).toBe(false);
			expect(store.list(WS)).toHaveLength(1);
		} finally {
			store.close();
		}
	});
});
