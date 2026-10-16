import { describe, expect, it } from "vitest";
import { mountCreatorSkillsWhenAvailable } from "../src/assemble.js";

describe("shared mount assembly", () => {
	it("mounts the creator skills through nested inject and logs registration", () => {
		const events: string[] = [];
		const log = {
			warn: (event: string) => events.push(`warn:${event}`),
			info: (event: string) => events.push(`info:${event}`),
		};
		let registered = 0;
		const host = {
			inject: (services: string[], callback: (scoped: unknown) => void) => {
				expect(services).toEqual(["skills"]);
				callback({ skills: { registerProvider: () => registered++ } });
			},
		};
		mountCreatorSkillsWhenAvailable(host, log);
		expect(registered).toBe(1);
		expect(events).toContain("info:creator-skills-registered");
	});

	it("creator-skills mount degrades with a warning when inject or service is missing", () => {
		const events: string[] = [];
		const log = {
			warn: (event: string) => events.push(`warn:${event}`),
			info: (event: string) => events.push(`info:${event}`),
		};
		mountCreatorSkillsWhenAvailable({}, log);
		mountCreatorSkillsWhenAvailable({ inject: (_services: string[], callback: (scoped: unknown) => void) => callback({}) }, log);
		expect(events).toEqual(["warn:creator-skills-not-mounted", "warn:creator-skills-empty"]);
	});
});
