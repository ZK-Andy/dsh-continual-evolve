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
				// (2026-09-25 actuals ~92/82/95); raise toward 100 file by file.
				perFile: true,
				lines: 78,
				functions: 65,
				statements: 78,
				branches: 65,
			},
		},
	},
});
