import { describe, expect, it } from "vitest";
import {
	LlmConfigError,
	SubagentCallError,
	failureCodeOf,
	isRouteRejected,
	isRouteRejectedCode,
	observedUsageOf,
	selectLowestReasoningEffort,
	selectMaxTokens,
	streamOnce,
	type LlmRuntime,
	type ModelInfo,
} from "../src/services/llm-call.js";
import { defaultRouteOf, resolveCallRoute, type ServiceGetter } from "../src/services/model-route.js";

const ROUTE = { provider: "dsh-opencode-go", model: "deepseek-v4.1-flash" };

/** A scripted LLM runtime that records every options object it is called with. */
function scriptedLlm(
	chunks: readonly unknown[],
	modelInfo?: ModelInfo | undefined,
): LlmRuntime & { seen: Record<string, unknown>[] } {
	const seen: Record<string, unknown>[] = [];
	const llm: LlmRuntime & { seen: Record<string, unknown>[] } = {
		seen,
		async *stream(options: Record<string, unknown>): AsyncIterable<unknown> {
			seen.push(options);
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	};
	if (modelInfo !== undefined) {
		llm.resolveModelInfo = async () => modelInfo;
	}
	return llm;
}

/** A service reader that answers exactly one service name. */
function getterOf(services: Record<string, unknown>): ServiceGetter {
	return (name: string) => services[name];
}

describe("selectLowestReasoningEffort", () => {
	it("takes the first enabled effort and skips the closing ones", () => {
		expect(selectLowestReasoningEffort({ reasoning: { efforts: [{ id: "off" }, { id: "low" }, { id: "high" }] } })).toBe("low");
	});

	it("falls back to the first declared effort when the model publishes only closing ones", () => {
		expect(selectLowestReasoningEffort({ reasoning: { efforts: [{ id: "disabled" }] } })).toBe("disabled");
	});

	it("omits the field when the model exposes no reasoning metadata", () => {
		expect(selectLowestReasoningEffort(undefined)).toBeUndefined();
		expect(selectLowestReasoningEffort({})).toBeUndefined();
		expect(selectLowestReasoningEffort({ reasoning: {} })).toBeUndefined();
		expect(selectLowestReasoningEffort({ reasoning: { efforts: [] } })).toBeUndefined();
	});

	it("refuses metadata it cannot trust", () => {
		expect(() => selectLowestReasoningEffort({ reasoning: { efforts: "low" } })).toThrow(/invalid model reasoning metadata/);
		expect(() => selectLowestReasoningEffort({ reasoning: { efforts: [{ id: 7 }] } })).toThrow(/invalid model reasoning metadata/);
	});
});

describe("selectMaxTokens", () => {
	it("prefers the model's own advertised per-request cap", () => {
		expect(selectMaxTokens({ defaultMaxTokens: 8192 }, 1024)).toBe(8192);
	});

	it("falls back to the definition's budget when nothing is advertised", () => {
		expect(selectMaxTokens(undefined, 1024)).toBe(1024);
		expect(selectMaxTokens({}, 4096)).toBe(4096);
	});

	it("refuses a capability it cannot trust", () => {
		expect(() => selectMaxTokens({ defaultMaxTokens: "many" }, 1024)).toThrow(/invalid model max-tokens metadata/);
		expect(() => selectMaxTokens({ defaultMaxTokens: 0 }, 1024)).toThrow(/invalid model max-tokens metadata/);
		expect(() => selectMaxTokens({ defaultMaxTokens: 12.5 }, 1024)).toThrow(/invalid model max-tokens metadata/);
	});
});

describe("defaultRouteOf", () => {
	it("reads the host default-model service", () => {
		const get = getterOf({ agentDefaultModel: { currentSelection: () => ROUTE } });
		expect(defaultRouteOf(get)).toEqual(ROUTE);
	});

	it("carries the configured reasoning effort when the selection names one", () => {
		const get = getterOf({ agentDefaultModel: { currentSelection: () => ({ ...ROUTE, reasoningEffort: "high" }) } });
		expect(defaultRouteOf(get)).toEqual({ ...ROUTE, reasoningEffort: "high" });
	});

	it("treats an empty provider or model as no route", () => {
		expect(defaultRouteOf(getterOf({ agentDefaultModel: { currentSelection: () => ({ provider: "", model: "m" }) } }))).toBeUndefined();
		expect(defaultRouteOf(getterOf({ agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "" }) } }))).toBeUndefined();
	});

	it("stays undefined when the service, the reader, or the call is missing", () => {
		expect(defaultRouteOf(undefined)).toBeUndefined();
		expect(defaultRouteOf(getterOf({}))).toBeUndefined();
		expect(defaultRouteOf(getterOf({ agentDefaultModel: {} }))).toBeUndefined();
		expect(defaultRouteOf(getterOf({ agentDefaultModel: { currentSelection: () => "nope" } }))).toBeUndefined();
		expect(defaultRouteOf(() => {
			throw new Error("service lookup down");
		})).toBeUndefined();
		expect(defaultRouteOf(getterOf({
			agentDefaultModel: {
				currentSelection: () => {
					throw new Error("service read down");
				},
			},
		}))).toBeUndefined();
	});
});

describe("resolveCallRoute", () => {
	const DEFAULT_ROUTE = { provider: "host", model: "host-default" };
	const agentWith = (session: unknown, options: unknown = undefined) => ({ session, options });

	it("reads the session's current selection before anything else", () => {
		const get = getterOf({
			sessionProjections: {
				stateOf: () => ({ pending: { provider: "p", model: "pending" }, lastUsed: { provider: "p", model: "used" } }),
			},
			agentDefaultModel: { currentSelection: () => DEFAULT_ROUTE },
		});
		const headers = { requestHeader: () => ({ config: { provider: "h", model: "header" } }) };

		expect(resolveCallRoute(agentWith(headers, { provider: "old", model: "old" }), get)).toEqual({
			selection: { provider: "p", model: "pending" },
			source: "session-selection",
		});
	});

	it("uses the projection's lastUsed when nothing is pending", () => {
		const get = getterOf({ sessionProjections: { stateOf: () => ({ pending: null, lastUsed: { provider: "p", model: "used" } }) } });

		expect(resolveCallRoute(agentWith({}), get)).toEqual({ selection: { provider: "p", model: "used" }, source: "session-selection" });
	});

	it("falls back to the session's last request header", () => {
		const get = getterOf({ sessionProjections: { stateOf: () => ({ pending: null, lastUsed: null }) } });
		const session = { requestHeader: () => ({ config: { provider: "h", model: "header" } }) };

		expect(resolveCallRoute(agentWith(session, { provider: "old", model: "old" }), get)).toEqual({
			selection: { provider: "h", model: "header" },
			source: "request-header",
		});
	});

	it("keeps the agent's creation-time options ahead of the host default", () => {
		const get = getterOf({ agentDefaultModel: { currentSelection: () => DEFAULT_ROUTE } });

		expect(resolveCallRoute(agentWith({}, { provider: "p", model: "m" }), get)).toEqual({
			selection: { provider: "p", model: "m" },
			source: "agent-options",
		});
	});

	it("falls back to the host default when nothing session-scoped answers", () => {
		const get = getterOf({ agentDefaultModel: { currentSelection: () => DEFAULT_ROUTE } });

		expect(resolveCallRoute(agentWith({}, {}), get)).toEqual({ selection: DEFAULT_ROUTE, source: "host-default" });
		expect(resolveCallRoute(undefined, get)).toEqual({ selection: DEFAULT_ROUTE, source: "host-default" });
	});

	it("skips a projection or a header that cannot answer", () => {
		const throwingGet: ServiceGetter = (name) => {
			if (name === "sessionProjections") {
				throw new Error("no service");
			}
			return { currentSelection: () => DEFAULT_ROUTE };
		};
		const throwingHeader = {
			requestHeader: () => {
				throw new Error("no header");
			},
		};

		expect(resolveCallRoute(agentWith(throwingHeader, {}), throwingGet)).toEqual({ selection: DEFAULT_ROUTE, source: "host-default" });
		// A registry without stateOf, and a state that is not an object: same skip.
		expect(resolveCallRoute(agentWith({}), getterOf({ sessionProjections: {} , agentDefaultModel: { currentSelection: () => DEFAULT_ROUTE } }))).toEqual({
			selection: DEFAULT_ROUTE,
			source: "host-default",
		});
		expect(
			resolveCallRoute(agentWith({}), getterOf({ sessionProjections: { stateOf: () => "garbage" }, agentDefaultModel: { currentSelection: () => DEFAULT_ROUTE } })),
		).toEqual({ selection: DEFAULT_ROUTE, source: "host-default" });
		expect(
			resolveCallRoute(
				agentWith({}),
				getterOf({
					sessionProjections: {
						stateOf: () => {
							throw new Error("unregistered key");
						},
					},
					agentDefaultModel: { currentSelection: () => DEFAULT_ROUTE },
				}),
			),
		).toEqual({ selection: DEFAULT_ROUTE, source: "host-default" });
	});

	it("reports no route when no candidate answers", () => {
		expect(resolveCallRoute(agentWith({}, { provider: "p", model: "" }), getterOf({}))).toBeUndefined();
		expect(resolveCallRoute({}, undefined)).toBeUndefined();
	});
});

describe("the failure code and its classification", () => {
	it("reads the host's code off a thrown value, and nothing off anything else", () => {
		const host = Object.assign(new Error("boom"), { code: "AUTH" });
		expect(failureCodeOf(host)).toBe("AUTH");
		expect(failureCodeOf(new Error("no code"))).toBeUndefined();
		expect(failureCodeOf(undefined)).toBeUndefined();
		expect(failureCodeOf({ code: "" })).toBeUndefined();
	});

	it("carries a mid-stream failure code onto the thrown call error", async () => {
		const llm: LlmRuntime = {
			// eslint-disable-next-line require-yield
			async *stream(): AsyncIterable<unknown> {
				throw Object.assign(new Error("opencode-go API error (403)"), { code: "AUTH" });
			},
		};
		const error = await streamOnce(llm, ROUTE, "sess-1", "sys", "prompt", 1024).catch((thrown: unknown) => thrown);

		expect((error as SubagentCallError).code).toBe("AUTH");
		expect(isRouteRejected(error)).toBe(true);
	});

	it("treats a refused route as terminal and everything unseen as transient", () => {
		for (const code of ["AUTH", "NO_ADAPTER", "PLUGIN_CONFIG"]) {
			expect(isRouteRejectedCode(code)).toBe(true);
		}
		// The host's own retryable set, a stream cut, and a code this plugin has
		// never seen: all transient — a retry may help, and only a known refusal
		// is worth halting on.
		for (const code of ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE", "WHO_KNOWS", undefined]) {
			expect(isRouteRejectedCode(code)).toBe(false);
		}
	});

	it("gives the plugin's own capability faults a terminal code", () => {
		const error = (() => {
			try {
				selectLowestReasoningEffort({ reasoning: { efforts: "nope" } });
				return undefined;
			} catch (thrown: unknown) {
				return thrown;
			}
		})();

		expect(error).toBeInstanceOf(LlmConfigError);
		expect(failureCodeOf(error)).toBe("PLUGIN_CONFIG");
		expect(isRouteRejected(error)).toBe(true);
	});
});

describe("streamOnce", () => {
	it("sends the capability-derived effort and the host session identity", async () => {
		const llm = scriptedLlm(
			[{ type: "text-delta", text: "ok" }, { type: "finish", reason: { kind: "stop" } }],
			{ reasoning: { efforts: [{ id: "off" }, { id: "low" }] } },
		);
		const result = await streamOnce(llm, ROUTE, "sess-1", "sys", "prompt", 1024);
		expect(result.text).toBe("ok");
		expect(result.finish).toBe("stop");
		expect(result.reasoningEffort).toBe("low");
		expect(llm.seen[0]?.reasoningEffort).toBe("low");
		expect(llm.seen[0]?.sessionId).toBe("sess-1");
		expect(llm.seen[0]?.provider).toBe(ROUTE.provider);
		expect(llm.seen[0]?.model).toBe(ROUTE.model);
	});

	it("sends the model's own output cap instead of the caller's number", async () => {
		const llm = scriptedLlm(
			[{ type: "text-delta", text: "ok" }, { type: "finish", reason: { kind: "stop" } }],
			{ defaultMaxTokens: 6000 },
		);
		await streamOnce(llm, ROUTE, "sess-1", "sys", "prompt", 1024);
		expect(llm.seen[0]?.maxTokens).toBe(6000);
	});

	it("keeps the usage and route a failed stream already reported", async () => {
		const llm = scriptedLlm([
			{ type: "usage", usage: { inputTokens: 5, outputTokens: 7 } },
			{ type: "finish", reason: { kind: "error", failure: { code: "X", message: "boom" } } },
		]);
		const error = await streamOnce(llm, ROUTE, "sess-1", "sys", "prompt", 1024).catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(SubagentCallError);
		expect((error as SubagentCallError).message).toBe("LLM call error: X: boom");
		expect((error as SubagentCallError).finish).toBe("error");
		expect((error as SubagentCallError).route).toEqual(ROUTE);
		expect((error as SubagentCallError).code).toBe("X");
		expect(observedUsageOf(error)).toEqual({ inputTokens: 5, outputTokens: 7 });
	});

	it("keeps the observation when the provider dies mid-stream", async () => {
		const llm: LlmRuntime & { seen: Record<string, unknown>[] } = {
			seen: [],
			// eslint-disable-next-line require-yield
			async *stream(options: Record<string, unknown>): AsyncIterable<unknown> {
				llm.seen.push(options);
				yield { type: "usage", usage: { totalTokens: 3 } };
				throw new Error("socket closed\nmore detail");
			},
		};
		const error = await streamOnce(llm, ROUTE, "sess-1", "sys", "prompt", 1024).catch((thrown: unknown) => thrown);
		expect((error as SubagentCallError).message).toBe("socket closed more detail");
		expect((error as SubagentCallError).usage).toEqual({ totalTokens: 3 });
		expect((error as SubagentCallError).code).toBeUndefined();
		expect((error as Error).cause).toBeInstanceOf(Error);
	});

	it("keeps the usage on an empty or cut answer too", async () => {
		const cut = scriptedLlm([
			{ type: "usage", usage: { totalTokens: 11 } },
			{ type: "finish", reason: { kind: "max-tokens" } },
		]);
		const error = await streamOnce(cut, ROUTE, "sess-1", "sys", "prompt", 1024).catch((thrown: unknown) => thrown);
		expect((error as SubagentCallError).message).toBe("stream finished with max-tokens");
		expect((error as SubagentCallError).finish).toBe("max-tokens");
		expect((error as SubagentCallError).usage).toEqual({ totalTokens: 11 });
	});

	it("omits the effort field when the host cannot resolve capabilities", async () => {
		const llm = scriptedLlm([{ type: "text-delta", text: "ok" }, { type: "finish", reason: { kind: "stop" } }]);
		const result = await streamOnce(llm, ROUTE, "sess-1", "sys", "prompt", 1024);
		expect(result.reasoningEffort).toBeUndefined();
		expect(Object.hasOwn(llm.seen[0] ?? {}, "reasoningEffort")).toBe(false);
	});

	it("refuses to stream at all without an LLM service", async () => {
		await expect(streamOnce(undefined, ROUTE, "sess-1", "sys", "prompt", 1024)).rejects.toThrow(/no llm route/);
	});

	it("surfaces the host failure text instead of a bare finish kind", async () => {
		const llm = scriptedLlm([
			{ type: "finish", reason: { kind: "error", failure: { code: "UNSUPPORTED_REASONING_EFFORT", message: 'model "m" does not support reasoning effort "high"' } } },
		]);
		await expect(streamOnce(llm, ROUTE, "sess-1", "sys", "prompt", 1024)).rejects.toThrow(
			/LLM call error: UNSUPPORTED_REASONING_EFFORT: model "m" does not support reasoning effort "high"/,
		);
	});

	it("still names the finish kind when the host reports no failure object", async () => {
		const llm = scriptedLlm([{ type: "finish", reason: { kind: "error" } }]);
		await expect(streamOnce(llm, ROUTE, "sess-1", "sys", "prompt", 1024)).rejects.toThrow(/stream finished with error/);
	});

	it("reports an abort as an abort", async () => {
		const llm = scriptedLlm([{ type: "finish", reason: { kind: "aborted", failure: { message: "cancelled" } } }]);
		await expect(streamOnce(llm, ROUTE, "sess-1", "sys", "prompt", 1024)).rejects.toThrow(/LLM call aborted: cancelled/);
	});

	it("hands a max-tokens cut to the caller instead of throwing it", async () => {
		const llm = scriptedLlm([{ type: "text-delta", text: '{"worthReview":true}' }, { type: "finish", reason: { kind: "max-tokens" } }]);
		const result = await streamOnce(llm, ROUTE, "sess-1", "sys", "prompt", 1024);
		expect(result.finish).toBe("max-tokens");
		expect(result.text).toBe('{"worthReview":true}');
	});

	it("throws on empty output and names the finish kind when there is one", async () => {
		const quiet = scriptedLlm([{ type: "finish", reason: { kind: "stop" } }]);
		await expect(streamOnce(quiet, ROUTE, "sess-1", "sys", "prompt", 1024)).rejects.toThrow(/empty model output/);
		const cut = scriptedLlm([{ type: "finish", reason: { kind: "max-tokens" } }]);
		await expect(streamOnce(cut, ROUTE, "sess-1", "sys", "prompt", 1024)).rejects.toThrow(/stream finished with max-tokens/);
	});

	it("propagates a capability lookup failure before any provider I/O", async () => {
		const llm = scriptedLlm([{ type: "text-delta", text: "never" }]);
		llm.resolveModelInfo = async () => {
			throw new Error("capability lookup down");
		};
		await expect(streamOnce(llm, ROUTE, "sess-1", "sys", "prompt", 1024)).rejects.toThrow(/capability lookup down/);
		expect(llm.seen).toHaveLength(0);
	});
});
