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
				// (2026-09-25 round 3: stmts/lines minimum review-scheduler 86.58,
				// branches minimum wrapup-command 75.6, functions minimum fate 90);
				// raise toward 100 file by file.
				perFile: true,
				lines: 86,
				functions: 90,
				statements: 86,
				branches: 75,
			},
		},
	},
});
