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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task } from "../../../shared/types";
import type { HermesCandidate, HermesStatus } from "../../lib/agent-tools-api";

const mockFetchStatus = vi.fn();
const mockRunCycle = vi.fn();
const mockReview = vi.fn();
const mockInstallSoul = vi.fn();

vi.mock("../../lib/agent-tools-api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/agent-tools-api")>()),
	fetchHermesStatus: (...args: unknown[]) => mockFetchStatus(...args),
	runHermesCycle: (...args: unknown[]) => mockRunCycle(...args),
	reviewHermesCandidates: (...args: unknown[]) => mockReview(...args),
	installHermesSoul: (...args: unknown[]) => mockInstallSoul(...args),
}));

import { useHermesStore } from "../../stores/hermes-store";
import { HermesLearningCard, SoulInstallNote } from "./HermesLearningCard";

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

/** A pass of the loop; an older backend sends no status, so the card keeps this readiness. */
function cycle(
	readiness: HermesStatus["readiness"] = status().readiness,
	extra: Record<string, unknown> = {},
) {
	return {
		ok: true,
		data: {
			cycle: {
				surface: "kanban",
				surfaceDescription: "",
				readiness,
				ran: true,
				proposed: 0,
				pending: [],
				stale: 0,
				ingest: null,
				...extra,
			},
		},
	};
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	mockFetchStatus.mockReset();
	mockRunCycle.mockReset();
	mockReview.mockReset();
	mockInstallSoul.mockReset();
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

const loaded = (value: HermesStatus) =>
	mockFetchStatus.mockResolvedValue({ ok: true, data: { status: value } });

const openDetails = async () =>
	fireEvent.click(await screen.findByRole("button", { name: /How it works/ }));

const soul = (state: HermesStatus["soul"]["state"]): HermesStatus["soul"] => ({
	state,
	offered: state !== "unavailable",
	installed: state === "installed" || state === "diverged",
	matches: state === "installed",
	installedPath: "/home/me/.hermes/SOUL.md",
	repoPath: "SOUL.md",
});

it.each([
	["not-installed", "Install SOUL.md", false],
	// A different persona is in place: replacing it is offered, the old one is backed up
	["diverged", "Replace the installed persona", true],
] as const)("offers the persona when it is %s, and installs it", async (state, label, overwrite) => {
	loaded(status({ candidates: [], soul: soul(state) }));
	mockInstallSoul.mockResolvedValue({
		ok: true,
		data: { changed: true, message: "installed", sessions: "requested", soul: soul("installed") },
	});
	render(<HermesLearningCard task={task} />);
	await openDetails();
	expect(screen.getByText("Persona (SOUL.md)")).toBeInTheDocument();
	// The status read again after the install says it is in place
	loaded(status({ candidates: [], soul: soul("installed") }));
	fireEvent.click(screen.getByRole("button", { name: label }));
	await waitFor(() => expect(mockInstallSoul).toHaveBeenCalledWith(overwrite));
	expect(
		await screen.findByText(
			"Persona installed: running hermes sessions will pick it up on their next turn.",
		),
	).toBeInTheDocument();
	// Installed now: nothing more to offer
	expect(screen.queryByText("Persona (SOUL.md)")).not.toBeInTheDocument();
});

it.each(["installed", "unavailable"] as const)(
	"offers no persona when it is %s",
	async (state) => {
		loaded(status({ candidates: [], soul: soul(state) }));
		render(<HermesLearningCard task={task} />);
		await openDetails();
		expect(screen.queryByText("Persona (SOUL.md)")).not.toBeInTheDocument();
	},
);

it("reads what an older backend sends: file names only, no brain, no counts", async () => {
	const old = status();
	const readiness = { ...old.readiness, state: "degraded" as const };
	mockRunCycle.mockResolvedValue(cycle(readiness, { pending: ["hermes--fix_the-build.md"] }));
	loaded({
		...old,
		readiness,
		candidates: undefined,
		pending: ["hermes--fix_the-build.md"],
		declined: undefined,
		brain: undefined,
	});
	render(<HermesLearningCard task={task} />);

	expect(await screen.findByText("1 skill is waiting for your decision")).toBeInTheDocument();
	expect(screen.getByText("fix the build")).toBeInTheDocument();
	expect(screen.getByText("partly configured")).toBeInTheDocument();
	expect(screen.getByText("In the brain").closest("li")).toHaveAttribute(
		"title",
		"No shared brain is set up on this machine.",
	);
	// Neither a preview nor a description it does not have
	expect(screen.queryByRole("button", { name: /Preview/ })).not.toBeInTheDocument();
	const row = screen.getByText("fix the build").closest("li");
	if (!row) throw new Error("row not found");
	expect(within(row).getByRole("button", { name: "Keep" })).toHaveAttribute(
		"title",
		"Adopt into skills/hermes-learned/ — a versioned draft no agent loads until the pack is listed.",
	);

	await openDetails();
	expect(
		screen.getByText("No shared brain: kept skills stay in the repository only."),
	).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Open brain settings" })).toBeInTheDocument();
	expect(screen.queryByText("Kept skills")).not.toBeInTheDocument();
});

it("says hermes is not ready, with the command to run, and refreshes on demand", async () => {
	const base = status();
	const readiness = {
		...base.readiness,
		state: "degraded" as const,
		ready: false,
		checks: [
			{ name: "trust", ok: false, detail: "not trusted", remedy: "hermes skills trust .", required: true },
			{ name: "skills", ok: false, detail: "none", remedy: "", required: true },
			{ name: "agents", ok: false, detail: "no AGENTS.md", remedy: "", required: false },
			{ name: "custom-check", ok: true, detail: "fine", remedy: "ignored", required: false },
		],
	};
	loaded(status({ candidates: [], readiness }));
	mockRunCycle.mockResolvedValue(cycle(readiness));
	let answer: (value: unknown) => void = () => undefined;
	render(<HermesLearningCard task={task} />);

	expect(await screen.findByText("hermes is not ready on this machine")).toBeInTheDocument();
	expect(screen.getByText("Run the command shown below, then refresh.")).toBeInTheDocument();
	expect(screen.getByText("hermes skills trust .")).toBeInTheDocument();
	expect(screen.getByText("Trust")).toBeInTheDocument();
	expect(screen.queryByText("Project context")).not.toBeInTheDocument();
	await waitFor(() => expect(mockRunCycle).toHaveBeenCalledTimes(1));

	mockRunCycle.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
	fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
	expect(await screen.findByRole("button", { name: "Checking…" })).toBeDisabled();
	answer({ ok: false, error: "hermes crashed" });
	expect(await screen.findByRole("alert")).toHaveTextContent("hermes crashed");
	expect(mockRunCycle).toHaveBeenCalledTimes(2);

	await openDetails();
	expect(screen.getByText("Conditions 1/4")).toBeInTheDocument();
	// A condition the panel has no name for keeps its own; a met one shows no command
	expect(screen.getByText("custom-check")).toBeInTheDocument();
	expect(screen.queryByText("ignored")).not.toBeInTheDocument();
	expect(screen.getByText("Project context")).toBeInTheDocument();
});

it("counts what the last pass found and filtered, and lists why in the details", async () => {
	loaded(
		status({
			candidates: [],
			stale: 1,
			declined: 4,
			adopted: ["airtable", "notion"],
			brain: { active: true, root: "/b", notes: 5, hermesConnected: true },
		}),
	);
	mockRunCycle.mockResolvedValue(
		cycle(status().readiness, {
			stale: 1,
			ingest: {
					found: 12,
					proposed: 0,
					files: [],
					unchanged: 0,
					deferred: 0,
					dropped: { "upstream-catalogue": 3, "a-new-reason": 1, "already-provided": 2 },
					droppedTotal: 6,
					pruned: 2,
					adopted: [],
					alreadyAdopted: 0,
					reason: "",
			},
		}),
	);
	render(<HermesLearningCard task={task} />);

	const step = (label: string) => screen.getByText(label).closest("li");
	await waitFor(() => expect(step("hermes learned")).toHaveTextContent("12"));
	// 6 dropped + 2 pruned + 1 stale
	expect(step("Filtered out")).toHaveTextContent("9");
	expect(step("In the brain")).toHaveTextContent("5");

	await openDetails();
	expect(screen.getByText("2 kept", { exact: false })).toBeInTheDocument();
	expect(screen.getByText("notion")).toBeInTheDocument();
	expect(screen.getByText("Written to skills/hermes-learned/, a pack not listed", { exact: false })).toBeInTheDocument();
	const reasons = screen
		.getByText("Decided without you")
		.closest("section")
		?.querySelectorAll("li");
	expect(Array.from(reasons ?? [], (li) => li.textContent)).toEqual([
		"1 × a-new-reason",
		"2 × already provided here",
		"3 × shipped with hermes, not learned",
	]);
	expect(screen.getByText("4 turned-down skills will never be proposed again.")).toBeInTheDocument();
	expect(
		screen.getByText("hermes reads the brain back (workpilot-brain MCP server connected)."),
	).toBeInTheDocument();
	expect(screen.queryByRole("button", { name: "Open brain settings" })).not.toBeInTheDocument();
});

it("folds a long inbox and unfolds it on demand", async () => {
	const many = ["a", "b", "c", "d", "e", "f", "g", "h"].map((n) => candidate(`skill-${n}`));
	loaded(status({ candidates: many }));
	render(<HermesLearningCard task={task} />);

	expect(await screen.findByText("skill a")).toBeInTheDocument();
	expect(screen.queryByText("skill g")).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
	expect(screen.getByText("skill h")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Show less" }));
	expect(screen.queryByText("skill h")).not.toBeInTheDocument();
});

it("keeps a hand-picked selection, and forgets what was decided meanwhile", async () => {
	loaded(status());
	mockReview.mockResolvedValue({
		ok: true,
		data: {
			review: { adopted: ["airtable"], declined: [], skipped: [], brainNotes: [] },
			status: status({ candidates: [candidate("diagnose-the-flake")] }),
		},
	});
	render(<HermesLearningCard task={task} />);

	const pick = await screen.findByRole("checkbox", { name: "Select airtable" });
	// Named by its label, which counts the selection once there is one
	const all = screen.getByRole("checkbox", { name: "Select all" });
	fireEvent.click(pick);
	expect(all).toHaveAttribute("data-state", "indeterminate");
	fireEvent.click(screen.getByRole("checkbox", { name: "Select diagnose-the-flake" }));
	expect(screen.getByText("2 selected")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("checkbox", { name: "Select diagnose-the-flake" }));
	expect(screen.getByText("1 selected")).toBeInTheDocument();
	fireEvent.click(all);
	expect(all).toHaveAttribute("data-state", "checked");
	fireEvent.click(all);
	expect(screen.getByText("Select all")).toBeInTheDocument();
	fireEvent.click(pick);

	const toolbar = screen.getByText("1 selected").closest("div")?.parentElement;
	if (!toolbar) throw new Error("toolbar not found");
	fireEvent.click(within(toolbar).getByRole("button", { name: /Keep/ }));
	await waitFor(() =>
		expect(mockReview).toHaveBeenCalledWith(["hermes--airtable.md"], "adopt", expect.anything()),
	);
	expect(await screen.findByText("1 skill kept in skills/hermes-learned/.")).toBeInTheDocument();
	// The decided skill left the selection with the inbox
	expect(screen.getByText("Select all")).toBeInTheDocument();
	expect(screen.getByText("hermes curator lock airtable")).toBeInTheDocument();
});

it("hides the curator lock when hermes is too old for it", async () => {
	const readiness = {
		...status().readiness,
		checks: [{ name: "version", ok: false, detail: "0.20", remedy: "hermes update", required: false }],
	};
	loaded(status({ readiness }));
	mockRunCycle.mockResolvedValue(cycle(readiness));
	mockReview.mockResolvedValue({
		ok: true,
		data: {
			review: { adopted: ["airtable"], declined: [], skipped: [], brainNotes: ["n.md"] },
			status: status({ candidates: [], readiness }),
		},
	});
	render(<HermesLearningCard task={task} />);
	const row = (await screen.findByText("What airtable is for.")).closest("li");
	if (!row) throw new Error("row not found");
	fireEvent.click(within(row).getByRole("button", { name: /Keep/ }));
	expect(await screen.findByText("1 skill kept and filed in the shared brain.")).toBeInTheDocument();
	expect(screen.queryByText(/hermes curator lock/)).not.toBeInTheDocument();
});

it("turns one candidate down, shows it busy meanwhile, and says what hermes still holds", async () => {
	loaded(
		status({
			candidates: [
				candidate("airtable", { pendingInHermes: true, description: "", tools: [] }),
				candidate("notion"),
			],
		}),
	);
	let answer: (value: unknown) => void = () => undefined;
	mockReview.mockReturnValue(new Promise((resolve) => (answer = resolve)));
	render(<HermesLearningCard task={task} />);

	const row = (await screen.findByText("pending in hermes")).closest("li");
	if (!row) throw new Error("row not found");
	fireEvent.click(within(row).getByRole("button", { name: "Preview (3 lines)" }));
	expect(within(row).queryByText(/hermes-only tools/)).not.toBeInTheDocument();
	fireEvent.click(within(row).getByRole("button", { name: /Turn down/ }));
	await waitFor(() =>
		expect(mockReview).toHaveBeenCalledWith(["hermes--airtable.md"], "decline", expect.anything()),
	);
	expect(within(row).queryByRole("button", { name: /Turn down/ })).not.toBeInTheDocument();
	expect(within(row).getByRole("checkbox")).toBeDisabled();

	answer({
		ok: true,
		data: {
			review: { adopted: [], declined: ["airtable"], skipped: [], brainNotes: [] },
			status: status({ candidates: [candidate("notion")] }),
		},
	});
	expect(
		await screen.findByText("1 skill turned down — it will not be proposed again."),
	).toBeInTheDocument();
});

describe("SoulInstallNote", () => {
	const install = (extra: Record<string, unknown>) =>
		useHermesStore.setState({
			lastSoulInstall: { changed: true, message: "", soul: soul("installed"), ...extra } as never,
		});
	const code = (container: HTMLElement) => container.querySelector("code")?.textContent;

	it.each([
		[{ sessions: "needs-update" }, "hermes update\nhermes sessions refresh-prompts"],
		[
			{ sessions: "needs-update", updateCommand: "pipx upgrade hermes", refreshCommand: "hermes refresh" },
			"pipx upgrade hermes\nhermes refresh",
		],
		[{ sessions: "unavailable" }, "hermes sessions refresh-prompts"],
		[{ sessions: "unavailable", refreshCommand: "hermes refresh" }, "hermes refresh"],
		[{ sessions: "requested" }, undefined],
	])("gives the command running sessions need (%j)", (extra, command) => {
		install(extra);
		const { container } = render(<SoulInstallNote />);
		expect(container).not.toBeEmptyDOMElement();
		expect(code(container)).toBe(command);
	});

	it.each([[{ changed: false, sessions: "requested" }], [{ sessions: null }]])(
		"says nothing when no persona was written (%j)",
		(extra) => {
			install(extra);
			const { container } = render(<SoulInstallNote />);
			expect(container).toBeEmptyDOMElement();
		},
	);
});
