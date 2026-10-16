/**
 * The responsibility chain behind one pass of a background ring.
 *
 * Each link owns exactly one step (call a subagent, land a verdict), knows
 * nothing about its neighbours, and reports whether it terminated the walk.
 * The environment class assembles the links, so adding, removing or
 * reordering a step is an assembly change — the alternative, every step
 * naming its own successor, is what hard-codes a flow into each step and puts
 * the same `kind === "memory" ? A : B` branch in several places.
 *
 * The item the links share is a plain mutable record: each link fills in what
 * it observed and reads only what earlier links left behind.
 */

/** What one link did: it terminated the walk (`handled`), or the item moves on (`next`). */
export type ChainOutcome = "handled" | "next";

/** One step of a chain. */
export interface ChainLink<Item> {
	/** Stable step name, used when the chain turns out to have no terminal link. */
	readonly name: string;
	handle(item: Item): ChainOutcome | Promise<ChainOutcome>;
}

/**
 * Walk the chain until a link handles the item.
 *
 * @param links - The assembled chain, in order.
 * @param item - The mutable item the links read and fill in.
 * @throws When no link handles the item — a chain without a terminal step is a wiring bug, not a quiet no-op.
 */
export async function runChain<Item>(links: readonly ChainLink<Item>[], item: Item): Promise<void> {
	for (const link of links) {
		if ((await link.handle(item)) === "handled") {
			return;
		}
	}
	throw new Error(`chain exhausted without a terminal link: ${links.map((link) => link.name).join(" → ")}`);
}
