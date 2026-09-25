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
				// (2026-09-25 round 2 actuals ~96/85/98; minima skillquality/fate); raise toward 100 file by file.
				perFile: true,
				lines: 82,
				functions: 90,
				statements: 82,
				branches: 75,
			},
		},
	},
});
