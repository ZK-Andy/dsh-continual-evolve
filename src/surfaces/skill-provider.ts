/**
 * The plugin's own creator skills as a bundled provider (upstream
 * `dsh-skill-badge` pattern): the two `evolve_*` authoring guides ship in
 * the package (`assets/`) and register as immutable bundled-rank
 * candidates, so every session under a profile with this plugin sees them —
 * no workspace `.agents/skills` copy, no database row, no file projection.
 *
 * Discovery stays entirely host-side: `list()` never touches the filesystem
 * (complete-discovery shorthand) and `get()` rereads the asset file on every
 * load (no body cache, mirroring the host's progressive-disclosure
 * contract). Missing or unreadable assets fail loud at load, never as a
 * silently wrong catalog.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Bundled rank in the host skill catalog (upstream local-provider table). */
export const BUNDLED_SKILL_RANK = 600;

/** Provider name under which the creator skills register. */
export const CREATOR_SKILLS_PROVIDER = "continual-evolve";

/** Skill source the host assigns to packaged skills. */
export const BUNDLED_SKILL_SOURCE = "bundled" as const;

/** One shipped creator skill: catalog identity plus its asset file. */
export interface CreatorSkillSpec {
	id: string;
	description: string;
	file: string;
}

/** The two shipped creator skills (ids double as lookup keys). */
export const CREATOR_SKILLS: readonly CreatorSkillSpec[] = [
	{
		id: "evolve-skill-creator",
		description:
			"写一条可复用的自创技能（evolve_ 前缀）——从用户的一段做法里提炼出标题、触发钩子和正文。自创技能要沉淀时用它；改官方 dsh-* 技能时不要用它。",
		file: "evolve-skill-creator.md",
	},
	{
		id: "evolve-memory-creator",
		description:
			"写一条持久记忆——从对话里提炼用户画像、做法纠正或资源指针，配好类型、钩子和正文。用户明确说记住/忘掉时用它；仓库版本细节（归 ADR/docs）不要写成记忆。",
		file: "evolve-memory-creator.md",
	},
];

/** Model/user invocability flags on a catalog candidate. */
export interface SkillInvocation {
	modelInvocable: boolean;
	userInvocable: boolean;
}

/** A packaged skill directory serving as the skill's resource base. */
export interface CreatorSkillResourceBase {
	kind: "directory";
	path: string;
}

/** One catalog candidate (host `SkillCandidate` shape, declared locally). */
export interface CreatorSkillCandidate {
	name: string;
	description: string;
	invocation: SkillInvocation;
	provider: string;
	source: typeof BUNDLED_SKILL_SOURCE;
	resourceBase: CreatorSkillResourceBase;
	rank: number;
	locator: URL;
}

/** A loaded skill body (host `SkillDefinition` shape, declared locally). */
export interface CreatorSkillDefinition extends CreatorSkillCandidate {
	content: string;
}

/** One immutable provider serving the shipped creator skills. */
export interface CreatorSkillProvider {
	name: string;
	list: () => CreatorSkillCandidate[];
	get: (candidate: { name: string }) => Promise<CreatorSkillDefinition>;
}

/** The minimal host skills service this provider registers against. */
export interface CreatorSkillsService {
	registerProvider(factory: () => CreatorSkillProvider): unknown;
}

/** Shared invocation flags: loadable by model and by user alike. */
const CREATOR_INVOCATION: SkillInvocation = { modelInvocable: true, userInvocable: true };

/**
 * Build the catalog candidate for one shipped skill.
 * @param spec - The creator skill spec.
 * @param assetsDir - The directory holding the shipped asset files.
 * @returns The candidate exactly as the host catalog renders it.
 */
export function creatorCandidate(spec: CreatorSkillSpec, assetsDir: string): CreatorSkillCandidate {
	return {
		name: spec.id,
		description: spec.description,
		invocation: CREATOR_INVOCATION,
		provider: CREATOR_SKILLS_PROVIDER,
		source: BUNDLED_SKILL_SOURCE,
		resourceBase: { kind: "directory", path: assetsDir },
		rank: BUNDLED_SKILL_RANK,
		locator: new URL(`file://${join(assetsDir, spec.file)}`),
	};
}

/**
 * Read one shipped body fresh from disk (every load, never cached).
 * @param assetsDir - The directory holding the shipped asset files.
 * @param spec - The creator skill spec.
 * @returns The current file content verbatim.
 * @throws When the asset is missing or unreadable (fail loud at load).
 */
export function readCreatorBody(assetsDir: string, spec: CreatorSkillSpec): string {
	return readFileSync(join(assetsDir, spec.file), "utf8");
}

/**
 * Resolve a candidate name to its spec.
 * @param name - The requested skill name.
 * @returns The matching spec.
 * @throws When no shipped skill carries that name (stale-name fail loud).
 */
function specFor(name: string): CreatorSkillSpec {
	const found = CREATOR_SKILLS.find((spec) => spec.id === name);
	if (found === undefined) {
		throw new Error(
			`unknown creator skill "${name}" (this provider only serves ${CREATOR_SKILLS.map((spec) => spec.id).join(", ")})`,
		);
	}
	return found;
}

/**
 * Build the immutable provider serving the shipped creator skills.
 * @param assetsDir - The directory holding the shipped asset files.
 * @returns A provider whose list is fs-free and whose get rereads per load.
 */
export function createCreatorProvider(assetsDir: string): CreatorSkillProvider {
	return {
		name: CREATOR_SKILLS_PROVIDER,
		list: () => CREATOR_SKILLS.map((spec) => creatorCandidate(spec, assetsDir)),
		get: async (candidate) => {
			const spec = specFor(candidate.name);
			return { ...creatorCandidate(spec, assetsDir), content: readCreatorBody(assetsDir, spec) };
		},
	};
}

/**
 * Register the creator provider against the host skills service.
 * @param skills - The host skills service.
 * @param assetsDir - The directory holding the shipped asset files.
 */
export function registerCreatorSkills(skills: CreatorSkillsService, assetsDir: string): void {
	skills.registerProvider(() => createCreatorProvider(assetsDir));
}

/** The minimal plugin log face mount events report through. */
export interface SkillsMountLog {
	warn(event: string, message: string): void;
	info(event: string, message: string): void;
}

/** Nested-inject lookup shape (cast target only — the parameter stays `unknown`). */
interface SkillsMountHost {
	inject?: ((services: string[], callback: (scoped: unknown) => void) => void) | undefined;
}

/**
 * Register the bundled creator skills when the host has a skills service.
 * A host without nested inject (or without the service) degrades to a
 * warning — section and tools are unaffected.
 * @param host - The host context to look the skills service up in.
 * @param log - The plugin log face for mount events.
 */
export function mountCreatorSkillsWhenAvailable(host: unknown, log: SkillsMountLog): void {
	const inject = (host as SkillsMountHost).inject;
	if (typeof inject !== "function") {
		log.warn("creator-skills-not-mounted", "no host inject — creator skills not registered");
		return;
	}
	inject(["skills"], (scoped: unknown) => {
		const skills = (scoped as { skills?: unknown }).skills as CreatorSkillsService | undefined;
		if (skills === undefined || typeof skills.registerProvider !== "function") {
			log.warn("creator-skills-empty", "no skills service — creator skills not registered");
			return;
		}
		registerCreatorSkills(skills, packageAssetsDir());
		log.info("creator-skills-registered", "creator skills registered (bundled rank)");
	});
}

/**
 * Resolve the shipped assets directory next to this module
 * (`<package>/assets` from either `src/` or `lib/` layouts).
 * @returns The absolute assets directory path.
 */
export function packageAssetsDir(): string {
	return fileURLToPath(new URL("../../assets", import.meta.url));
}
