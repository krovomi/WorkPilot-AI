/**
 * Arena Mode, as the person uses it: the models this machine can run, a
 * battle streamed card by card, the vote and its reveal, then the history,
 * the rankings and the routing recommendations those votes build.
 *
 * Only the bridge to the main process is simulated. The roster goes through
 * the real provider registry, the real catalog cache and the real stores.
 */
import type {
	ArenaAnalytics,
	ArenaBattle,
	ArenaParticipant,
} from "@shared/types/arena";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { setupArenaListeners, useArenaStore } from "@/stores/arena-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { ArenaDialog } from "../ArenaDialog";

// ─── The machine's providers, as the local backend describes them ────────────

type CatalogAnswer = { value: string; label: string; tier?: string }[] | "down";

const DEEPSEEK: CatalogAnswer = [
	{ value: "deepseek-v4-pro", label: "DeepSeek V4 Pro", tier: "flagship" },
	{ value: "deepseek-flash", label: "DeepSeek V4.1 Flash", tier: "standard" },
];
const OLLAMA: CatalogAnswer = [
	{ value: "arena-alpha", label: "Alpha Local" },
	{ value: "arena-beta", label: "Beta Local" },
	{ value: "arena-gamma", label: "Gamma Local" },
];

let catalogs: Record<string, CatalogAnswer>;
let capabilities: Record<string, unknown>;

function backendAnswer({ url }: { url: string }) {
	const json = (body: unknown) => ({
		status: 200,
		contentType: "application/json",
		text: JSON.stringify(body),
	});
	if (url === "/providers/agentic-capabilities") {
		return json({ providers: capabilities });
	}
	const provider = /^\/providers\/models\/([^/]+)\/catalog/.exec(url)?.[1] ?? "";
	const models = catalogs[provider];
	if (!models || models === "down") return { unreachable: true };
	return json({ provider, models, source: "live", fetchedAt: null, error: null });
}

// ─── The bridge ──────────────────────────────────────────────────────────────

const events: Record<string, ((event: never) => void) | undefined> = {};
const listen = (name: string) =>
	vi.fn((callback: (event: never) => void) => {
		events[name] = callback;
		return () => {
			events[name] = undefined;
		};
	});

function emit(name: string, event: unknown) {
	act(() => events[name]?.(event as never));
}

let api: Record<string, ReturnType<typeof vi.fn>>;

function installBridge() {
	api = {
		localBackendRequest: vi.fn(async (request) => backendAnswer(request)),
		invoke: vi.fn(async () => ({ installed: false, authenticated: false })),
		arenaStartBattle: vi.fn(async (request) => ({
			success: true,
			data: battleFrom(request),
		})),
		arenaVote: vi.fn(async () => ({ success: true })),
		arenaGetBattles: vi.fn(async () => ({ success: true, data: [] })),
		arenaGetAnalytics: vi.fn(async () => ({ success: true, data: analytics() })),
		arenaClearHistory: vi.fn(async () => ({ success: true })),
		onArenaBattleProgress: listen("progress"),
		onArenaBattleResult: listen("result"),
		onArenaBattleComplete: listen("complete"),
		onArenaBattleError: listen("error"),
	};
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = new Proxy(api, {
		get: (target, key: string) => target[key] ?? vi.fn(() => () => undefined),
	});
}

// ─── Battles, as the main process hands them over ────────────────────────────

const LABELS = ["A", "B", "C", "D"] as const;

function participant(
	label: ArenaParticipant["label"],
	extra: Partial<ArenaParticipant> = {},
): ArenaParticipant {
	return {
		label,
		contenderId: `ollama:model-${label}`,
		provider: "ollama",
		providerLabel: "Ollama (Local)",
		model: `model-${label}`,
		modelName: `Model ${label} name`,
		status: "waiting",
		output: "",
		tokensUsed: 0,
		usageEstimated: true,
		durationMs: 0,
		...extra,
	};
}

function battleFrom(request: {
	taskType: ArenaBattle["taskType"];
	prompt: string;
	contenders: { id: string; provider: string; providerLabel: string; model: string; modelLabel: string }[];
}): ArenaBattle {
	return {
		id: "battle-1",
		taskType: request.taskType,
		prompt: request.prompt,
		participants: request.contenders.map((contender, i) =>
			participant(LABELS[i], {
				contenderId: contender.id,
				provider: contender.provider,
				providerLabel: contender.providerLabel,
				model: contender.model,
				modelName: contender.modelLabel,
			}),
		),
		status: "running",
		createdAt: 1,
		revealed: false,
	};
}

function battle(extra: Partial<ArenaBattle> = {}): ArenaBattle {
	return {
		id: "old-1",
		taskType: "coding",
		prompt: "Write a parser",
		participants: [participant("A"), participant("B")],
		status: "completed",
		createdAt: 1,
		revealed: true,
		...extra,
	};
}

function analytics(extra: Partial<ArenaAnalytics> = {}): ArenaAnalytics {
	return {
		totalBattles: 0,
		totalVotes: 0,
		byModel: [],
		autoRoutingRecommendations: {},
		lastUpdated: 1,
		...extra,
	};
}

// ─── World ───────────────────────────────────────────────────────────────────

const initialArena = useArenaStore.getState();
const initialSettings = useSettingsStore.getState();
const initialProjects = useProjectStore.getState();
let clock = Date.UTC(2026, 10, 20);
let stopListening: () => void;

beforeEach(async () => {
	// The provider catalog is a module-wide cache with a TTL: an hour between
	// tests means every test reads the catalogs it describes.
	vi.useFakeTimers({ toFake: ["Date"] });
	clock += 3_600_000;
	vi.setSystemTime(clock);

	await i18n.changeLanguage("en");
	catalogs = { deepseek: DEEPSEEK, ollama: OLLAMA };
	capabilities = { mistral: { hasAdapter: false, degradesTo: "claude" } };
	installBridge();
	useArenaStore.setState({ ...initialArena, isOpen: true }, true);
	useSettingsStore.setState(
		{
			...initialSettings,
			profiles: [],
			settings: {
				...initialSettings.settings,
				globalDeepSeekApiKey: "fake-deepseek-key",
				globalMistralApiKey: "fake-mistral-key",
			},
		},
		true,
	);
	useProjectStore.setState(initialProjects, true);
	stopListening = setupArenaListeners();
});

afterEach(() => {
	stopListening();
	vi.useRealTimers();
});

async function openArena() {
	const user = userEvent.setup();
	render(<ArenaDialog />);
	await screen.findByText("5 models · 2 providers");
	await screen.findAllByTitle("Remove this model");
	return user;
}

function chip(name: RegExp) {
	return screen
		.getAllByTitle("Remove this model")
		.find((button) => name.test(button.textContent ?? ""));
}

async function startBattle(user: ReturnType<typeof userEvent.setup>, prompt = "  Sort a list  ") {
	await user.type(screen.getByLabelText("Prompt"), prompt);
	await user.click(screen.getByRole("button", { name: "Start Battle" }));
	await screen.findByRole("button", { name: "New Battle" });
}

// ─── The roster ──────────────────────────────────────────────────────────────

describe("choosing the contenders", () => {
	it("detects the machine's models, then opens on one model of each provider", async () => {
		render(<ArenaDialog />);
		expect(screen.getByText("Detecting available models…")).toBeInTheDocument();

		expect(await screen.findByText("5 models · 2 providers")).toBeInTheDocument();
		await screen.findAllByTitle("Remove this model");
		expect(screen.getByText("(2)").parentElement).toHaveTextContent("DeepSeek(2)");
		expect(screen.getByText("(3)").parentElement).toHaveTextContent("Ollama (Local)(3)");
		expect(chip(/DeepSeek V4 Pro/)).toBeDefined();
		expect(chip(/Alpha Local/)).toBeDefined();
		expect(screen.getAllByTitle("Remove this model")).toHaveLength(2);
		expect(screen.getByRole("button", { name: "DeepSeek V4 Pro", pressed: true })).toHaveAttribute(
			"title",
			"deepseek-v4-pro",
		);
		expect(screen.getByRole("button", { name: "Beta Local", pressed: false })).toBeEnabled();

		// A provider with no adapter of its own is said to be left out.
		expect(
			screen.getByText(/another vendor's model would answer for them\): Mistral AI → claude/),
		).toBeInTheDocument();

		// The prompt is what is still missing.
		expect(screen.getByRole("button", { name: "Start Battle" })).toBeDisabled();
	});

	it("finds a model by name or provider, and says when nothing matches", async () => {
		const user = await openArena();
		const search = screen.getByRole("textbox", { name: "Search a model or a provider…" });

		await user.type(search, "beta");
		expect(screen.getByRole("button", { name: "Beta Local", pressed: false })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Gamma Local", pressed: false })).toBeNull();

		await user.clear(search);
		await user.type(search, "no such model");
		expect(screen.getByText("No model matches this search")).toBeInTheDocument();
	});

	it("takes four models at most, and lets one go from its chip", async () => {
		const user = await openArena();

		await user.click(screen.getByRole("button", { name: "Beta Local", pressed: false }));
		await user.click(screen.getByRole("button", { name: "DeepSeek V4.1 Flash", pressed: false }));
		const fifth = screen.getByRole("button", { name: "Gamma Local", pressed: false });
		expect(fifth).toBeDisabled();
		expect(fifth).toHaveAttribute("title", "At most 4 models per battle");

		await user.click(chip(/Beta Local/) as HTMLElement);
		expect(screen.getAllByTitle("Remove this model")).toHaveLength(3);
		expect(screen.getByRole("button", { name: "Gamma Local", pressed: false })).toBeEnabled();

		// A selected model also leaves when its own button is pressed again.
		await user.click(screen.getByRole("button", { name: "DeepSeek V4.1 Flash", pressed: true }));
		expect(screen.getAllByTitle("Remove this model")).toHaveLength(2);
	});

	it("drops a model that left the roster after a refresh, and names the provider that answered nothing", async () => {
		const user = await openArena();
		catalogs.ollama = "down";

		await user.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("No models available for: Ollama (Local)")).toBeInTheDocument();
		expect(screen.getByText("2 models · 1 providers")).toBeInTheDocument();
		expect(chip(/Alpha Local/)).toBeUndefined();
		expect(chip(/DeepSeek V4 Pro/)).toBeDefined();

		await user.type(screen.getByLabelText("Prompt"), "Sort a list");
		expect(screen.getByRole("button", { name: "Start Battle" })).toBeDisabled();
	});

	it("keeps the selection as it is when a refresh finds the same models", async () => {
		const user = await openArena();
		await user.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
		expect(screen.getAllByTitle("Remove this model")).toHaveLength(2);
	});

	it("says how to configure a provider when the machine has none", async () => {
		useSettingsStore.setState({ settings: initialSettings.settings });
		catalogs = { ollama: "down" };
		render(<ArenaDialog />);

		expect(await screen.findByText("No LLM provider configured")).toBeInTheDocument();
		expect(screen.getByText(/Configure at least one provider in Settings/)).toBeInTheDocument();
		expect(screen.queryByRole("textbox", { name: "Search a model or a provider…" })).toBeNull();
	});
});

// ─── The battle ──────────────────────────────────────────────────────────────

describe("running a battle", () => {
	it("sends the chosen task, prompt, models and project, then streams each answer onto its card", async () => {
		useProjectStore.setState({
			projects: [{ id: "p1", name: "Demo", path: "/fake/demo" } as never],
			selectedProjectId: "p1",
		});
		const user = await openArena();

		await user.click(screen.getByRole("button", { name: /Code Review/, pressed: false }));
		expect(screen.getByRole("button", { name: /Code Review/, pressed: true })).toBeInTheDocument();
		await startBattle(user);

		expect(api.arenaStartBattle).toHaveBeenCalledWith({
			taskType: "review",
			prompt: "Sort a list",
			contenders: [
				{
					id: "deepseek:deepseek-v4-pro",
					provider: "deepseek",
					providerLabel: "DeepSeek",
					model: "deepseek-v4-pro",
					modelLabel: "DeepSeek V4 Pro",
				},
				{
					id: "ollama:arena-alpha",
					provider: "ollama",
					providerLabel: "Ollama (Local)",
					model: "arena-alpha",
					modelLabel: "Alpha Local",
				},
			],
			projectPath: "/fake/demo",
		});
		expect(screen.getByText("🔍Code Review")).toBeInTheDocument();
		expect(screen.getByText("Running…")).toBeInTheDocument();
		expect(screen.getByText("Sort a list")).toBeInTheDocument();
		expect(screen.getAllByText("Waiting to start…")).toHaveLength(2);
		// Nobody can be voted for while the models are still writing.
		expect(screen.queryByRole("button", { name: /Vote for this/ })).toBeNull();

		emit("progress", { battleId: "battle-1", label: "A", chunk: "def sort(" });
		emit("progress", { battleId: "battle-1", label: "A", chunk: "xs):" });
		expect(screen.getByText("def sort(xs):")).toBeInTheDocument();
		expect(screen.getAllByText("Waiting to start…")).toHaveLength(1);

		emit("result", {
			battleId: "battle-1",
			label: "A",
			output: "def sort(xs): return sorted(xs)",
			tokensUsed: 1234,
			usageEstimated: true,
			durationMs: 2500,
		});
		expect(screen.getByText("def sort(xs): return sorted(xs)")).toBeInTheDocument();
		expect(screen.getByTitle("Estimated: this provider reported no usage")).toHaveTextContent(
			"~1,234 tokens",
		);
		expect(screen.getAllByTitle("This provider reported no cost — no amount is invented")).toHaveLength(2);
		expect(screen.getByText("2.5s")).toBeInTheDocument();

		emit("result", {
			battleId: "battle-1",
			label: "B",
			output: "",
			tokensUsed: 40,
			usageEstimated: false,
			costUsd: 0,
			durationMs: 900,
			error: "pull model manifest: file does not exist",
		});
		expect(screen.getByText("Failed: this response cannot be voted for")).toBeInTheDocument();
		expect(screen.getByText("pull model manifest: file does not exist")).toBeInTheDocument();
		expect(screen.getByText("40 tokens")).not.toHaveAttribute("title");
		expect(screen.getByText("$0.00000")).toBeInTheDocument();
	});

	it("keeps hearing the battle while another tab is open", async () => {
		const user = await openArena();
		await startBattle(user);

		await user.click(screen.getByRole("button", { name: "History" }));
		expect(screen.getByRole("button", { name: "History" })).toHaveAttribute("aria-current", "page");
		emit("progress", { battleId: "battle-1", label: "B", chunk: "answer written meanwhile" });
		await user.click(screen.getByRole("button", { name: "Battle" }));

		expect(screen.getByText("answer written meanwhile")).toBeInTheDocument();
		expect(screen.getAllByText("Waiting to start…")).toHaveLength(1);
	});

	it("asks for a vote once two answers are in, then reveals the winner", async () => {
		const user = await openArena();
		await startBattle(user);
		const [a, b] = useArenaStore.getState().activeBattle?.participants ?? [];

		emit("complete", {
			battleId: "battle-1",
			participants: [
				{ ...a, status: "completed", output: "answer A", tokensUsed: 10, usageEstimated: false, costUsd: 0.00123, durationMs: 1000 },
				{ ...b, status: "completed", output: "answer B", tokensUsed: 0, durationMs: 0 },
			],
		});
		expect(screen.getByText("Vote now")).toBeInTheDocument();
		expect(screen.getByText("The models have finished — which response is better?")).toBeInTheDocument();
		expect(screen.getByText("$0.00123")).toBeInTheDocument();

		// Selecting a line of an answer to read it is not a vote.
		await user.click(screen.getByText("answer B"));
		expect(api.arenaVote).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Vote for this: Alpha Local" }));
		expect(api.arenaVote).toHaveBeenCalledWith(
			expect.objectContaining({
				battleId: "battle-1",
				winnerLabel: "B",
				winnerContenderId: "ollama:arena-alpha",
				taskType: "coding",
			}),
		);
		expect(await screen.findByText("Completed")).toBeInTheDocument();
		expect(screen.getByText("Winner:", { exact: false })).toHaveTextContent(
			"Winner: Alpha Local · Ollama (Local)",
		);
		expect(screen.queryByRole("button", { name: /Vote for this/ })).toBeNull();
		await waitFor(() => expect(api.arenaGetAnalytics).toHaveBeenCalled());
	});

	it("says a battle cannot be voted on when fewer than two models answered", async () => {
		const user = await openArena();
		await startBattle(user);
		const [a, b] = useArenaStore.getState().activeBattle?.participants ?? [];

		emit("complete", {
			battleId: "battle-1",
			participants: [
				{ ...a, status: "completed", output: "" },
				{ ...b, status: "error", error: "" },
			],
		});
		expect(
			screen.getByText("Fewer than two models answered: this battle cannot be voted on."),
		).toBeInTheDocument();
		expect(screen.queryByText("Vote now")).toBeNull();
		// An answer with no text, and a failure with no message, still say so.
		expect(screen.getAllByText("No output")).toHaveLength(2);
	});

	it("shows why the main process refused a vote", async () => {
		api.arenaVote.mockResolvedValueOnce({ success: false, error: "A model that failed cannot win a battle" });
		const user = await openArena();
		await startBattle(user);
		const [a, b] = useArenaStore.getState().activeBattle?.participants ?? [];
		emit("complete", {
			battleId: "battle-1",
			participants: [
				{ ...a, status: "completed", output: "one" },
				{ ...b, status: "completed", output: "two" },
			],
		});

		await user.click(screen.getByRole("button", { name: "Vote for this: DeepSeek V4 Pro" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("A model that failed cannot win a battle");
		expect(screen.getByText("Vote now")).toBeInTheDocument();

		api.arenaVote.mockResolvedValueOnce({ success: false });
		await user.click(screen.getByRole("button", { name: "Vote for this: DeepSeek V4 Pro" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Failed to submit vote"));

		api.arenaVote.mockRejectedValueOnce(new Error("ipc closed"));
		await user.click(screen.getByRole("button", { name: "Vote for this: DeepSeek V4 Pro" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("ipc closed"));

		api.arenaVote.mockRejectedValueOnce("not an error");
		await user.click(screen.getByRole("button", { name: "Vote for this: DeepSeek V4 Pro" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Failed to submit vote"));
	});

	it("shows a battle that failed as a whole, and ignores the failure of one already left", async () => {
		const user = await openArena();
		await startBattle(user);

		emit("error", { battleId: "another-battle", error: "late failure" });
		expect(screen.queryByRole("alert")).toBeNull();

		emit("error", { battleId: "battle-1", error: "provider crashed" });
		expect(screen.getByRole("alert")).toHaveTextContent("provider crashed");
		expect(screen.queryByText("Running…")).toBeNull();

		// A new battle starts from a clean slate.
		await user.click(screen.getByRole("button", { name: "New Battle" }));
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByLabelText("Prompt")).toHaveValue("  Sort a list  ");
		expect(useArenaStore.getState().activeBattle).toBeNull();
	});

	it("shows why a battle could not start", async () => {
		let answer: (value: unknown) => void = () => undefined;
		api.arenaStartBattle.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const user = await openArena();
		await user.type(screen.getByLabelText("Prompt"), "Sort a list");
		const start = screen.getByRole("button", { name: "Start Battle" });

		await user.click(start);
		expect(start).toBeDisabled();
		await act(async () => answer({ success: false, error: "A prompt is required" }));
		expect(screen.getByRole("alert")).toHaveTextContent("A prompt is required");
		expect(start).toBeEnabled();

		api.arenaStartBattle.mockResolvedValueOnce({ success: true });
		await user.click(start);
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Failed to start battle"));

		api.arenaStartBattle.mockRejectedValueOnce(new Error("ipc closed"));
		await user.click(start);
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("ipc closed"));

		api.arenaStartBattle.mockRejectedValueOnce("not an error");
		await user.click(start);
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Failed to start battle"));
		expect(screen.queryByRole("button", { name: "New Battle" })).toBeNull();
	});

	it("names a contestant recorded before contestants carried their model", async () => {
		api.arenaStartBattle.mockResolvedValueOnce({
			success: true,
			data: battle({
				id: "legacy",
				status: "running",
				revealed: false,
				participants: [
					participant("A", { modelName: "Model A", model: "", providerLabel: "", status: "running" }),
					participant("B", { modelName: "  ", status: "completed", output: "", durationMs: 0 }),
				],
			}),
		});
		const user = await openArena();
		await startBattle(user);

		expect(screen.getByText("Model A")).not.toHaveAttribute("title");
		expect(screen.getByText("Model B")).toHaveAttribute("title", "model-B");
		expect(screen.getByText("Generating…")).toBeInTheDocument();
		expect(screen.getByText("No output")).toBeInTheDocument();
	});
});

// ─── History ─────────────────────────────────────────────────────────────────

describe("the history", () => {
	const longPrompt = "Refactor the payment module so that every provider shares one retry policy";

	it("lists past battles, each one opening onto its contestants", async () => {
		let answer: (value: unknown) => void = () => undefined;
		api.arenaGetBattles.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const user = await openArena();
		await user.click(screen.getByRole("button", { name: "History" }));
		expect(screen.getByText("Loading history…")).toBeInTheDocument();

		await act(async () =>
			answer({
				success: true,
				data: [
					battle({
						prompt: longPrompt,
						taskType: "test",
						winnerLabel: "B",
						participants: [
							participant("A", { status: "error", tokensUsed: 12, model: "" }),
							participant("B", { usageEstimated: false, tokensUsed: 3400, costUsd: 0.001 }),
						],
					}),
					battle({ id: "old-2", status: "voting", revealed: false, prompt: "Short one" }),
				],
			}),
		);

		expect(screen.getByText("2 battles")).toBeInTheDocument();
		expect(screen.getByText(`${longPrompt.slice(0, 60)}…`)).toBeInTheDocument();
		expect(screen.getByText("Awaiting vote")).toBeInTheDocument();

		const row = screen.getByRole("button", { name: /Refactor the payment/ });
		expect(row).toHaveTextContent("Model B name");
		expect(row).toHaveAttribute("aria-expanded", "false");
		await user.click(row);
		expect(row).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("Failed: this response cannot be voted for")).toBeInTheDocument();
		expect(screen.getByText("~12 tokens")).toBeInTheDocument();
		expect(screen.getByText("3,400 tokens · $0.00100")).toBeInTheDocument();
		expect(screen.getByText("Model A name")).not.toHaveAttribute("title");
		expect(screen.getAllByText("Model B name").map((badge) => badge.getAttribute("title"))).toContain("model-B");

		await user.click(row);
		expect(screen.queryByText("~12 tokens")).toBeNull();
	});

	it("counts a single battle in the singular", async () => {
		api.arenaGetBattles.mockResolvedValueOnce({ success: true, data: [battle({ status: "running" })] });
		const user = await openArena();
		await user.click(screen.getByRole("button", { name: "History" }));
		expect(await screen.findByText("1 battle")).toBeInTheDocument();
		expect(screen.queryByText("Awaiting vote")).toBeNull();
	});

	it("clears every battle, and says so when it could not", async () => {
		api.arenaGetBattles.mockResolvedValue({ success: true, data: [battle()] });
		const user = await openArena();
		await user.click(screen.getByRole("button", { name: "History" }));
		const clear = await screen.findByRole("button", { name: "Clear All" });

		api.arenaClearHistory.mockResolvedValueOnce({ success: false, error: "disk full" });
		await user.click(clear);
		expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
		expect(screen.getByText("1 battle")).toBeInTheDocument();

		api.arenaClearHistory.mockResolvedValueOnce({ success: false });
		await user.click(clear);
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("Could not clear the battle history"),
		);

		api.arenaClearHistory.mockRejectedValueOnce(new Error("ipc closed"));
		await user.click(clear);
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("ipc closed"));

		api.arenaClearHistory.mockRejectedValueOnce("not an error");
		await user.click(clear);
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("Could not clear the battle history"),
		);

		api.arenaGetBattles.mockResolvedValue({ success: true, data: [] });
		await user.click(clear);
		expect(await screen.findByText("No battles yet")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(api.arenaGetAnalytics).toHaveBeenCalled();
	});

	it("says the history could not be read, rather than that it is empty", async () => {
		api.arenaGetBattles.mockResolvedValueOnce({ success: false, error: "corrupt battles.json" });
		const user = await openArena();
		await user.click(screen.getByRole("button", { name: "History" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("corrupt battles.json");

		api.arenaGetBattles.mockResolvedValueOnce({ success: false });
		await user.click(screen.getByRole("button", { name: "Battle" }));
		await user.click(screen.getByRole("button", { name: "History" }));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("Could not read the battle history"),
		);

		api.arenaGetBattles.mockRejectedValueOnce(new Error("ipc closed"));
		await user.click(screen.getByRole("button", { name: "Battle" }));
		await user.click(screen.getByRole("button", { name: "History" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("ipc closed"));

		api.arenaGetBattles.mockRejectedValueOnce("not an error");
		await user.click(screen.getByRole("button", { name: "Battle" }));
		await user.click(screen.getByRole("button", { name: "History" }));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("Could not read the battle history"),
		);
		// The battle panel does not inherit the history's failure.
		await user.click(screen.getByRole("button", { name: "Battle" }));
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

// ─── Analytics and routing ───────────────────────────────────────────────────

const stats = (contenderId: string, modelName: string, extra: object = {}) => ({
	contenderId,
	modelName,
	model: contenderId,
	provider: "ollama",
	providerLabel: "Ollama (Local)",
	wins: 2,
	losses: 1,
	total: 3,
	winRate: 2 / 3,
	totalCostUsd: 0,
	costSamples: 0,
	avgDurationMs: 0,
	byTaskType: {},
	...extra,
});

describe("the analytics", () => {
	it("ranks the models by the votes", async () => {
		let answer: (value: unknown) => void = () => undefined;
		api.arenaGetAnalytics.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const user = await openArena();
		await user.click(screen.getByRole("button", { name: "Analytics" }));
		expect(screen.getByText("Computing analytics…")).toBeInTheDocument();

		await act(async () =>
			answer({
				success: true,
				data: analytics({
					totalBattles: 7,
					totalVotes: 6,
					byModel: [
						stats("a", "Alpha Local", { avgCostPerBattle: 0.00123 }),
						stats("b", "Beta Local"),
						stats("c", "Gamma Local", { wins: 0, total: 3, winRate: 0 }),
					],
				}),
			}),
		);

		expect(screen.getByText("Total Battles").previousSibling).toHaveTextContent("7");
		expect(screen.getByText("Votes Cast").previousSibling).toHaveTextContent("6");
		expect(screen.getByText("Models Compared").previousSibling).toHaveTextContent("3");
		const alpha = screen.getByText("Alpha Local").closest("div.gap-3") as HTMLElement;
		expect(within(alpha).getByText("67%")).toBeInTheDocument();
		expect(within(alpha).getByText("$0.0012")).toBeInTheDocument();
		expect(screen.getAllByTitle("No cost reported by the provider for these battles")).toHaveLength(2);
		expect(screen.getByText("0/3")).toBeInTheDocument();
		expect(screen.getByText("1")).toHaveClass("text-warning");
		expect(screen.getByText("2")).toHaveClass("text-zinc-400");
		expect(screen.getByText("3", { selector: "span" })).toHaveClass("text-orange-400");
	});

	it("waits for votes before it ranks anything", async () => {
		const user = await openArena();
		await user.click(screen.getByRole("button", { name: "Analytics" }));
		expect(await screen.findByText("No analytics data yet")).toBeInTheDocument();
		expect(screen.getByText("Run battles and vote to see stats")).toBeInTheDocument();
	});

	it("says the analytics could not be computed, rather than that there are none", async () => {
		api.arenaGetAnalytics.mockResolvedValueOnce({ success: false, error: "votes.json unreadable" });
		const user = await openArena();
		await user.click(screen.getByRole("button", { name: "Analytics" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("votes.json unreadable");
		expect(screen.queryByText("No analytics data yet")).toBeNull();

		api.arenaGetAnalytics.mockResolvedValueOnce({ success: false });
		await user.click(screen.getByRole("button", { name: "Battle" }));
		await user.click(screen.getByRole("button", { name: "Analytics" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not compute the analytics"));

		api.arenaGetAnalytics.mockRejectedValueOnce(new Error("ipc closed"));
		await user.click(screen.getByRole("button", { name: "Battle" }));
		await user.click(screen.getByRole("button", { name: "Analytics" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("ipc closed"));

		api.arenaGetAnalytics.mockRejectedValueOnce("not an error");
		await user.click(screen.getByRole("button", { name: "Battle" }));
		await user.click(screen.getByRole("button", { name: "Analytics" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not compute the analytics"));
	});
});

describe("the routing recommendations", () => {
	it("names the best model of each task type that has one, and how much more data it needs", async () => {
		api.arenaGetAnalytics.mockResolvedValue({
			success: true,
			data: analytics({
				totalVotes: 3,
				autoRoutingRecommendations: {
					coding: { contenderId: "a", modelName: "Alpha Local", providerLabel: "Ollama (Local)", winRate: 0.75, confidence: "high" },
					spec: { contenderId: "b", modelName: "DeepSeek V4 Pro", providerLabel: "DeepSeek", winRate: 0.5, confidence: "low" },
				},
			}),
		});
		const user = await openArena();
		await user.click(screen.getByRole("button", { name: "Auto-Routing" }));

		expect(await screen.findByText("Current Recommendations")).toBeInTheDocument();
		expect(screen.getByText("The model that wins your votes most often, for each task type")).toBeInTheDocument();
		// Nothing routes on these yet, so nothing offers to switch it on.
		expect(screen.queryByRole("switch")).toBeNull();
		expect(screen.getByText("Coding")).toBeInTheDocument();
		expect(screen.getByText("Specification")).toBeInTheDocument();
		expect(screen.queryByText("Code Review")).toBeNull();
		expect(screen.getByText("75% · High confidence")).toBeInTheDocument();
		expect(screen.getByText("50% · Low confidence")).toBeInTheDocument();
		expect(screen.getByText("Run 7 more battle(s) to improve recommendation confidence")).toBeInTheDocument();
	});

	it("has nothing to recommend before the votes", async () => {
		api.arenaGetAnalytics.mockResolvedValue({ success: true, data: analytics({ totalVotes: 12 }) });
		const user = await openArena();
		await user.click(screen.getByRole("button", { name: "Auto-Routing" }));

		expect(await screen.findByText("No recommendations yet")).toBeInTheDocument();
		expect(screen.getByText("Run at least 5 battles per task type")).toBeInTheDocument();
		expect(screen.queryByText(/more battle\(s\)/)).toBeNull();
	});

	it("says the analytics behind them could not be computed", async () => {
		api.arenaGetAnalytics.mockResolvedValue({ success: false, error: "votes.json unreadable" });
		const user = await openArena();
		await user.click(screen.getByRole("button", { name: "Auto-Routing" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("votes.json unreadable");
		expect(screen.getByText("No recommendations yet")).toBeInTheDocument();
	});
});

// ─── The dialog ──────────────────────────────────────────────────────────────

describe("the dialog", () => {
	it("stays closed until opened, and closes on Escape", async () => {
		useArenaStore.setState({ isOpen: false });
		render(<ArenaDialog />);
		expect(screen.queryByText("Arena Mode")).toBeNull();

		act(() => useArenaStore.getState().openDialog());
		expect(await screen.findByRole("dialog", { name: "Arena Mode" })).toBeInTheDocument();
		expect(screen.getByText("A/B model comparison — let the data speak")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Battle" })).toHaveAttribute("aria-current", "page");
		await screen.findByText("5 models · 2 providers");

		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		await waitFor(() => expect(useArenaStore.getState().isOpen).toBe(false));
	});

	it("speaks French when the app does", async () => {
		await i18n.changeLanguage("fr");
		render(<ArenaDialog />);
		expect(await screen.findByText("5 modèles · 2 fournisseurs")).toBeInTheDocument();
		expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
		expect(screen.getByText("Type de tâche")).toBeInTheDocument();
	});
});

it("stops hearing battle events once the window's listeners are torn down", () => {
	stopListening();
	expect(events.progress).toBeUndefined();
	expect(events.result).toBeUndefined();
	expect(events.complete).toBeUndefined();
	expect(events.error).toBeUndefined();
	stopListening = () => undefined;
});
