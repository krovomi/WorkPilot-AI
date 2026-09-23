/**
 * Tests for the brain store.
 *
 * Three properties, and none of them is "it fetches":
 *
 * - a late answer about a task does not paint the card of the task now open —
 *   the modal is reopened on another card while a request is still running;
 * - "not here" (server mode) is an answer, not a red error on every panel;
 * - deciding on a proposed rule re-reads the task, so the card stops offering
 *   a decision that has been taken.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchTask = vi.fn();
const mockSetStatus = vi.fn();
const mockFetchSettings = vi.fn();
const mockSaveSettings = vi.fn();

vi.mock("../../lib/agent-tools-api", () => ({
	fetchBrainTask: (...args: unknown[]) => mockFetchTask(...args),
	setBrainInstructionStatus: (...args: unknown[]) => mockSetStatus(...args),
	fetchBrainSettings: (...args: unknown[]) => mockFetchSettings(...args),
	saveBrainSettings: (...args: unknown[]) => mockSaveSettings(...args),
	syncBrain: vi.fn(),
}));

import { useBrainStore } from "../brain-store";

function learning(title: string, proposals = 0) {
	const note = {
		path: `knowledge/${title}.md`,
		absPath: `/brain/knowledge/${title}.md`,
		title,
		kind: "knowledge",
		status: null,
		agents: ["coder"],
		updated: null,
	};
	return {
		ok: true as const,
		data: {
			learning: {
				active: true,
				task: "shop/001",
				build: null,
				notes: [note],
				proposals: Array.from({ length: proposals }, () => ({
					...note,
					kind: "instruction",
					status: "proposed",
				})),
			},
		},
	};
}

describe("brain store", () => {
	beforeEach(() => {
		mockFetchTask.mockReset();
		mockSetStatus.mockReset();
		mockFetchSettings.mockReset();
		mockSaveSettings.mockReset();
		useBrainStore.setState({
			settings: null,
			unavailable: false,
			error: null,
			byTask: {},
		});
	});

	it("drops an answer that a newer request replaced", async () => {
		let releaseFirst: ((value: unknown) => void) | undefined;
		mockFetchTask
			.mockImplementationOnce(
				() => new Promise((resolve) => (releaseFirst = resolve)),
			)
			.mockResolvedValueOnce(learning("second"));

		const args = { taskId: "t1", projectDir: "/p/shop", specId: "001" };
		const first = useBrainStore.getState().loadTask(args);
		await useBrainStore.getState().loadTask(args);
		releaseFirst?.(learning("first"));
		await first;

		const entry = useBrainStore.getState().byTask.t1;
		expect(entry.learning?.notes[0].title).toBe("second");
	});

	it("does not ask without a project and a spec", async () => {
		await useBrainStore.getState().loadTask({ taskId: "t1" });
		expect(mockFetchTask).not.toHaveBeenCalled();
	});

	it("treats server mode as an answer, not an error", async () => {
		mockFetchSettings.mockResolvedValue({
			ok: false,
			error: "the shared brain is a desktop feature",
		});
		await useBrainStore.getState().loadSettings(true);
		const state = useBrainStore.getState();
		expect(state.unavailable).toBe(true);
		expect(state.error).toBeNull();
	});

	it("re-reads the task after a decision on a proposed rule", async () => {
		mockFetchTask
			.mockResolvedValueOnce(learning("x", 1))
			.mockResolvedValueOnce(learning("x", 0));
		mockSetStatus.mockResolvedValue({
			ok: true,
			data: { path: "instructions/r.md", status: "active" },
		});
		const args = { taskId: "t1", projectDir: "/p/shop", specId: "001" };
		await useBrainStore.getState().loadTask(args);
		expect(useBrainStore.getState().byTask.t1.learning?.proposals).toHaveLength(1);

		await useBrainStore
			.getState()
			.setInstructionStatus(args, "instructions/r.md", "active");

		expect(mockSetStatus).toHaveBeenCalledWith("instructions/r.md", "active");
		expect(useBrainStore.getState().byTask.t1.learning?.proposals).toHaveLength(0);
	});

	it("keeps the refusal and shows where the brain still is", async () => {
		mockSaveSettings.mockResolvedValue({
			ok: false,
			error: "the brain folder must be inside your home directory",
		});
		mockFetchSettings.mockResolvedValue({
			ok: true,
			data: { settings: { path: "/home/me/.workpilot/brain" } },
		});
		const ok = await useBrainStore.getState().saveSettings({ path: "/etc" });
		expect(ok).toBe(false);
		expect(useBrainStore.getState().error).toMatch(/home directory/);
		expect(useBrainStore.getState().settings?.path).toBe("/home/me/.workpilot/brain");
	});
});
