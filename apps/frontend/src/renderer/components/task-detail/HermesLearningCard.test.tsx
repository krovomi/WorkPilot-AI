/**
 * The hermes card in the task panel — an inbox, not a list of paths.
 *
 * A person reported the old card as "text I cannot do anything with": thirty-
 * four file paths and no action. These tests hold what replaced it: one
 * sentence saying what to do, each candidate with its purpose and two answers,
 * a selection to answer in bulk, the cycle running without a button, and the
 * kept skill going to the shared brain with the task it was kept from.
 */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task } from "../../../shared/types";
import type { HermesCandidate, HermesStatus } from "../../lib/agent-tools-api";

const mockFetchStatus = vi.fn();
const mockRunCycle = vi.fn();
const mockReview = vi.fn();

vi.mock("../../lib/agent-tools-api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/agent-tools-api")>()),
	fetchHermesStatus: (...args: unknown[]) => mockFetchStatus(...args),
	runHermesCycle: (...args: unknown[]) => mockRunCycle(...args),
	reviewHermesCandidates: (...args: unknown[]) => mockReview(...args),
}));

import { useHermesStore } from "../../stores/hermes-store";
import { HermesLearningCard } from "./HermesLearningCard";

const task = { id: "t1", specId: "001-namespace" } as unknown as Task;

const candidate = (name: string, extra: Partial<HermesCandidate> = {}): HermesCandidate => ({
	file: `hermes--${name}.md`,
	name,
	description: `What ${name} is for.`,
	category: "",
	pendingInHermes: false,
	surface: "build",
	tools: ["terminal"],
	excerpt: `1. Run ${name} with \`terminal\`.`,
	lines: 3,
	...extra,
});

function status(overrides: Partial<HermesStatus> = {}): HermesStatus {
	const candidates = overrides.candidates ?? [
		candidate("diagnose-the-flake"),
		candidate("airtable", { category: "productivity" }),
	];
	return {
		readiness: {
			state: "ready",
			installed: true,
			ready: true,
			degraded: false,
			home: "/home/me/.hermes",
			checks: [
				{ name: "install", ok: true, detail: "on PATH", remedy: "", required: true },
				{ name: "trust", ok: true, detail: "trusted", remedy: "", required: false },
			],
		},
		soul: {
			state: "installed",
			offered: true,
			installed: true,
			matches: true,
			installedPath: "",
			repoPath: "",
		},
		pending: candidates.map((c) => c.file),
		candidates,
		stale: 0,
		adopted: [],
		adoptedPack: "hermes-learned",
		declined: 0,
		autoAdopt: true,
		brain: { active: true, root: "/home/me/brain", notes: 2, hermesConnected: false },
		surfaces: [],
		...overrides,
	};
}

function cycle() {
	return {
		ok: true,
		data: {
			cycle: {
				surface: "kanban",
				surfaceDescription: "",
				readiness: status().readiness,
				ran: true,
				proposed: 0,
				pending: [],
				stale: 0,
				ingest: null,
			},
		},
	};
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	mockFetchStatus.mockReset();
	mockRunCycle.mockReset();
	mockReview.mockReset();
	useHermesStore.getState().reset();
	mockRunCycle.mockResolvedValue(cycle());
});
afterEach(cleanup);

it("renders nothing when hermes is not installed", async () => {
	const absent = status();
	mockFetchStatus.mockResolvedValue({
		ok: true,
		data: {
			status: { ...absent, readiness: { ...absent.readiness, installed: false, state: "absent" } },
		},
	});
	const { container } = render(<HermesLearningCard task={task} />);
	await waitFor(() => expect(mockFetchStatus).toHaveBeenCalled());
	expect(container).toBeEmptyDOMElement();
	expect(mockRunCycle).not.toHaveBeenCalled();
});

it("says what to do, and shows each candidate with its purpose", async () => {
	mockFetchStatus.mockResolvedValue({ ok: true, data: { status: status() } });
	render(<HermesLearningCard task={task} />);

	expect(await screen.findByText("2 skills are waiting for your decision")).toBeInTheDocument();
	expect(screen.getByText("What diagnose-the-flake is for.")).toBeInTheDocument();
	expect(screen.getByText("productivity")).toBeInTheDocument();
	// No raw path in sight.
	expect(screen.queryByText(/skills\/_proposed\//)).not.toBeInTheDocument();
});

it("runs the loop by itself when the panel opens, once", async () => {
	mockFetchStatus.mockResolvedValue({ ok: true, data: { status: status() } });
	const { unmount } = render(<HermesLearningCard task={task} />);
	await waitFor(() => expect(mockRunCycle).toHaveBeenCalledWith("kanban"));
	unmount();

	render(<HermesLearningCard task={task} />);
	await screen.findByText("2 skills are waiting for your decision");
	// Throttled: a second panel within the interval does not run another pass.
	expect(mockRunCycle).toHaveBeenCalledTimes(1);
});

it("keeps one candidate, linked to the task, and reports it went to the brain", async () => {
	mockFetchStatus.mockResolvedValue({ ok: true, data: { status: status() } });
	mockReview.mockResolvedValue({
		ok: true,
		data: {
			review: {
				adopted: ["diagnose-the-flake"],
				declined: [],
				skipped: [],
				brainNotes: ["knowledge/hermes/diagnose-the-flake.md"],
			},
			status: status({ candidates: [candidate("airtable")] }),
		},
	});
	render(<HermesLearningCard task={task} projectPath="/home/me/app" />);

	const row = (await screen.findByText("What diagnose-the-flake is for.")).closest("li");
	if (!row) throw new Error("row not found");
	fireEvent.click(within(row).getByRole("button", { name: /Keep/ }));

	await waitFor(() =>
		expect(mockReview).toHaveBeenCalledWith(
			["hermes--diagnose-the-flake.md"],
			"adopt",
			{ projectDir: "/home/me/app", specId: "001-namespace" },
		),
	);
	expect(
		await screen.findByText("1 skill kept and filed in the shared brain."),
	).toBeInTheDocument();
	expect(screen.getByText("1 skill is waiting for your decision")).toBeInTheDocument();
});

it("turns down a selection in one go", async () => {
	mockFetchStatus.mockResolvedValue({ ok: true, data: { status: status() } });
	mockReview.mockResolvedValue({
		ok: true,
		data: {
			review: { adopted: [], declined: ["diagnose-the-flake", "airtable"], skipped: [], brainNotes: [] },
			status: status({ candidates: [] }),
		},
	});
	render(<HermesLearningCard task={task} />);

	fireEvent.click(await screen.findByRole("checkbox", { name: "Select all" }));
	expect(screen.getByText("2 selected")).toBeInTheDocument();
	const toolbar = screen.getByText("2 selected").closest("div")?.parentElement;
	if (!toolbar) throw new Error("toolbar not found");
	fireEvent.click(within(toolbar).getByRole("button", { name: /Turn down/ }));

	await waitFor(() =>
		expect(mockReview).toHaveBeenCalledWith(
			["hermes--diagnose-the-flake.md", "hermes--airtable.md"],
			"decline",
			expect.anything(),
		),
	);
	expect(await screen.findByText("Nothing to decide")).toBeInTheDocument();
});

it("previews the procedure hermes wrote, and the tools to rewrite", async () => {
	mockFetchStatus.mockResolvedValue({ ok: true, data: { status: status() } });
	render(<HermesLearningCard task={task} />);

	const [preview] = await screen.findAllByRole("button", { name: /Preview/ });
	fireEvent.click(preview);
	expect(screen.getByText("1. Run diagnose-the-flake with `terminal`.")).toBeInTheDocument();
	expect(screen.getByText("terminal")).toBeInTheDocument();
});

it("explains the brain coupling and offers to connect hermes to it", async () => {
	mockFetchStatus.mockResolvedValue({ ok: true, data: { status: status({ candidates: [] }) } });
	const listener = vi.fn();
	globalThis.addEventListener("open-app-settings", listener);
	render(<HermesLearningCard task={task} />);

	fireEvent.click(await screen.findByRole("button", { name: /How it works/ }));
	expect(screen.getByText("Brain active · 2 hermes skills filed")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Open brain settings" }));
	expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe("brain");
	globalThis.removeEventListener("open-app-settings", listener);
});
