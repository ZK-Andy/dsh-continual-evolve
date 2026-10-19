import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globalSetup: "./test/global-setup.ts",
		// Gate fixture trees contain realistic *.test.ts samples for G3/G9;
		// they are exercised by spawning the gates, never by the runner itself.
		exclude: ["test/fixtures/**", "**/node_modules/**", "**/dist/**", "**/lib/**"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/index.ts"],
			thresholds: {
				// DSH-shaped per-file gate: every file must clear the floor,
				// not just the repo average. The plugin is three files since
				// the 2026-10-04 teardown; keep the floor honest as it grows.
				perFile: true,
				lines: 91,
				functions: 91,
				statements: 91,
				branches: 83,
			},
		},
	},
});
