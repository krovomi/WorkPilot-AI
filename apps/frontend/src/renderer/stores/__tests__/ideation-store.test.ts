/**
 * The ideation store: what the page shows while ideas are generated type by
 * type, what each action sends to the main process, and how a refused write
 * on a server project brings the page back to what is stored.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type {
	Idea,
	IdeationSession,
	IdeationType,
} from "../../../shared/types";
import {
	appendIdeation,
	archiveIdeaForProject,
	deleteIdeaForProject,
	deleteMultipleIdeasForProject,
	dismissAllIdeasForProject,
	generateIdeation,
	getActiveIdeas,
	getArchivedIdeas,
	getIdeasByStatus,
	getIdeasByType,
	getIdeationSummary,
	isCodeImprovementIdea,
	isUIUXIdea,
	loadIdeation,
	refreshIdeation,
	setupIdeationListeners,
	stopIdeation,
	useIdeationStore,
} from "../ideation-store";

type Listener = (...args: unknown[]) => void;
const listeners: Record<string, Listener> = {};
const unsubscribed: string[] = [];

function on(name: string) {
	return vi.fn((cb: Listener) => {
		listeners[name] = cb;
		return () => unsubscribed.push(name);
	});
}

const api = {
	getIdeation: vi.fn(),
	generateIdeation: vi.fn(),
	stopIdeation: vi.fn(),
	refreshIdeation: vi.fn(),
	dismissAllIdeas: vi.fn(),
	archiveIdea: vi.fn(),
	deleteIdea: vi.fn(),
	deleteMultipleIdeas: vi.fn(),
	onIdeationProgress: on("progress"),
	onIdeationLog: on("log"),
	onIdeationTypeComplete: on("typeComplete"),
	onIdeationTypeFailed: on("typeFailed"),
	onIdeationComplete: on("complete"),
	onIdeationError: on("error"),
	onIdeationStopped: on("stopped"),
};

const INITIAL = useIdeationStore.getState();

function idea(
	id: string,
	type: IdeationType = "code_improvements",
	status: Idea["status"] = "draft",
): Idea {
	return { id, type, status, title: id, description: "" } as unknown as Idea;
}

function session(ideas: Idea[]): IdeationSession {
	return {
		id: "s1",
		projectId: "p1",
		config: INITIAL.config,
		ideas,
		projectContext: { existingFeatures: [], techStack: [], plannedFeatures: [] },
		generatedAt: new Date("2026-11-01T10:00:00Z"),
		updatedAt: new Date("2026-11-01T10:00:00Z"),
	};
}

const state = () => useIdeationStore.getState();
const statuses = () => state().session?.ideas.map((i) => [i.id, i.status]);

beforeEach(async () => {
	await i18n.changeLanguage("en");
	for (const fn of Object.values(api)) fn.mockClear();
	api.getIdeation.mockResolvedValue({ success: true, data: undefined });
	api.stopIdeation.mockResolvedValue({ success: true });
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
	useIdeationStore.setState(INITIAL, true);
	unsubscribed.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("idea actions", () => {
	beforeEach(() => {
		useIdeationStore.setState({
			session: session([
				idea("a"),
				idea("b", "ui_ux_improvements", "converted"),
				idea("c", "code_quality", "archived"),
				idea("d", "security_hardening", "dismissed"),
			]),
		});
	});

	it("changes one idea's status and links a task by archiving it", () => {
		state().updateIdeaStatus("a", "selected");
		expect(statuses()?.[0]).toEqual(["a", "selected"]);
		state().setIdeaTaskId("a", "task-9");
		const a = state().session?.ideas[0];
		expect(a?.status).toBe("archived");
		expect(a?.taskId).toBe("task-9");
	});

	it("dismisses all open ideas but keeps converted and archived ones", () => {
		state().dismissIdea("a");
		expect(statuses()?.[0]).toEqual(["a", "dismissed"]);
		state().updateIdeaStatus("a", "draft");
		state().dismissAllIdeas();
		expect(statuses()).toEqual([
			["a", "dismissed"],
			["b", "converted"],
			["c", "archived"],
			["d", "dismissed"],
		]);
	});

	it("archives an idea", () => {
		state().archiveIdea("a");
		expect(statuses()?.[0]).toEqual(["a", "archived"]);
	});

	it("deletes ideas and drops them from the selection", () => {
		state().selectAllIdeas(["a", "b", "c"]);
		state().deleteIdea("a");
		expect(state().session?.ideas.map((i) => i.id)).toEqual(["b", "c", "d"]);
		expect([...state().selectedIds]).toEqual(["b", "c"]);
		state().deleteMultipleIdeas(["b", "d"]);
		expect(state().session?.ideas.map((i) => i.id)).toEqual(["c"]);
		expect([...state().selectedIds]).toEqual(["c"]);
	});

	it("does nothing without a session", () => {
		useIdeationStore.setState({ session: null });
		for (const act of [
			() => state().updateIdeaStatus("a", "selected"),
			() => state().setIdeaTaskId("a", "t"),
			() => state().dismissIdea("a"),
			() => state().dismissAllIdeas(),
			() => state().archiveIdea("a"),
			() => state().deleteIdea("a"),
			() => state().deleteMultipleIdeas(["a"]),
		]) {
			act();
			expect(state().session).toBeNull();
		}
	});

	it("toggles, selects all and clears the selection", () => {
		state().toggleSelectIdea("a");
		state().toggleSelectIdea("b");
		state().toggleSelectIdea("a");
		expect([...state().selectedIds]).toEqual(["b"]);
		state().selectAllIdeas(["a", "b"]);
		expect(state().selectedIds.size).toBe(2);
		state().clearSelection();
		expect(state().selectedIds.size).toBe(0);
	});
});

describe("store bookkeeping", () => {
	it("clears everything when the project changes, not when it stays", () => {
		useIdeationStore.setState({
			currentProjectId: "p1",
			session: session([idea("a")]),
			logs: ["x"],
			isGenerating: true,
			isLoadingSession: false,
		});
		state().setCurrentProjectId("p1");
		expect(state().session).not.toBeNull();
		state().setCurrentProjectId("p2");
		expect(state().session).toBeNull();
		expect(state().logs).toEqual([]);
		expect(state().isGenerating).toBe(false);
		expect(state().isLoadingSession).toBe(true);
	});

	it("merges the config and keeps only the last 500 log lines", () => {
		state().setConfig({ maxIdeasPerType: 9 });
		expect(state().config.maxIdeasPerType).toBe(9);
		expect(state().config.enabledTypes).toEqual(INITIAL.config.enabledTypes);
		for (let i = 0; i < 505; i++) state().addLog(`l${i}`);
		expect(state().logs).toHaveLength(500);
		expect(state().logs[0]).toBe("l5");
	});

	it("marks only the enabled types as generating", () => {
		state().initializeTypeStates(["code_quality", "documentation_gaps"]);
		expect(state().typeStates).toMatchObject({
			code_quality: "generating",
			documentation_gaps: "generating",
			code_improvements: "pending",
		});
		state().setTypeState("code_quality", "failed");
		state().resetGeneratingTypes("completed");
		expect(state().typeStates).toMatchObject({
			code_quality: "failed",
			documentation_gaps: "completed",
		});
	});

	it("starts a session with the first type's ideas, then replaces that type only", () => {
		state().addIdeasForType("code_quality", [idea("q1", "code_quality")]);
		expect(state().session?.ideas.map((i) => i.id)).toEqual(["q1"]);
		expect(state().typeStates.code_quality).toBe("completed");
		state().addIdeasForType("ui_ux_improvements", [
			idea("u1", "ui_ux_improvements"),
		]);
		state().addIdeasForType("code_quality", [
			idea("q2", "code_quality"),
			idea("q3", "code_quality"),
		]);
		expect(state().session?.ideas.map((i) => i.id)).toEqual(["u1", "q2", "q3"]);
	});
});

describe("loadIdeation", () => {
	it("shows the stored session of the project", async () => {
		const stored = session([idea("a")]);
		api.getIdeation.mockResolvedValue({ success: true, data: stored });
		await loadIdeation("p1");
		expect(api.getIdeation).toHaveBeenCalledWith("p1");
		expect(state().session).toBe(stored);
		expect(state().isLoadingSession).toBe(false);
	});

	it("shows no session when the read fails", async () => {
		useIdeationStore.setState({ currentProjectId: "p1", session: session([]) });
		api.getIdeation.mockResolvedValue({ success: false, error: "x" });
		await loadIdeation("p1");
		expect(state().session).toBeNull();
		expect(state().isLoadingSession).toBe(false);
	});

	it("does not read while this project is generating", async () => {
		useIdeationStore.setState({ currentProjectId: "p1", isGenerating: true });
		await loadIdeation("p1");
		expect(api.getIdeation).not.toHaveBeenCalled();
		expect(state().isLoadingSession).toBe(false);
	});

	it("loads the new project even when the previous one was generating", async () => {
		const stored = session([idea("a")]);
		api.getIdeation.mockResolvedValue({ success: true, data: stored });
		useIdeationStore.setState({ currentProjectId: "p1", isGenerating: true });
		await loadIdeation("p2");
		expect(api.getIdeation).toHaveBeenCalledWith("p2");
		expect(state().session).toBe(stored);
	});

	it("drops the answer when the project changed meanwhile", async () => {
		let resolve: (v: unknown) => void = () => undefined;
		api.getIdeation.mockReturnValue(
			new Promise((r) => {
				resolve = r;
			}),
		);
		const loading = loadIdeation("p1");
		state().setCurrentProjectId("p2");
		resolve({ success: true, data: session([idea("a")]) });
		await loading;
		expect(state().session).toBeNull();
		expect(state().isLoadingSession).toBe(true);
	});
});

describe("generation", () => {
	it("starts every enabled type and times out after five minutes", () => {
		vi.useFakeTimers();
		useIdeationStore.setState({ session: session([idea("old")]), logs: ["x"] });
		generateIdeation("p1");
		expect(api.generateIdeation).toHaveBeenCalledWith("p1", INITIAL.config);
		expect(state().session).toBeNull();
		expect(state().isGenerating).toBe(true);
		expect(state().generationStatus.phase).toBe("generating");
		expect(state().typeStates.code_improvements).toBe("generating");
		expect(state().logs).toEqual(["Starting ideation generation in parallel…"]);
		expect(state().generationStatus.message).toBe("Generating 3 ideation types in parallel…");

		vi.advanceTimersByTime(5 * 60 * 1000);
		expect(state().isGenerating).toBe(false);
		expect(state().generationStatus.phase).toBe("error");
		expect(state().generationStatus.error).toMatch(/timed out/);
		expect(state().typeStates.code_improvements).toBe("failed");
	});

	it("does not time out a generation that already finished", () => {
		vi.useFakeTimers();
		generateIdeation("p1");
		state().setGenerationStatus({ phase: "complete", progress: 100, message: "" });
		vi.advanceTimersByTime(5 * 60 * 1000);
		expect(state().generationStatus.phase).toBe("complete");
	});

	it("restarting a generation replaces the pending timeout", () => {
		vi.useFakeTimers();
		generateIdeation("p1");
		vi.advanceTimersByTime(4 * 60 * 1000);
		generateIdeation("p1");
		vi.advanceTimersByTime(2 * 60 * 1000);
		expect(state().generationStatus.phase).toBe("generating");
		vi.advanceTimersByTime(3 * 60 * 1000);
		expect(state().generationStatus.phase).toBe("error");
	});

	it("stops and says whether the process was still running", async () => {
		useIdeationStore.setState({ isGenerating: true });
		expect(await stopIdeation("p1")).toBe(true);
		expect(state().isGenerating).toBe(false);
		expect(state().generationStatus.message).toBe("Generation stopped");
		expect(state().logs.at(-1)).toBe("Ideation generation stopped");

		api.stopIdeation.mockResolvedValue({ success: false });
		expect(await stopIdeation("p1")).toBe(false);
		expect(state().logs.at(-1)).toBe("Process already stopped");
	});

	it("refresh stops the running process before starting again", async () => {
		await refreshIdeation("p1");
		expect(api.stopIdeation).toHaveBeenCalledWith("p1");
		expect(api.refreshIdeation).toHaveBeenCalledWith("p1", INITIAL.config);
		expect(state().isGenerating).toBe(true);
		expect(state().generationStatus.message).toMatch(/^Refreshing 3/);
	});

	it("append generates only the added types and keeps the finished ones", () => {
		useIdeationStore.setState({
			session: session([idea("a")]),
			typeStates: { ...INITIAL.typeStates, code_improvements: "completed" },
		});
		appendIdeation("p1", ["code_quality"]);
		expect(api.generateIdeation).toHaveBeenCalledWith("p1", {
			...INITIAL.config,
			enabledTypes: ["code_quality"],
			append: true,
		});
		expect(state().session?.ideas).toHaveLength(1);
		expect(state().typeStates.code_quality).toBe("generating");
		expect(state().typeStates.code_improvements).toBe("completed");
	});
});

describe("writes that the server can refuse", () => {
	beforeEach(() => {
		useIdeationStore.setState({
			currentProjectId: "p1",
			session: session([idea("a"), idea("b")]),
		});
	});

	it("applies each accepted write locally", async () => {
		api.archiveIdea.mockResolvedValue({ success: true });
		api.deleteIdea.mockResolvedValue({ success: true });
		api.dismissAllIdeas.mockResolvedValue({ success: true });
		api.deleteMultipleIdeas.mockResolvedValue({ success: true });

		expect(await archiveIdeaForProject("p1", "a")).toBe(true);
		expect(api.archiveIdea).toHaveBeenCalledWith("p1", "a");
		expect(statuses()?.[0]).toEqual(["a", "archived"]);
		expect(await dismissAllIdeasForProject("p1")).toBe(true);
		expect(statuses()?.[1]).toEqual(["b", "dismissed"]);
		expect(await deleteIdeaForProject("p1", "a")).toBe(true);
		expect(state().session?.ideas.map((i) => i.id)).toEqual(["b"]);
		state().selectAllIdeas(["b"]);
		expect(await deleteMultipleIdeasForProject("p1", ["b"])).toBe(true);
		expect(state().session?.ideas).toEqual([]);
		expect(state().selectedIds.size).toBe(0);
		expect(state().logs.at(-1)).toBe("1 idea deleted");
		expect(api.getIdeation).not.toHaveBeenCalled();
	});

	it("reloads the stored session after each refusal", async () => {
		const stored = session([idea("a", "code_improvements", "selected")]);
		api.getIdeation.mockResolvedValue({ success: true, data: stored });
		for (const write of [
			api.archiveIdea,
			api.deleteIdea,
			api.dismissAllIdeas,
			api.deleteMultipleIdeas,
		]) {
			write.mockResolvedValue({ success: false });
		}
		expect(await archiveIdeaForProject("p1", "a")).toBe(false);
		expect(await deleteIdeaForProject("p1", "a")).toBe(false);
		expect(await dismissAllIdeasForProject("p1")).toBe(false);
		expect(await deleteMultipleIdeasForProject("p1", ["a"])).toBe(false);
		expect(api.getIdeation).toHaveBeenCalledTimes(4);
		expect(state().session).toBe(stored);
	});
});

describe("selectors", () => {
	const s = session([
		idea("a"),
		idea("b", "ui_ux_improvements", "selected"),
		idea("c", "code_improvements", "archived"),
		idea("d", "code_quality", "dismissed"),
	]);

	it("filter ideas by type, status and activity", () => {
		expect(getIdeasByType(s, "code_improvements").map((i) => i.id)).toEqual([
			"a",
			"c",
		]);
		expect(getIdeasByStatus(s, "selected").map((i) => i.id)).toEqual(["b"]);
		expect(getActiveIdeas(s).map((i) => i.id)).toEqual(["a", "b"]);
		expect(getArchivedIdeas(s).map((i) => i.id)).toEqual(["c"]);
		for (const select of [
			() => getIdeasByType(null, "code_quality"),
			() => getIdeasByStatus(null, "draft"),
			() => getActiveIdeas(null),
			() => getArchivedIdeas(null),
		]) {
			expect(select()).toEqual([]);
		}
	});

	it("summarises the active ideas only", () => {
		expect(getIdeationSummary(s)).toEqual({
			totalIdeas: 2,
			byType: { code_improvements: 1, ui_ux_improvements: 1 },
			byStatus: { draft: 1, selected: 1 },
			lastGenerated: s.generatedAt,
		});
		expect(getIdeationSummary(null)).toEqual({
			totalIdeas: 0,
			byType: {},
			byStatus: {},
		});
	});

	it("tell the two idea kinds apart", () => {
		expect(isCodeImprovementIdea(idea("a"))).toBe(true);
		expect(isUIUXIdea(idea("a"))).toBe(false);
		expect(isUIUXIdea(idea("b", "ui_ux_improvements"))).toBe(true);
	});
});

describe("setupIdeationListeners", () => {
	let teardown: () => void;

	beforeEach(() => {
		useIdeationStore.setState({ currentProjectId: "p1" });
		teardown = setupIdeationListeners();
	});

	afterEach(() => teardown());

	it("ignores every event of another project", () => {
		const before = state();
		listeners.progress("p2", { phase: "generating", progress: 5, message: "" });
		listeners.log("p2", "x");
		listeners.typeComplete("p2", "code_quality", [idea("q")]);
		listeners.typeFailed("p2", "code_quality");
		listeners.complete("p2", session([]));
		listeners.error("p2", "boom");
		listeners.stopped("p2");
		expect(state()).toBe(before);
	});

	it("streams progress, logs and each finished type", () => {
		state().initializeTypeStates(INITIAL.config.enabledTypes);
		listeners.progress("p1", { phase: "generating", progress: 5, message: "m" });
		expect(state().generationStatus.progress).toBe(5);
		listeners.log("p1", "hello");
		expect(state().logs).toEqual(["hello"]);

		listeners.typeComplete("p1", "code_improvements", [idea("a")]);
		expect(state().session?.ideas.map((i) => i.id)).toEqual(["a"]);
		expect(state().generationStatus).toEqual({
			phase: "generating",
			progress: 33,
			message: "1/3 ideation types complete",
		});
		listeners.typeFailed("p1", "security_hardening");
		expect(state().typeStates.security_hardening).toBe("failed");
		listeners.typeComplete("p1", "ui_ux_improvements", []);
		expect(state().generationStatus.progress).toBe(100);
		expect(state().logs).toContain("✗ Security failed");
		expect(state().logs).toContain("✓ Code Improvements completed with 1 idea");
		expect(state().logs).toContain("✓ UI/UX Improvements completed with 0 ideas");
	});

	it("writes what it says in the app's language", async () => {
		await i18n.changeLanguage("fr");
		vi.useFakeTimers();
		generateIdeation("p1");
		expect(state().logs).toEqual(["Lancement de la génération d'idées en parallèle…"]);
		expect(state().generationStatus.message).toBe("Génération de 3 types d'idées en parallèle…");
		listeners.typeComplete("p1", "security_hardening", [idea("s1"), idea("s2")]);
		expect(state().logs.at(-1)).toBe("✓ Sécurité terminé avec 2 idées");
		expect(state().generationStatus.message).toBe("1/3 types d'idées terminés");
		vi.advanceTimersByTime(5 * 60 * 1000);
		expect(state().generationStatus.error).toBe(
			"La génération a dépassé le délai. Des idées ont peut-être été produites : vérifiez les résultats.",
		);
		expect(state().logs.at(-1)).toBe("⚠ Délai de génération dépassé");

		appendIdeation("p1", ["code_quality"]);
		expect(state().logs).toEqual(["Ajout de 1 nouveau type d'idées…"]);
		expect(state().generationStatus.message).toBe("Génération de 1 type d'idées supplémentaire…");
		listeners.complete("p1", session([]));
		expect(state().generationStatus.message).toBe("Idées générées");
		expect(state().logs.at(-1)).toBe("Génération d'idées terminée !");
		listeners.error("p1", "boom");
		expect(state().logs.at(-1)).toBe("Erreur : boom");

		expect(await stopIdeation("p1")).toBe(true);
		expect(state().generationStatus.message).toBe("Génération arrêtée");
		expect(state().logs.slice(-2)).toEqual(["Arrêt de la génération d'idées…", "Génération d'idées arrêtée"]);
	});

	it("finishes, fails or stops the generation and its timeout", () => {
		vi.useFakeTimers();
		const done = session([idea("z")]);
		generateIdeation("p1");
		listeners.complete("p1", done);
		expect(state().session).toBe(done);
		expect(state().isGenerating).toBe(false);
		expect(state().generationStatus.phase).toBe("complete");
		expect(state().typeStates.code_improvements).toBe("completed");
		vi.advanceTimersByTime(5 * 60 * 1000);
		expect(state().generationStatus.phase).toBe("complete");

		generateIdeation("p1");
		listeners.error("p1", "boom");
		expect(state().generationStatus).toMatchObject({ phase: "error", error: "boom" });
		expect(state().typeStates.code_improvements).toBe("failed");
		expect(state().logs.at(-1)).toBe("Error: boom");

		generateIdeation("p1");
		listeners.stopped("p1");
		expect(state().generationStatus.message).toBe("Generation stopped");
		expect(state().typeStates.code_improvements).toBe("pending");
	});

	it("reports timeouts, failures and errors on the console in debug mode", () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		(window as unknown as { DEBUG: boolean }).DEBUG = true;
		try {
			generateIdeation("p1");
			vi.advanceTimersByTime(5 * 60 * 1000);
			listeners.typeFailed("p1", "code_quality");
			listeners.error("p1", "boom");
			expect(warn).toHaveBeenCalledWith(
				"[Ideation] Generation timed out after",
				300000,
				"ms",
			);
			expect(error).toHaveBeenCalledWith("[Ideation] Type failed:", {
				projectId: "p1",
				ideationType: "code_quality",
			});
			expect(error).toHaveBeenCalledWith("[Ideation] Error received:", {
				projectId: "p1",
				error: "boom",
			});
		} finally {
			(window as unknown as { DEBUG: boolean }).DEBUG = false;
			warn.mockRestore();
			error.mockRestore();
		}
	});

	it("teardown unsubscribes every listener and cancels pending timeouts", () => {
		vi.useFakeTimers();
		generateIdeation("p1");
		teardown();
		teardown = () => undefined;
		expect(unsubscribed.sort()).toEqual(
			["complete", "error", "log", "progress", "stopped", "typeComplete", "typeFailed"].sort(),
		);
		vi.advanceTimersByTime(5 * 60 * 1000);
		expect(state().generationStatus.phase).toBe("generating");
	});
});
