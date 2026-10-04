import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKnownWorkspaces } from "../src/known-workspaces.js";
import { createWorkspaceCatalog, type WorkspaceCatalogOptions } from "../src/workspace-catalog.js";

let root = "";
let home = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "evolve-catalog-"));
	home = mkdtempSync(join(tmpdir(), "evolve-home-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

/** A workspace directory holding a plain memory store. */
function withMemory(name: string): string {
	const path = join(root, name);
	mkdirSync(join(path, ".evolve", "memory"), { recursive: true });
	return path;
}

/** A workspace directory without a store. */
function withoutMemory(name: string): string {
	const path = join(root, name);
	mkdirSync(path, { recursive: true });
	return path;
}

/** A registry service stub over raw records. */
function registry(records: unknown): { list: () => unknown } {
	return { list: () => records };
}

/** The canonical spelling the catalogue is expected to report. */
function real(path: string): string {
	return realpathSync(path);
}

function catalogWith(options: WorkspaceCatalogOptions) {
	return createWorkspaceCatalog(options);
}

describe("createWorkspaceCatalog", () => {
	it("lists registry workspaces that have a store, in registry order", () => {
		const gamma = withMemory("gamma");
		const beta = withoutMemory("beta");
		const alpha = withMemory("alpha");
		const catalog = catalogWith({
			registry: () =>
				registry([
					{ path: gamma, title: "Gamma" },
					{ path: beta, title: "Beta" },
					{ path: alpha, title: "Alpha" },
				]),
			served: createKnownWorkspaces(),
		});
		// The listing is the display projection: only workspaces with a store,
		// keeping the registry's own order.
		expect(catalog.list()).toEqual([
			{ root: real(gamma), label: "Gamma" },
			{ root: real(alpha), label: "Alpha" },
		]);
		// The fence is wider on purpose: every catalogued workspace is readable,
		// so a store deleted after the listing degrades instead of turning 404.
		expect(catalog.known().map((entry) => entry.root)).toContain(real(beta));
	});

	it("falls back to the registry file when the service yields nothing", () => {
		const alpha = withMemory("alpha");
		const beta = withoutMemory("beta");
		mkdirSync(join(home, "storages"), { recursive: true });
		writeFileSync(
			join(home, "storages", "workspace.json"),
			JSON.stringify({ tables: { workspaces: { one: { path: alpha, title: "Alpha" }, two: { path: beta } } } }),
			"utf8",
		);
		const catalog = catalogWith({ served: createKnownWorkspaces(), homeDir: home });
		expect(catalog.known()).toEqual([
			{ root: real(alpha), label: "Alpha" },
			// No title: the directory name stands in.
			{ root: real(beta), label: basename(beta) },
		]);
	});

	it("prefers the live service over the registry file", () => {
		const live = withMemory("live");
		const stale = withMemory("stale");
		mkdirSync(join(home, "storages"), { recursive: true });
		writeFileSync(
			join(home, "storages", "workspace.json"),
			JSON.stringify({ tables: { workspaces: { one: { path: stale, title: "Stale" } } } }),
			"utf8",
		);
		const catalog = catalogWith({
			registry: () => registry([{ path: live, title: "Live" }]),
			served: createKnownWorkspaces(),
			homeDir: home,
		});
		expect(catalog.known().map((entry) => entry.label)).toEqual(["Live"]);
	});

	it("survives a throwing, empty or malformed service and still uses the file", () => {
		const fromFile = withMemory("from-file");
		mkdirSync(join(home, "storages"), { recursive: true });
		writeFileSync(
			join(home, "storages", "workspace.json"),
			JSON.stringify({ tables: { workspaces: { one: { path: fromFile } } } }),
			"utf8",
		);
		const throwing = catalogWith({
			registry: () => ({ list: () => { throw new Error("registry down"); } }),
			served: createKnownWorkspaces(),
			homeDir: home,
		});
		expect(throwing.known().map((entry) => entry.root)).toEqual([real(fromFile)]);
		const notAnArray = catalogWith({
			registry: () => registry("garbage"),
			served: createKnownWorkspaces(),
			homeDir: home,
		});
		expect(notAnArray.known().map((entry) => entry.root)).toEqual([real(fromFile)]);
		const malformed = catalogWith({
			registry: () => registry([null, {}, { path: 42 }, { path: "   " }, { path: join(root, "missing"), title: "  " }]),
			served: createKnownWorkspaces(),
		});
		// Only the entry with a usable path survives; a title of blanks falls
		// back to the directory name.
		expect(malformed.known()).toEqual([
			{ root: join(real(root), "missing"), label: "missing" },
		]);
	});

	it("unions the served roots and deduplicates by canonical path", () => {
		const servedPath = withMemory("served");
		const registryPath = withMemory("registered");
		const served = createKnownWorkspaces();
		served.remember(servedPath);
		// The same root twice: once from each source.
		served.remember(registryPath);
		const catalog = catalogWith({
			registry: () => registry([{ path: registryPath, title: "Registered" }, { path: servedPath, title: "Served" }]),
			served,
		});
		const roots = catalog.known().map((entry) => entry.root);
		expect(roots.filter((entry) => entry === real(registryPath))).toHaveLength(1);
		expect(roots).toHaveLength(2);
		// The registry's label wins over the served fallback label.
		expect(catalog.known().map((entry) => entry.label)).toEqual(["Registered", "Served"]);
	});

	it("treats a symlinked memory directory as no store at all", () => {
		const target = withMemory("target");
		const linked = withoutMemory("linked");
		mkdirSync(join(linked, ".evolve"), { recursive: true });
		symlinkSync(join(target, ".evolve", "memory"), join(linked, ".evolve", "memory"));
		const catalog = catalogWith({
			registry: () => registry([{ path: linked, title: "Linked" }, { path: target, title: "Target" }]),
			served: createKnownWorkspaces(),
		});
		expect(catalog.list().map((entry) => entry.label)).toEqual(["Target"]);
		expect(catalog.known()).toHaveLength(2);
	});

	it("is empty without any source", () => {
		const catalog = catalogWith({ served: createKnownWorkspaces() });
		expect(catalog.known()).toEqual([]);
		expect(catalog.list()).toEqual([]);
	});
});
