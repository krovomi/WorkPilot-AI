/**
 * Setting up a phone app from the task form, for a project that has none.
 *
 * Checking Android or iOS on a .NET Web API used to mean nothing: there was no
 * app for the agents to build. Now the form reads the project's mobile profile
 * (`apps/backend/mobile/bootstrap.py`) and, when no phone framework is found,
 * adds the setup tasks to the board before the task itself:
 *
 * 1. install the framework's toolchain and create the app (once per board);
 * 2. prepare each platform checked (one task per platform), after step 1;
 * 3. the task the person wrote waits for step 2 (`metadata.blockedBy`).
 *
 * A setup task that is still open on the board is reused rather than created
 * again: two tasks asking for Android get one Flutter install, not two.
 */

import type { TFunction } from "i18next";
import type { Task, TaskMetadata } from "../../shared/types";
import type {
	MobileBootstrapMark,
	MobilePlatform,
	MobileProfile,
	MobileSetupFramework,
} from "../../shared/types/mobile";
import { MOBILE_PLATFORMS } from "../../shared/types/mobile";

/** One task of the setup: already on the board, or to create. */
export interface MobileSetupStep {
	mark: MobileBootstrapMark;
	title: string;
	/** Set when an open setup task of the board already does this step. */
	existing?: Task;
}

export interface MobileSetupPlan {
	framework: MobileSetupFramework;
	install: MobileSetupStep;
	platforms: MobileSetupStep[];
}

/** Blockers that finished, or will never finish, do not count as open. */
const CLOSED = new Set(["done", "pr_created"]);

function isOpen(task: Task): boolean {
	return (
		!CLOSED.has(task.status) &&
		!task.metadata?.archivedAt &&
		!task.metadata?.abandoned
	);
}

/** True when the project has no phone app and the checked platforms need one. */
export function needsMobileSetup(
	profile: MobileProfile | null | undefined,
	platforms: readonly MobilePlatform[],
): boolean {
	return Boolean(
		profile?.success &&
			!profile.isMobile &&
			platforms.length > 0 &&
			(profile.frameworks?.length ?? 0) > 0,
	);
}

/** The frameworks that can build every checked platform, best fit first. */
export function frameworksFor(
	profile: MobileProfile | null | undefined,
	platforms: readonly MobilePlatform[],
): MobileSetupFramework[] {
	return (profile?.frameworks ?? []).filter((framework) =>
		platforms.every((platform) => framework.platforms.includes(platform)),
	);
}

/** The setup tasks still open on the board, by step. */
export function openSetupTasks(tasks: readonly Task[]): Task[] {
	return tasks.filter((task) => task.metadata?.mobileBootstrap && isOpen(task));
}

/**
 * The framework the setup uses: the one an open setup task already installs
 * (when it covers the platforms), else the person's choice, else the best fit.
 */
export function resolveFramework(
	profile: MobileProfile | null | undefined,
	platforms: readonly MobilePlatform[],
	chosen: string | null,
	tasks: readonly Task[],
): { framework: MobileSetupFramework | null; locked: boolean } {
	const candidates = frameworksFor(profile, platforms);
	const pending = openSetupTasks(tasks)
		.map((task) => task.metadata?.mobileBootstrap?.framework)
		.find((id) => id && candidates.some((f) => f.id === id));
	if (pending) {
		return {
			framework: candidates.find((f) => f.id === pending) ?? null,
			locked: true,
		};
	}
	const picked = candidates.find((f) => f.id === chosen) ?? candidates[0] ?? null;
	return { framework: picked, locked: false };
}

function platformLabel(t: TFunction, platform: MobilePlatform): string {
	return t(`mobile:targets.${platform}`);
}

/** The setup steps for these platforms, reusing what the board already has. */
export function planMobileSetup(
	framework: MobileSetupFramework,
	platforms: readonly MobilePlatform[],
	tasks: readonly Task[],
	t: TFunction,
): MobileSetupPlan {
	const open = openSetupTasks(tasks).filter(
		(task) => task.metadata?.mobileBootstrap?.framework === framework.id,
	);
	const find = (step: "install" | "platform", platform?: MobilePlatform) =>
		open.find(
			(task) =>
				task.metadata?.mobileBootstrap?.step === step &&
				(step === "install" || task.metadata?.mobileBootstrap?.platform === platform),
		);
	const ordered = MOBILE_PLATFORMS.filter((p) => platforms.includes(p));
	return {
		framework,
		install: {
			mark: { framework: framework.id, step: "install" },
			title: t("mobile:setup.installTitle", { framework: framework.label }),
			existing: find("install"),
		},
		platforms: ordered.map((platform) => ({
			mark: { framework: framework.id, step: "platform", platform },
			title: t("mobile:setup.platformTitle", {
				framework: framework.label,
				platform: platformLabel(t, platform),
			}),
			existing: find("platform", platform),
		})),
	};
}

function bullets(lines: readonly string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

/** The description an agent reads for the install-and-create step. */
export function installDescription(
	plan: MobileSetupPlan,
	profile: MobileProfile,
	platforms: readonly MobilePlatform[],
	t: TFunction,
): string {
	const { framework } = plan;
	const names = platforms.map((p) => platformLabel(t, p)).join(", ");
	const scaffold = framework.scaffold.map((line) =>
		line.replace("{platforms}", platforms.join(",")),
	);
	const sections = [
		t("mobile:setup.generatedNote"),
		t("mobile:setup.installGoal", {
			framework: framework.label,
			dir: profile.mobileDir ?? "mobile",
			platforms: names,
		}),
		`${t("mobile:setup.toolchainHeading")}\n${bullets(framework.install)}`,
		`${t("mobile:setup.scaffoldHeading")}\n${bullets(scaffold)}`,
		framework.notes ? `${t("mobile:setup.notesHeading")}\n${bullets([framework.notes])}` : "",
		`${t("mobile:setup.docsHeading")} ${framework.docs}`,
	];
	return sections.filter(Boolean).join("\n\n");
}

/** The description an agent reads for one platform's preparation. */
export function platformDescription(
	plan: MobileSetupPlan,
	profile: MobileProfile,
	platform: MobilePlatform,
	t: TFunction,
): string {
	const { framework } = plan;
	const sections = [
		t("mobile:setup.generatedNote"),
		t("mobile:setup.platformGoal", {
			framework: framework.label,
			dir: profile.mobileDir ?? "mobile",
			platform: platformLabel(t, platform),
		}),
		`${t("mobile:setup.stepsHeading")}\n${bullets(framework.platformSetup[platform] ?? [])}`,
		platform === "ios" ? t("mobile:setup.iosNote") : "",
	];
	return sections.filter(Boolean).join("\n\n");
}

/** Creates one task; the store's `createTask`, injected for the tests. */
export type CreateTaskFn = (
	projectId: string,
	title: string,
	description: string,
	metadata?: TaskMetadata,
) => Promise<Task | null>;

/**
 * Put the setup on the board and answer the ids the task must wait for.
 *
 * `inherited` is what the setup tasks take from the task being written: its
 * engine, base branch and worktree choice, so they run like it does. Throws
 * when a task cannot be created: the caller then creates nothing more.
 */
export async function createMobileSetup(
	plan: MobileSetupPlan,
	profile: MobileProfile,
	projectId: string,
	inherited: TaskMetadata,
	create: CreateTaskFn,
	t: TFunction,
): Promise<string[]> {
	const platforms = plan.platforms.map((step) => step.mark.platform as MobilePlatform);
	const base: TaskMetadata = {
		...inherited,
		sourceType: "manual",
		category: "infrastructure",
	};

	let installId = plan.install.existing?.id;
	if (!installId) {
		const task = await create(
			projectId,
			plan.install.title,
			installDescription(plan, profile, platforms, t),
			{
				...base,
				mobileTargets: [...platforms],
				mobileBootstrap: plan.install.mark,
				acceptanceCriteria: [
					t("mobile:setup.criteria.builds", {
						platforms: platforms.map((p) => platformLabel(t, p)).join(", "),
					}),
					t("mobile:setup.criteria.untouched"),
					t("mobile:setup.criteria.readme"),
				],
			},
		);
		if (!task) throw new Error(t("mobile:setup.createFailed"));
		installId = task.id;
	}

	const blockers: string[] = [];
	for (const step of plan.platforms) {
		const platform = step.mark.platform as MobilePlatform;
		if (step.existing) {
			blockers.push(step.existing.id);
			continue;
		}
		const task = await create(
			projectId,
			step.title,
			platformDescription(plan, profile, platform, t),
			{
				...base,
				mobileTargets: [platform],
				mobileBootstrap: step.mark,
				blockedBy: [installId],
				acceptanceCriteria: [
					t("mobile:setup.criteria.platformBuilds", {
						platform: platformLabel(t, platform),
					}),
					t("mobile:setup.criteria.screenshot"),
				],
			},
		);
		if (!task) throw new Error(t("mobile:setup.createFailed"));
		blockers.push(task.id);
	}
	return blockers;
}

/** The fields of a task's metadata its setup tasks run with. */
export function inheritedSetupMetadata(metadata: TaskMetadata): TaskMetadata {
	const keep: (keyof TaskMetadata)[] = [
		"provider",
		"model",
		"thinkingLevel",
		"isAutoProfile",
		"phaseModels",
		"phaseThinking",
		"phaseProviders",
		"engineLocked",
		"baseBranch",
		"useWorktree",
		"useLocalBranch",
		"requireReviewBeforeCoding",
	];
	const out: Record<string, unknown> = {};
	for (const key of keep) {
		if (metadata[key] !== undefined) out[key] = metadata[key];
	}
	return out as TaskMetadata;
}
