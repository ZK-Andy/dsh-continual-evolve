import { describe, expect, it } from "vitest";
import {
	idParamOf,
	isGet,
	rootParamOf,
	sendJson,
	type CardResponse,
} from "../src/pages/memory-card/card-http.js";

function recorder(): { response: CardResponse; seen: { status: number; headers?: Record<string, string>; body?: string } } {
	const seen: { status: number; headers?: Record<string, string>; body?: string } = { status: 0 };
	const response: CardResponse = {
		writeHead(status: number, headers?: Record<string, string>) {
			seen.status = status;
			seen.headers = headers;
			return response;
		},
		end(body?: string) {
			seen.body = body;
			return response;
		},
	};
	return { response, seen };
}

describe("isGet", () => {
	it("treats GET and absent methods as GET, everything else not", () => {
		expect(isGet({ method: "GET", url: "/" })).toBe(true);
		expect(isGet({})).toBe(true);
		expect(isGet({ method: "POST", url: "/" })).toBe(false);
	});
});

describe("sendJson", () => {
	it("replies with the status and a JSON body", () => {
		const { response, seen } = recorder();
		sendJson(response, 404, { error: "nope" });
		expect(seen.status).toBe(404);
		expect(seen.headers?.["content-type"]).toContain("application/json");
		expect(JSON.parse(seen.body ?? "")).toEqual({ error: "nope" });
	});
});

describe("rootParamOf", () => {
	it("decodes the root parameter and rejects absence", () => {
		expect(rootParamOf({ url: "/x?root=%2Fws" })).toBe("/ws");
		expect(rootParamOf({ url: "/x" })).toBeNull();
		expect(rootParamOf({ url: "/x?root=  " })).toBeNull();
		expect(rootParamOf({})).toBeNull();
	});

	it("maps malformed URLs to null instead of throwing", () => {
		expect(rootParamOf({ url: "http://[" })).toBeNull();
	});
});

describe("idParamOf", () => {
	it("decodes the id parameter and rejects absence", () => {
		expect(idParamOf({ url: "/x?id=abc" })).toBe("abc");
		expect(idParamOf({ url: "/x" })).toBeNull();
		expect(idParamOf({ url: "/x?id=" })).toBeNull();
		expect(idParamOf({})).toBeNull();
	});

	it("maps malformed URLs to null instead of throwing", () => {
		expect(idParamOf({ url: "http://[" })).toBeNull();
	});
});
