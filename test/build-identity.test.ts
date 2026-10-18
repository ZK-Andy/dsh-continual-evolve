import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UNKNOWN_GENERATION, buildIdentity, describeIdentity, identify } from "../src/services/build-identity.js";

function tempFile(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "evolve-build-"));
	const file = join(dir, "index.js");
	writeFileSync(file, content);
	return file;
}

describe("identify", () => {
	it("reports no restart when the loaded and disk bytes agree", () => {
		const file = tempFile("module.exports = 1;");
		const loaded = identify(file, "x", "v").diskGeneration;
		const identity = identify(file, loaded, "1.2.3");
		expect(identity).toMatchObject({ version: "1.2.3", staleOnDisk: false, restartRequired: false });
		expect(identity.diskGeneration).toBe(loaded);
	});

	it("reports a restart when the disk bytes changed after load", () => {
		const file = tempFile("module.exports = 1;");
		const loaded = identify(file, "x", "v").diskGeneration;
		writeFileSync(file, "module.exports = 2;");
		const identity = identify(file, loaded, "1.2.3");
		expect(identity.staleOnDisk).toBe(true);
		expect(identity.restartRequired).toBe(true);
		expect(identity.codeGeneration).not.toBe(identity.diskGeneration);
	});

	it("never claims staleness when a side is unknown", () => {
		expect(identify(join(tmpdir(), "definitely-absent-file.js"), "abc", "v").staleOnDisk).toBe(false);
		expect(identify(tempFile("x"), UNKNOWN_GENERATION, "v").staleOnDisk).toBe(false);
		expect(identify(undefined, "abc", "v").diskGeneration).toBe(UNKNOWN_GENERATION);
	});

	it("is stable for the same bytes", () => {
		const file = tempFile("same");
		expect(identify(file, "x", "v").diskGeneration).toBe(identify(file, "y", "v").diskGeneration);
	});
});

describe("buildIdentity", () => {
	it("reports the running plugin without throwing", () => {
		const identity = buildIdentity();
		expect(typeof identity.codeGeneration).toBe("string");
		expect(identity.staleOnDisk).toBe(identity.restartRequired);
	});

	it("describes a stale process loudly and a current one plainly", () => {
		expect(describeIdentity(identify(tempFile("a"), "olds", "0.0.0"))).toContain("restart the host");
		const file = tempFile("b");
		const current = identify(file, identify(file, "x", "v").diskGeneration, "0.0.0");
		expect(describeIdentity(current)).toContain("disk matches");
	});
});
