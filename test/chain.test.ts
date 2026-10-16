import { describe, expect, it } from "vitest";
import { runChain, type ChainLink } from "../src/services/chain.js";

interface Item {
	visited: string[];
}

/** A link that records its visit and reports a scripted outcome. */
function link(name: string, outcome: "handled" | "next"): ChainLink<Item> {
	return {
		name,
		handle(item: Item) {
			item.visited.push(name);
			return outcome;
		},
	};
}

describe("runChain", () => {
	it("walks the links in order until one handles the item", async () => {
		const item: Item = { visited: [] };
		await runChain([link("gate", "next"), link("evolve", "handled"), link("land", "next")], item);
		expect(item.visited).toEqual(["gate", "evolve"]);
	});

	it("lets a link decide asynchronously", async () => {
		const item: Item = { visited: [] };
		const asyncLink: ChainLink<Item> = {
			name: "async",
			async handle(seen: Item) {
				seen.visited.push("async");
				return "handled";
			},
		};
		await runChain([link("first", "next"), asyncLink], item);
		expect(item.visited).toEqual(["first", "async"]);
	});

	it("fails loud when no link handles the item", async () => {
		const item: Item = { visited: [] };
		await expect(runChain([link("a", "next"), link("b", "next")], item)).rejects.toThrow(
			/chain exhausted without a terminal link: a → b/,
		);
		expect(item.visited).toEqual(["a", "b"]);
	});

	it("treats an empty chain as a wiring bug too", async () => {
		await expect(runChain([], { visited: [] })).rejects.toThrow(/chain exhausted without a terminal link/);
	});
});
