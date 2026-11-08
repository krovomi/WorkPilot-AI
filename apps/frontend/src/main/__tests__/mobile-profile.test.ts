/**
 * The task form's mobile profile: read on this computer by the mobile runner,
 * on the server for a server project; a project is named by id, never a path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
	profile: vi.fn(),
	getProject: vi.fn(),
	getServerProject: vi.fn(),
	authedFetch: vi.fn(),
}));

vi.mock("../mobile-service", () => ({ mobileService: { profile: deps.profile } }));
vi.mock("../project-store", () => ({ projectStore: { getProject: deps.getProject } }));
vi.mock("../server-projects", () => ({ getServerProject: deps.getServerProject }));
vi.mock("../server-connection", () => ({ authedFetch: deps.authedFetch }));

import { getMobileProfile } from "../mobile-profile";
import { settingsFromMetadata } from "../server-card-settings";

beforeEach(() => {
	for (const fn of Object.values(deps)) fn.mockReset();
});

describe("getMobileProfile", () => {
	it("refuses anything but a project id", async () => {
		for (const bad of [undefined, 42, "", "../etc", "/home/me/project"]) {
			const result = await getMobileProfile(bad);
			expect(result).toMatchObject({ success: false, isMobile: false });
		}
		expect(deps.profile).not.toHaveBeenCalled();
		expect(deps.authedFetch).not.toHaveBeenCalled();
	});

	it("asks the mobile runner for a project of this computer", async () => {
		deps.getServerProject.mockReturnValue(undefined);
		deps.getProject.mockReturnValue({ id: "p1", path: "/repos/api" });
		deps.profile.mockResolvedValue({ success: true, isMobile: false, frameworks: [] });

		const result = await getMobileProfile("p1");

		expect(deps.profile).toHaveBeenCalledWith("/repos/api");
		expect(result).toMatchObject({ success: true, isMobile: false });
	});

	it("asks the server for a server project", async () => {
		deps.getServerProject.mockReturnValue({ id: "srv-1" });
		deps.authedFetch.mockResolvedValue({ ok: true, data: { success: true, isMobile: true } });

		const result = await getMobileProfile("srv-1");

		expect(deps.authedFetch).toHaveBeenCalledWith(
			"/api/board/mobile-profile?project_id=srv-1",
			"GET",
		);
		expect(deps.profile).not.toHaveBeenCalled();
		expect(result.isMobile).toBe(true);
	});

	it("says so when the server cannot answer", async () => {
		deps.getServerProject.mockReturnValue({ id: "srv-1" });
		deps.authedFetch.mockResolvedValue({ ok: false, error: "Forbidden" });
		expect(await getMobileProfile("srv-1")).toEqual({
			success: false,
			isMobile: false,
			error: "Forbidden",
		});
	});

	it("does not run on an unknown project", async () => {
		deps.getServerProject.mockReturnValue(undefined);
		deps.getProject.mockReturnValue(undefined);
		expect(await getMobileProfile("nope")).toMatchObject({ success: false });
		expect(deps.profile).not.toHaveBeenCalled();
	});
});

describe("settingsFromMetadata", () => {
	it("sends a server card its phone targets, blockers and setup mark", () => {
		expect(
			settingsFromMetadata({
				mobileTargets: ["android"],
				blockedBy: ["server:p:001-install"],
				mobileBootstrap: { framework: "flutter", step: "platform", platform: "android" },
			}),
		).toEqual({
			mobileTargets: ["android"],
			blockedBy: ["server:p:001-install"],
			mobileBootstrap: { framework: "flutter", step: "platform", platform: "android" },
		});
	});

	it("clears them with null when emptied", () => {
		expect(settingsFromMetadata({ mobileTargets: [], blockedBy: [] })).toEqual({
			mobileTargets: null,
			blockedBy: null,
		});
		expect(settingsFromMetadata({ title: "x" } as never)).toBeNull();
	});
});
