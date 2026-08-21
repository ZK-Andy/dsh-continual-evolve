import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TMP_DIR = join(process.cwd(), "test/.tmp");

/**
 * Vitest global setup keeping `test/.tmp` as an empty scratch directory.
 *
 * Suites create unique state directories under `test/.tmp` via `mkdtempSync`
 * (which requires the parent to exist) or address the base path directly.
 * The returned teardown wipes the whole tree after every run, so test state
 * never accumulates in the working tree; leftovers from a crashed run are
 * likewise reset on the next startup.
 *
 * @returns teardown function invoked once after all test files finish.
 * @throws when `test/.tmp` cannot be created (propagates to vitest startup).
 */
export default function globalSetup(): () => void {
	mkdirSync(TMP_DIR, { recursive: true });
	return () => {
		rmSync(TMP_DIR, { recursive: true, force: true });
		mkdirSync(TMP_DIR, { recursive: true });
	};
}
