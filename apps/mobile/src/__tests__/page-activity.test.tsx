import { act, render } from "@testing-library/react-native";
import { AppState } from "react-native";
import type { ServerClient } from "../api/client";
import { api } from "../api/endpoints";
import { PageActivity } from "../usage/page-activity";
import { FLUSH_INTERVAL_MS, PageActivityBridge } from "../usage/PageActivityBridge";
import { MOBILE_PAGES, pageOf } from "../usage/pages";

const mockSegments: { current: string[] } = { current: [] };
const mockSession: { api: object | null; user: { id: string } | null; permissions: { org_id: string | null } | null } = {
	api: null,
	user: null,
	permissions: null,
};
jest.mock("expo-router", () => ({ useSegments: () => mockSegments.current }));
jest.mock("../auth/session", () => ({ useSession: () => mockSession }));

// The app's own screens, read from disk (this project has no Node types).
declare const __dirname: string;
const { readdirSync, statSync } = jest.requireActual<{
	readdirSync(path: string): string[];
	statSync(path: string): { isDirectory(): boolean };
}>("fs");
const { join, relative } = jest.requireActual<{
	join(...parts: string[]): string;
	relative(from: string, to: string): string;
}>("path");

const DAY = new Date("2026-11-27T10:00:00Z");

function server(enabled = true) {
	return {
		pageActivity: jest.fn(async () => ({ enabled })),
		sendPageActivity: jest.fn(async (visits: { count: number }[]) => ({
			enabled,
			recorded: visits.reduce((sum, v) => sum + v.count, 0),
		})),
	};
}

/** Every screen of `src/app/(app)`, as expo-router's segments name it. */
function screens(): string[][] {
	const root = join(__dirname, "..", "app", "(app)");
	const found: string[][] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (name.endsWith(".tsx") && name !== "_layout.tsx") {
				const parts = relative(root, path).replace(/\.tsx$/, "").split(/[\\/]/) as string[];
				found.push(["(app)", ...parts.filter((part) => part !== "index")]);
			}
		}
	};
	walk(root);
	return found;
}

describe("pageOf", () => {
	it("names every signed-in screen from the list, and no id", () => {
		const names = screens().map((segments) => pageOf(segments));
		expect(names).not.toContain(null);
		expect(new Set(names)).toEqual(new Set(MOBILE_PAGES));
	});

	it("names the screen of a card, a project and a list's item", () => {
		expect(pageOf(["(app)", "projects", "[projectId]", "cards", "[cardId]"])).toBe("projects/cards/detail");
		expect(pageOf(["(app)", "projects", "[projectId]", "(tabs)"])).toBe("projects");
		expect(pageOf(["(app)", "projects", "[projectId]", "(tabs)", "index"])).toBe("projects");
		expect(pageOf(["(app)"])).toBe("home");
		expect(pageOf(["sign-in"])).toBeNull();
		expect(pageOf(["(app)", "[x]"])).toBe("home");
	});
});

describe("PageActivity", () => {
	it("counts per day and screen once the organization turned it on, and sends one batch", async () => {
		const to = server();
		const activity = new PageActivity(to, "u1@o1");
		expect(await activity.note("projects", DAY)).toBe(true);
		expect(await activity.note("projects", DAY)).toBe(true);
		expect(await activity.note("settings", DAY)).toBe(true);
		expect(to.pageActivity).toHaveBeenCalledTimes(1);
		expect(await activity.flush()).toBe(3);
		expect(to.sendPageActivity).toHaveBeenCalledWith([
			{ day: "2026-11-27", page: "projects", count: 2 },
			{ day: "2026-11-27", page: "settings", count: 1 },
		]);
		// Nothing left: the next send only asks again.
		expect(await activity.flush()).toBe(0);
		expect(to.pageActivity).toHaveBeenCalledTimes(2);
	});

	it("counts nothing while it is off or the server cannot say", async () => {
		const off = new PageActivity(server(false), "u1@o1");
		expect(await off.note("projects", DAY)).toBe(false);
		const down = server();
		down.pageActivity.mockRejectedValueOnce(new Error("offline"));
		expect(await new PageActivity(down, "u1@o1").note("projects", DAY)).toBe(false);
	});

	it("keeps what could not be sent and what was counted while sending, one batch at a time", async () => {
		const to = server();
		const activity = new PageActivity(to, "u1@o1");
		await activity.note("projects", DAY);
		to.sendPageActivity.mockRejectedValueOnce(new Error("offline"));
		expect(await activity.flush()).toBe(0);
		let reply: (value: { enabled: boolean; recorded: number }) => void = () => undefined;
		to.sendPageActivity.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
		const sending = activity.flush();
		expect(await activity.flush()).toBe(0);
		await activity.note("projects", DAY);
		reply({ enabled: true, recorded: 1 });
		expect(await sending).toBe(1);
		await activity.flush();
		expect(to.sendPageActivity).toHaveBeenLastCalledWith([{ day: "2026-11-27", page: "projects", count: 1 }]);
	});

	it("stops when the server says it was turned off, and drops counts erased meanwhile", async () => {
		const to = server();
		const activity = new PageActivity(to, "u1@o1");
		await activity.note("projects", DAY);
		await activity.note("settings", DAY);
		to.sendPageActivity.mockResolvedValueOnce({ enabled: false, recorded: 0 });
		await activity.flush();
		expect(await activity.note("projects", DAY)).toBe(false);

		const again = new PageActivity(to, "u1@o1");
		await again.note("projects", DAY);
		let reply: (value: { enabled: boolean; recorded: number }) => void = () => undefined;
		to.sendPageActivity.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
		const sending = again.flush();
		to.pageActivity.mockResolvedValueOnce({ enabled: false });
		// Off with nothing new: the counts are erased while the batch travels.
		(again as unknown as { counts: Map<string, number> }).counts.clear();
		reply({ enabled: true, recorded: 1 });
		await sending;
		expect(await again.note("projects", DAY)).toBe(true);
	});

	it("keeps at most a batch of distinct screens", async () => {
		const to = server();
		const activity = new PageActivity(to, "u1@o1");
		for (let day = 0; day < 8; day++) {
			for (const page of MOBILE_PAGES) await activity.note(page, new Date(DAY.getTime() + day * 86_400_000));
		}
		await activity.flush();
		expect(to.sendPageActivity.mock.calls[0]?.[0]).toHaveLength(200);
	});
});

describe("PageActivityBridge", () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	it("counts each screen opened, sends every few minutes and in the background", async () => {
		const listen = jest.spyOn(AppState, "addEventListener");
		const to = server();
		Object.assign(mockSession, { api: to, user: { id: "u1" }, permissions: { org_id: "o1" } });
		mockSegments.current = ["(app)"];
		const view = await render(<PageActivityBridge />);
		mockSegments.current = ["(app)", "settings"];
		await view.rerender(<PageActivityBridge />);
		mockSegments.current = ["sign-in"];
		await view.rerender(<PageActivityBridge />);
		await act(async () => {
			await jest.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
		});
		const sent = to.sendPageActivity.mock.calls[0]?.[0] as unknown as { page: string }[];
		expect(sent.map((v) => v.page)).toEqual(["home", "settings"]);

		mockSegments.current = ["(app)", "tokens"];
		await view.rerender(<PageActivityBridge />);
		const change = listen.mock.calls.at(-1)?.[1] as (state: string) => void;
		await act(async () => {
			change("active");
			change("background");
		});
		expect(to.sendPageActivity).toHaveBeenCalledTimes(2);
		view.unmount();
	});

	it("does nothing signed out, nor for a person in no organization yet", async () => {
		Object.assign(mockSession, { api: null, user: null, permissions: null });
		mockSegments.current = ["(app)"];
		const view = await render(<PageActivityBridge />);
		view.unmount();
		const to = server(false);
		Object.assign(mockSession, { api: to, user: { id: "u1" }, permissions: null });
		const again = await render(<PageActivityBridge />);
		expect(to.pageActivity).toHaveBeenCalledTimes(1);
		again.unmount();
	});
});

describe("page activity routes", () => {
	it("asks and sends as the phone", async () => {
		const request = jest.fn(async () => ({}));
		const routes = api({ request } as unknown as ServerClient);
		await routes.pageActivity();
		await routes.sendPageActivity([{ day: "2026-11-27", page: "home", count: 1 }]);
		expect(request.mock.calls).toEqual([
			["GET", "/users/me/page-activity"],
			["POST", "/users/me/page-activity", { client: "mobile", visits: [{ day: "2026-11-27", page: "home", count: 1 }] }],
		]);
	});
});
