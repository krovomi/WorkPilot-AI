/**
 * Setting up a phone app from the task form, for a project that has none:
 * which framework, which tasks, and what the task waits for.
 */
import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskMetadata } from "../../shared/types";
import type { MobileProfile, MobileSetupFramework } from "../../shared/types/mobile";
import {
	createMobileSetup,
	frameworksFor,
	inheritedSetupMetadata,
	installDescription,
	needsMobileSetup,
	planMobileSetup,
	resolveFramework,
} from "./mobile-setup";

const t = ((key: string, values?: Record<string, unknown>) =>
	values ? `${key} ${JSON.stringify(values)}` : key) as unknown as TFunction;

function framework(id: string, platforms: ("android" | "ios")[]): MobileSetupFramework {
	return {
		id,
		label: id.toUpperCase(),
		platforms,
		install: [`install ${id}`],
		scaffold: [`create ${id} --platforms={platforms}`],
		platformSetup: Object.fromEntries(platforms.map((p) => [p, [`setup ${p}`]])),
		docs: `https://docs/${id}`,
		notes: "",
	};
}

const API: MobileProfile = {
	success: true,
	isMobile: false,
	hostStacks: ["dotnet"],
	mobileDir: "mobile",
	appName: "ShopMobile",
	frameworks: [
		framework("dotnet-maui", ["android", "ios"]),
		framework("flutter", ["android", "ios"]),
		framework("android-native", ["android"]),
		framework("ios-native", ["ios"]),
	],
};

function task(id: string, metadata: Partial<TaskMetadata>, status = "backlog"): Task {
	return { id, projectId: "p1", status, metadata } as unknown as Task;
}

describe("needsMobileSetup", () => {
	it("is needed only for a project without an app and a platform checked", () => {
		expect(needsMobileSetup(API, ["android"])).toBe(true);
		expect(needsMobileSetup(API, [])).toBe(false);
		expect(needsMobileSetup({ success: true, isMobile: true }, ["android"])).toBe(false);
		expect(needsMobileSetup(null, ["android"])).toBe(false);
		expect(needsMobileSetup(undefined, ["ios"])).toBe(false);
	});
});

describe("frameworksFor", () => {
	it("keeps the frameworks that build every checked platform, in order", () => {
		expect(frameworksFor(API, ["android", "ios"]).map((f) => f.id)).toEqual([
			"dotnet-maui",
			"flutter",
		]);
		expect(frameworksFor(API, ["ios"]).map((f) => f.id)).toEqual([
			"dotnet-maui",
			"flutter",
			"ios-native",
		]);
	});
});

describe("resolveFramework", () => {
	it("proposes the best fit, then follows the person's choice", () => {
		expect(resolveFramework(API, ["android"], null, []).framework?.id).toBe("dotnet-maui");
		expect(resolveFramework(API, ["android"], "flutter", []).framework?.id).toBe("flutter");
		// A choice that cannot build the platforms falls back to the best fit.
		expect(resolveFramework(API, ["ios"], "android-native", []).framework?.id).toBe(
			"dotnet-maui",
		);
	});

	it("joins a setup already open on the board", () => {
		const open = task("t-install", {
			mobileBootstrap: { framework: "flutter", step: "install" },
		});
		const result = resolveFramework(API, ["android"], "dotnet-maui", [open]);
		expect(result).toMatchObject({ locked: true });
		expect(result.framework?.id).toBe("flutter");
	});

	it("ignores a finished or archived setup", () => {
		const done = task("a", { mobileBootstrap: { framework: "flutter", step: "install" } }, "done");
		const archived = task("b", {
			mobileBootstrap: { framework: "flutter", step: "install" },
			archivedAt: "2026-11-01",
		});
		expect(resolveFramework(API, ["android"], null, [done, archived])).toMatchObject({
			locked: false,
		});
	});
});

describe("planMobileSetup and createMobileSetup", () => {
	it("creates install, then one task per platform, and returns what to wait for", async () => {
		const maui = API.frameworks?.[0] as MobileSetupFramework;
		const plan = planMobileSetup(maui, ["ios", "android"], [], t);
		expect(plan.platforms.map((s) => s.mark.platform)).toEqual(["android", "ios"]);

		const created: { title: string; metadata?: TaskMetadata }[] = [];
		const create = vi.fn(async (_p: string, title: string, _d: string, metadata?: TaskMetadata) => {
			created.push({ title, metadata });
			return { id: `t${created.length}` } as Task;
		});
		const blockers = await createMobileSetup(
			plan,
			API,
			"p1",
			{ provider: "claude", baseBranch: "develop" },
			create,
			t,
		);

		expect(create).toHaveBeenCalledTimes(3);
		expect(created[0].metadata).toMatchObject({
			mobileBootstrap: { framework: "dotnet-maui", step: "install" },
			mobileTargets: ["android", "ios"],
			category: "infrastructure",
			provider: "claude",
			baseBranch: "develop",
		});
		expect(created[1].metadata).toMatchObject({
			mobileBootstrap: { step: "platform", platform: "android" },
			mobileTargets: ["android"],
			blockedBy: ["t1"],
		});
		expect(created[2].metadata?.blockedBy).toEqual(["t1"]);
		expect(blockers).toEqual(["t2", "t3"]);
	});

	it("reuses the setup tasks still open, and adds only the missing platform", async () => {
		const flutter = API.frameworks?.[1] as MobileSetupFramework;
		const board = [
			task("install-1", { mobileBootstrap: { framework: "flutter", step: "install" } }),
			task("android-1", {
				mobileBootstrap: { framework: "flutter", step: "platform", platform: "android" },
			}),
		];
		const plan = planMobileSetup(flutter, ["android", "ios"], board, t);
		const create = vi.fn(async () => ({ id: "ios-1" }) as Task);

		const blockers = await createMobileSetup(plan, API, "p1", {}, create, t);

		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0][3]).toMatchObject({ blockedBy: ["install-1"] });
		expect(blockers).toEqual(["android-1", "ios-1"]);
	});

	it("stops at the first task that cannot be created", async () => {
		const maui = API.frameworks?.[0] as MobileSetupFramework;
		const plan = planMobileSetup(maui, ["android"], [], t);
		const create = vi.fn(async () => null);
		await expect(createMobileSetup(plan, API, "p1", {}, create, t)).rejects.toThrow(
			"mobile:setup.createFailed",
		);
		expect(create).toHaveBeenCalledTimes(1);
	});
});

describe("descriptions", () => {
	it("give the agent the toolchain, the scaffold for the platforms and the docs", () => {
		const maui = API.frameworks?.[0] as MobileSetupFramework;
		const plan = planMobileSetup(maui, ["android"], [], t);
		const text = installDescription(plan, API, ["android"], t);
		expect(text).toContain("- install dotnet-maui");
		expect(text).toContain("- create dotnet-maui --platforms=android");
		expect(text).toContain("https://docs/dotnet-maui");
	});
});

describe("inheritedSetupMetadata", () => {
	it("keeps the engine and the branch, not the task's own fields", () => {
		const kept = inheritedSetupMetadata({
			provider: "codex",
			model: "gpt-5.5",
			baseBranch: "develop",
			useWorktree: false,
			category: "bug_fix",
			mobileTargets: ["ios"],
			acceptanceCriteria: ["x"],
		} as TaskMetadata);
		expect(kept).toEqual({
			provider: "codex",
			model: "gpt-5.5",
			baseBranch: "develop",
			useWorktree: false,
		});
	});
});
