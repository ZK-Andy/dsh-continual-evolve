import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globalSetup: "./test/global-setup.ts",
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/index.ts", "src/types.ts"],
			thresholds: {
				// DSH-shaped per-file gate: every file must clear the floor,
				// not just the repo average. Values are the current waterline
				// (2026-09-25 round 5: stmts/lines minimum validate 91.24,
				// branches minimum wrapup-command 75.6, functions minimum logfile 91.66);
				// raise toward 100 file by file.
				perFile: true,
				lines: 91,
				functions: 91,
				statements: 91,
				branches: 75,
			},
		},
	},
});
