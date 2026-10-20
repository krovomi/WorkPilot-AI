/**
 * The brain's card in the task panel.
 *
 * It renders nothing when there is nothing (no brain, a task never built), and
 * when there is something it shows it, lets a person decide on what agents
 * proposed, and opens a note in Obsidian by its own path.
 */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task } from "../../../shared/types";

const mockFetchTask = vi.fn();
const mockSetStatus = vi.fn();

vi.mock("../../lib/agent-tools-api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/agent-tools-api")>()),
	fetchBrainTask: (...args: unknown[]) => mockFetchTask(...args),
	setBrainInstructionStatus: (...args: unknown[]) => mockSetStatus(...args),
}));

import { useBrainStore } from "../../stores/brain-store";
import { BrainTaskCard } from "./BrainTaskCard";

const task = { id: "t1", specId: "001-auth" } as unknown as Task;

const note = (title: string, extra: Record<string, unknown> = {}) => ({
	path: `knowledge/${title}.md`,
	absPath: `/home/me/brain/knowledge/${title}.md`,
	title,
	kind: "knowledge",
	status: null,
	agents: ["coder"],
	updated: "2026-09-23T10:00:00+00:00",
	...extra,
});

function learning(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		data: {
			learning: {
				active: true,
				task: "shop/001-auth",
				build: {
					...note("Auth JWT"),
					path: "knowledge/projects/shop/builds/001-auth.md",
					status: "merged",
					qa: true,
					tests: null,
					merged: "2026-09-23",
				},
				notes: [note("Rotation des clés")],
				proposals: [
					note("Toujours signer en RS256", {
						path: "instructions/rs256.md",
						kind: "instruction",
						status: "proposed",
					}),
				],
				...overrides,
			},
		},
	};
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	mockFetchTask.mockReset();
	mockSetStatus.mockReset();
	useBrainStore.setState({ byTask: {}, error: null });
	Object.assign(window.electronAPI, { openExternal: vi.fn().mockResolvedValue(undefined) });
});
afterEach(cleanup);

it("renders nothing without a brain", async () => {
	mockFetchTask.mockResolvedValue({
		ok: true,
		data: { learning: { active: false, task: "shop/001-auth", build: null, notes: [], proposals: [] } },
	});
	const { container } = render(<BrainTaskCard task={task} projectPath="/home/me/shop" />);
	await waitFor(() => expect(mockFetchTask).toHaveBeenCalled());
	expect(container).toBeEmptyDOMElement();
});

it("renders nothing for a task the brain knows nothing about", async () => {
	mockFetchTask.mockResolvedValue(learning({ build: null, notes: [], proposals: [] }));
	const { container } = render(<BrainTaskCard task={task} projectPath="/home/me/shop" />);
	await waitFor(() => expect(mockFetchTask).toHaveBeenCalled());
	expect(container).toBeEmptyDOMElement();
});

it("shows the verdicts, what was learned, and opens a note in Obsidian", async () => {
	mockFetchTask.mockResolvedValue(learning());
	render(<BrainTaskCard task={task} projectPath="/home/me/shop" />);

	expect(await screen.findByText("Shared brain")).toBeInTheDocument();
	expect(screen.getByText("accepted")).toBeInTheDocument();
	expect(screen.getByText(/QA: approved/)).toBeInTheDocument();
	expect(screen.getByText(/Tests: not measured/)).toBeInTheDocument();
	expect(mockFetchTask).toHaveBeenCalledWith("/home/me/shop", "001-auth", expect.anything());

	fireEvent.click(screen.getByRole("button", { name: "Details" }));
	expect(screen.getByText("Rotation des clés")).toBeInTheDocument();

	const openButtons = screen.getAllByRole("button", { name: /Open in Obsidian/ });
	fireEvent.click(openButtons[openButtons.length - 1]);
	expect(window.electronAPI.openExternal).toHaveBeenCalledWith(
		`obsidian://open?path=${encodeURIComponent("/home/me/brain/knowledge/Rotation des clés.md")}`,
	);
});

it("lets a person activate a rule an agent proposed", async () => {
	mockFetchTask.mockResolvedValue(learning());
	mockSetStatus.mockResolvedValue({ ok: true, data: { path: "instructions/rs256.md", status: "active" } });
	render(<BrainTaskCard task={task} projectPath="/home/me/shop" />);

	fireEvent.click(await screen.findByRole("button", { name: "Details" }));
	expect(screen.getByText("Toujours signer en RS256")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: /Activate/ }));

	await waitFor(() =>
		expect(mockSetStatus).toHaveBeenCalledWith("instructions/rs256.md", "active"),
	);
	await waitFor(() => expect(mockFetchTask).toHaveBeenCalledTimes(2));
});
