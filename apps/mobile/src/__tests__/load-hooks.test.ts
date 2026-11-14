import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { BoardCard, CardDetails } from "../api/types";
import { useCard } from "../board/useCard";
import { JOB_POLL_MS, useFeature } from "../features/useFeature";
import { forgeKind, useForge, useProject } from "../forge/useForge";
import { useLoad } from "../hooks/useLoad";

const mockApi = {
	cards: jest.fn(),
	card: jest.fn(),
	runs: jest.fn(),
	changes: jest.fn(),
	logs: jest.fn(),
	project: jest.fn(),
	featureSnapshot: jest.fn(),
	featureJob: jest.fn(),
	startFeatureJob: jest.fn(),
	cancelFeatureJob: jest.fn(),
};
const mockClient = { request: jest.fn() };
jest.mock("../auth/session", () => ({
	useApi: () => mockApi,
	useSession: () => ({ api: mockApi, client: mockClient }),
}));

function card(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "001-login",
		title: "Login",
		column: "backlog",
		kind: null,
		updatedAt: null,
		subtasks: { completed: 0, total: 0 },
		specId: "spec-1",
		claimedBy: null,
		claimedByName: null,
		...overrides,
	};
}

const details = { id: "001-login", title: "Login", description: "Do it" } as unknown as CardDetails;

beforeEach(() => {
	for (const fn of Object.values(mockApi)) fn.mockReset();
	mockClient.request.mockReset();
});

describe("useLoad", () => {
	it("loads once, then keeps the data and records the error of a failed reload", async () => {
		const load = jest.fn().mockResolvedValueOnce("first").mockRejectedValueOnce(new Error("offline"));
		const { result } = await renderHook(() => useLoad(load));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.data).toBe("first");
		expect(result.current.error).toBeNull();

		await act(async () => {
			await result.current.reload();
		});
		expect(result.current.data).toBe("first");
		expect((result.current.error as Error).message).toBe("offline");
		expect(result.current.refreshing).toBe(false);
	});

	it("clears the error once a background refresh succeeds", async () => {
		const load = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(42);
		const { result } = await renderHook(() => useLoad(load));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.data).toBeNull();
		expect(result.current.error).toBeInstanceOf(Error);

		await act(async () => {
			await result.current.refresh();
		});
		expect(result.current.data).toBe(42);
		expect(result.current.error).toBeNull();
	});

	it("does not touch the state of a screen that already left", async () => {
		let resolve: (value: string) => void = () => {};
		const load = jest.fn(() => new Promise<string>((r) => (resolve = r)));
		const { result, unmount } = await renderHook(() => useLoad(load));
		expect(result.current.loading).toBe(true);
		await unmount();
		await act(async () => resolve("late"));
		expect(result.current.loading).toBe(true);
	});
});

describe("useCard", () => {
	it("reads the card, its runs, changes and log", async () => {
		mockApi.cards.mockResolvedValue([card({ id: "other" }), card()]);
		mockApi.card.mockResolvedValue(details);
		mockApi.runs.mockResolvedValue([{ id: "run-1" }]);
		mockApi.changes.mockResolvedValue({ files: [] });
		mockApi.logs.mockResolvedValue({ phases: {} });
		const { result } = await renderHook(() => useCard("p1", "001-login"));
		await waitFor(() => expect(result.current.data).not.toBeNull());
		expect(result.current.data).toEqual({
			card: card(),
			details,
			runs: [{ id: "run-1" }],
			changes: { files: [] },
			logs: { phases: {} },
		});
		expect(mockApi.runs).toHaveBeenCalledWith("p1", "spec-1");
		expect(mockApi.card).toHaveBeenCalledWith("p1", "001-login");
	});

	it("still shows a card whose diff and log cannot be read, and asks no runs without a spec", async () => {
		mockApi.cards.mockResolvedValue([card({ specId: null })]);
		mockApi.card.mockResolvedValue(details);
		mockApi.changes.mockRejectedValue(new Error("no worktree"));
		mockApi.logs.mockRejectedValue(new Error("no log"));
		const { result } = await renderHook(() => useCard("p1", "001-login"));
		await waitFor(() => expect(result.current.data).not.toBeNull());
		expect(result.current.data?.runs).toEqual([]);
		expect(result.current.data?.changes).toBeNull();
		expect(result.current.data?.logs).toBeNull();
		expect(mockApi.runs).not.toHaveBeenCalled();
	});

	it("fails when the board no longer lists the card", async () => {
		mockApi.cards.mockResolvedValue([card({ id: "other" })]);
		mockApi.card.mockResolvedValue(details);
		const { result } = await renderHook(() => useCard("p1", "001-login"));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect((result.current.error as Error).message).toBe("card_not_indexed");
		expect(result.current.data).toBeNull();
	});
});

describe("useForge", () => {
	it("knows only GitHub and GitLab", () => {
		expect(forgeKind("github")).toBe("github");
		expect(forgeKind("gitlab")).toBe("gitlab");
		expect(forgeKind("azure")).toBeNull();
		expect(forgeKind(null)).toBeNull();
		expect(forgeKind(undefined)).toBeNull();
	});

	it("reads the project record", async () => {
		mockApi.project.mockResolvedValue({ id: "p1", forge: "github", repo_url: "https://github.com/o/r" });
		const { result } = await renderHook(() => useProject("p1"));
		await waitFor(() => expect(result.current.data).not.toBeNull());
		expect(mockApi.project).toHaveBeenCalledWith("p1");
	});

	it("builds the adapter of a GitHub project", async () => {
		mockApi.project.mockResolvedValue({ id: "p1", forge: "github", repo_url: "https://github.com/o/r" });
		const { result } = await renderHook(() => useForge("p1"));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.forge).not.toBeNull();
		expect(result.current.error).toBeNull();
	});

	it("offers no adapter for a project without a known forge", async () => {
		mockApi.project.mockResolvedValue({ id: "p1", forge: null, repo_url: "https://example.com/r" });
		const { result } = await renderHook(() => useForge("p1"));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.forge).toBeNull();
	});

	it("reports a project that cannot be read", async () => {
		mockApi.project.mockRejectedValue(new Error("403"));
		const { result } = await renderHook(() => useForge("p1"));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.forge).toBeNull();
		expect((result.current.error as Error).message).toBe("403");
	});
});

describe("useFeature", () => {
	const job = (status: string, id = "job-1") => ({
		id,
		feature: "roadmap",
		status,
		started_by: "alice",
		started_at: null,
		finished_at: null,
		error: null,
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("follows a running job's last line and reads the snapshot again when it ends", async () => {
		jest.useFakeTimers();
		mockApi.featureSnapshot
			.mockResolvedValueOnce({ files: {}, job: job("running") })
			.mockResolvedValueOnce({ files: { "roadmap.json": { content: "{}", sha256: "x" } }, job: job("succeeded") });
		mockApi.featureJob
			.mockResolvedValueOnce({ ...job("running"), lines: ["Reading", "  ", ""], next: 2 })
			.mockResolvedValueOnce({ ...job("succeeded"), lines: ["x".repeat(400)], next: 3 });
		const { result } = await renderHook(() => useFeature("roadmap", "p1"));
		await waitFor(() => expect(result.current.active).toBe(true));
		expect(result.current.lastLine).toBeNull();

		await act(async () => {
			jest.advanceTimersByTime(JOB_POLL_MS);
		});
		await waitFor(() => expect(result.current.lastLine).toBe("Reading"));
		expect(mockApi.featureJob).toHaveBeenLastCalledWith("roadmap", "p1", "job-1", 0);

		await act(async () => {
			jest.advanceTimersByTime(JOB_POLL_MS);
		});
		await waitFor(() => expect(result.current.active).toBe(false));
		expect(mockApi.featureJob).toHaveBeenLastCalledWith("roadmap", "p1", "job-1", 2);
		// A line is cut to 300 characters.
		expect(result.current.lastLine).toHaveLength(300);
		await waitFor(() => expect(mockApi.featureSnapshot).toHaveBeenCalledTimes(2));
		expect(result.current.data?.files["roadmap.json"]).toBeDefined();
	});

	it("keeps what it shows when a poll fails", async () => {
		jest.useFakeTimers();
		mockApi.featureSnapshot.mockResolvedValue({ files: {}, job: job("queued") });
		mockApi.featureJob.mockRejectedValue(new Error("timeout"));
		const { result } = await renderHook(() => useFeature("ideation", "p1"));
		await waitFor(() => expect(result.current.active).toBe(true));
		await act(async () => {
			jest.advanceTimersByTime(JOB_POLL_MS);
		});
		expect(mockApi.featureJob).toHaveBeenCalled();
		expect(result.current.job?.status).toBe("queued");
		expect(result.current.active).toBe(true);
	});

	it("starts a job from the first line and cancels it", async () => {
		mockApi.featureSnapshot.mockResolvedValue({ files: {}, job: job("succeeded", "old") });
		mockApi.startFeatureJob.mockResolvedValue(job("queued", "job-2"));
		mockApi.cancelFeatureJob.mockResolvedValue(undefined);
		const { result } = await renderHook(() => useFeature("roadmap", "p1"));
		await waitFor(() => expect(result.current.job?.id).toBe("old"));
		expect(result.current.active).toBe(false);

		await act(async () => {
			await result.current.start({ depth: 2 });
		});
		expect(mockApi.startFeatureJob).toHaveBeenCalledWith("roadmap", "p1", { depth: 2 });
		expect(result.current.job?.id).toBe("job-2");
		expect(result.current.active).toBe(true);

		await act(async () => {
			await result.current.cancel();
		});
		expect(mockApi.cancelFeatureJob).toHaveBeenCalledWith("roadmap", "p1", "job-2");
	});

	it("starts with no options and has nothing to cancel without a job", async () => {
		mockApi.featureSnapshot.mockResolvedValue({ files: {}, job: null });
		mockApi.startFeatureJob.mockResolvedValue(job("queued"));
		const { result } = await renderHook(() => useFeature("context", "p1"));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.job).toBeNull();
		await act(async () => {
			await result.current.cancel();
		});
		expect(mockApi.cancelFeatureJob).not.toHaveBeenCalled();
		await act(async () => {
			await result.current.start();
		});
		expect(mockApi.startFeatureJob).toHaveBeenCalledWith("context", "p1", {});
	});

	it("keeps the job it follows when the snapshot names the same job", async () => {
		mockApi.featureSnapshot.mockResolvedValue({ files: {}, job: job("succeeded") });
		mockApi.startFeatureJob.mockResolvedValue(job("running"));
		const { result } = await renderHook(() => useFeature("roadmap", "p1"));
		await waitFor(() => expect(result.current.job?.status).toBe("succeeded"));
		await act(async () => {
			await result.current.start();
		});
		// The started job has the same id: a later snapshot read does not replace it.
		await act(async () => {
			await result.current.refresh();
		});
		expect(result.current.job?.status).toBe("running");
	});
});
