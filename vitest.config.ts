import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/index.ts", "src/types.ts"],
			thresholds: {
				lines: 75,
				functions: 75,
				statements: 75,
				branches: 65,
			},
		},
	},
});
