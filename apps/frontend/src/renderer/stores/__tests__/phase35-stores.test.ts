/**
 * The Phase 3-5 feature stores: each action sends its arguments to the main
 * process, keeps what the backend answered, and turns a refusal or a thrown
 * error into the message the panel shows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	bindPhase35Project,
	PAIR_AI_USER_ID,
	setupPairRealtimeListeners,
	useAgentHealthStore,
	useArchDriftStore,
	useAuditTrailStore,
	useCicdAnomalyStore,
	useCogContextStore,
	useDomainAgentsStore,
	useGenTestsStore,
	useI18nScalerStore,
	useLicenseStore,
	useLongevityStore,
	useModelRouterStore,
	usePairRealtimeStore,
} from "../phase35-stores";

const api: Record<string, ReturnType<typeof vi.fn>> = {};
function mock(name: string) {
	api[name] ??= vi.fn();
	return api[name];
}

const stores = [
	useAgentHealthStore,
	useArchDriftStore,
	useAuditTrailStore,
	useCicdAnomalyStore,
	useCogContextStore,
	useDomainAgentsStore,
	useGenTestsStore,
	useI18nScalerStore,
	useLicenseStore,
	useLongevityStore,
	useModelRouterStore,
	usePairRealtimeStore,
] as const;
const initial = stores.map((s) => s.getState());

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	(globalThis as { electronAPI?: unknown }).electronAPI = new Proxy(
		{},
		{ get: (_t, name: string) => mock(name) },
	);
	stores.forEach((s, i) =>
		(s as unknown as { setState: (v: unknown, replace: true) => void }).setState(
			initial[i],
			true,
		),
	);
});

/**
 * One action of a simple slice: the channel it calls, the answer it gets on
 * success and the state that answer must leave.
 */
interface Case {
	name: string;
	run: () => Promise<unknown>;
	channel: string;
	args: unknown[];
	answer: Record<string, unknown>;
	expected: Record<string, unknown>;
	state: () => Record<string, unknown>;
}

const cases: Case[] = [
	{
		name: "longevity compute",
		run: () => useLongevityStore.getState().compute("/p"),
		channel: "scoreLongevity",
		args: ["/p"],
		answer: { report: { score: 80 } },
		expected: { report: { score: 80 } },
		state: () => useLongevityStore.getState() as never,
	},
	{
		name: "agent health refresh",
		run: () => useAgentHealthStore.getState().refresh("/p"),
		channel: "scoreProjectAgentHealth",
		args: ["/p"],
		answer: { scores: [1], pending: [2], tasks_read: 3, min_runs: 4 },
		expected: {
			projectPath: "/p",
			health: { scores: [1], pending: [2], tasks_read: 3, min_runs: 4 },
		},
		state: () => useAgentHealthStore.getState() as never,
	},
	{
		name: "model route",
		run: () => useModelRouterStore.getState().route({ task: "x" } as never),
		channel: "routeModel",
		args: [{ task: "x" }],
		answer: { choice: { model: "m" } },
		expected: { chosen: { model: "m" } },
		state: () => useModelRouterStore.getState() as never,
	},
	{
		name: "model compare",
		run: () => useModelRouterStore.getState().compare({ task: "x" } as never),
		channel: "compareModels",
		args: [{ task: "x" }],
		answer: { by_tier: { fast: { model: "f" } } },
		expected: { comparison: { fast: { model: "f" } } },
		state: () => useModelRouterStore.getState() as never,
	},
	{
		name: "domain list",
		run: () => useDomainAgentsStore.getState().loadDomains(),
		channel: "listDomains",
		args: [],
		answer: { domains: [{ id: "fin" }] },
		expected: { domains: [{ id: "fin" }] },
		state: () => useDomainAgentsStore.getState() as never,
	},
	{
		name: "domain profile",
		run: () => useDomainAgentsStore.getState().loadProfile("fin"),
		channel: "getDomainProfile",
		args: ["fin"],
		answer: { profile: { id: "fin" } },
		expected: { selectedDomain: "fin", profile: { id: "fin" } },
		state: () => useDomainAgentsStore.getState() as never,
	},
	{
		name: "domain bundle",
		run: () => useDomainAgentsStore.getState().build("fin", "coder", "/p"),
		channel: "buildDomainBundle",
		args: ["fin", "coder", "/p"],
		answer: { bundle: { prompt: "x" } },
		expected: { bundle: { prompt: "x" } },
		state: () => useDomainAgentsStore.getState() as never,
	},
	{
		name: "project domain apply",
		run: () => useDomainAgentsStore.getState().applyProjectDomain("/p", "fin"),
		channel: "setProjectDomain",
		args: ["/p", "fin"],
		answer: { domain: "fin" },
		expected: { projectPath: "/p", projectDomain: "fin" },
		state: () => useDomainAgentsStore.getState() as never,
	},
	{
		name: "CI log scan",
		run: () => useCicdAnomalyStore.getState().scan("log", "build"),
		channel: "scanCicdLog",
		args: ["log", "build"],
		answer: { signals: [{ kind: "oom" }] },
		expected: { signals: [{ kind: "oom" }] },
		state: () => useCicdAnomalyStore.getState() as never,
	},
	{
		name: "CI logs analysis",
		run: () =>
			useCicdAnomalyStore.getState().analyse([{ label: "a", text: "t" }]),
		channel: "analyseCicdLogs",
		args: [[{ label: "a", text: "t" }]],
		answer: { report: { signals: [{ kind: "flaky" }] } },
		expected: {
			report: { signals: [{ kind: "flaky" }] },
			signals: [{ kind: "flaky" }],
		},
		state: () => useCicdAnomalyStore.getState() as never,
	},
	{
		name: "license scan",
		run: () => useLicenseStore.getState().scan("/p", "saas_safe", false),
		channel: "scanLicenses",
		args: ["/p", "saas_safe", undefined, false],
		answer: { report: { deps: [] } },
		expected: { report: { deps: [] }, online: false },
		state: () => useLicenseStore.getState() as never,
	},
	{
		name: "architecture scan",
		run: () => useArchDriftStore.getState().scan("/p"),
		channel: "scanArchitecture",
		args: ["/p"],
		answer: { report: { violations: [] }, config_source: "file" },
		expected: { scanReport: { violations: [] }, configSource: "file" },
		state: () => useArchDriftStore.getState() as never,
	},
	{
		name: "architecture baseline",
		run: () => useArchDriftStore.getState().saveBaseline("/p"),
		channel: "saveArchBaseline",
		args: ["/p"],
		answer: { violation_count: 4, config_source: "inferred" },
		expected: { baselineCount: 4, configSource: "inferred" },
		state: () => useArchDriftStore.getState() as never,
	},
	{
		name: "architecture drift",
		run: () => useArchDriftStore.getState().compare("/p"),
		channel: "compareArchDrift",
		args: ["/p"],
		answer: { drift: { added: [] }, config_source: "file" },
		expected: { driftReport: { added: [] }, configSource: "file" },
		state: () => useArchDriftStore.getState() as never,
	},
	{
		name: "context optimisation",
		run: () => useCogContextStore.getState().optimize("/p", "fix", ["a.ts"], 900),
		channel: "optimizeContext",
		args: ["fix", ["a.ts"], 900, { projectDir: "/p" }],
		answer: { context: { files: ["a.ts"] } },
		expected: { context: { files: ["a.ts"] } },
		state: () => useCogContextStore.getState() as never,
	},
	{
		name: "audit events",
		run: () => useAuditTrailStore.getState().loadEvents("/s", "t"),
		channel: "auditEvents",
		args: [{ storageDir: "/s", trailName: "t" }],
		answer: { events: [{ sequence: 1 }] },
		expected: { events: [{ sequence: 1 }] },
		state: () => useAuditTrailStore.getState() as never,
	},
	{
		name: "audit replay",
		run: () => useAuditTrailStore.getState().replay("c1", "/s", "t"),
		channel: "auditReplay",
		args: ["c1", "/s", "t"],
		answer: { bundle: { events: [{ sequence: 2 }] } },
		expected: { replayEvents: [{ sequence: 2 }] },
		state: () => useAuditTrailStore.getState() as never,
	},
	{
		name: "audit verify",
		run: () => useAuditTrailStore.getState().verify("/s"),
		channel: "auditVerify",
		args: ["/s", undefined],
		answer: { integrity: { is_intact: true } },
		expected: { integrity: { is_intact: true } },
		state: () => useAuditTrailStore.getState() as never,
	},
];

describe.each(cases)("$name", (c) => {
	it("keeps the answer", async () => {
		mock(c.channel).mockResolvedValue({ success: true, ...c.answer });
		await c.run();
		expect(mock(c.channel)).toHaveBeenCalledWith(...c.args);
		expect(c.state()).toMatchObject({ phase: "ok", error: null, ...c.expected });
	});

	it("shows the backend's refusal, or a generic one", async () => {
		mock(c.channel).mockResolvedValue({ success: false, error: "nope" });
		await c.run();
		expect(c.state()).toMatchObject({ phase: "error", error: "nope" });
		mock(c.channel).mockResolvedValue({ success: false });
		await c.run();
		expect(c.state()).toMatchObject({ phase: "error", error: "Backend error" });
	});

	it("shows a thrown value as text", async () => {
		mock(c.channel).mockRejectedValue("socket closed");
		await c.run();
		expect(c.state()).toMatchObject({ phase: "error", error: "socket closed" });
	});
});

/** The actions whose answer belongs to the open project. */
const PROJECT_BOUND = new Set([
	"longevity compute",
	"agent health refresh",
	"domain bundle",
	"license scan",
	"architecture scan",
	"architecture baseline",
	"architecture drift",
	"context optimisation",
	"audit events",
	"audit replay",
	"audit verify",
]);
let otherProject = 0;

describe.each(cases.filter((c) => PROJECT_BOUND.has(c.name)))("$name, once another project is open", (c) => {
	it("drops the answer of the project that was open when it started", async () => {
		let answer!: (value: unknown) => void;
		mock(c.channel).mockReturnValue(new Promise((r) => (answer = r)));
		const run = c.run();
		otherProject += 1;
		bindPhase35Project(`/other-${otherProject}`);
		answer({ success: true, ...c.answer });
		await run;
		expect(c.state()).toMatchObject({ phase: "idle", error: null });
		expect(c.state()).not.toMatchObject(c.expected);
	});

	it("drops its failure too", async () => {
		let fail!: (reason: unknown) => void;
		mock(c.channel).mockReturnValue(new Promise((_r, j) => (fail = j)));
		const run = c.run();
		otherProject += 1;
		bindPhase35Project(`/other-${otherProject}`);
		fail(new Error("too late"));
		await run;
		expect(c.state()).toMatchObject({ phase: "idle", error: null });
	});
});

describe("binding the open project", () => {
	it("clears the findings only when the project changes", () => {
		bindPhase35Project("/same");
		useLongevityStore.setState({ report: { score: 1 } as never });
		bindPhase35Project("/same");
		expect(useLongevityStore.getState().report).toEqual({ score: 1 });
		bindPhase35Project("/another");
		expect(useLongevityStore.getState().report).toBeNull();
	});

	it("keeps the agent scores of the same project while they reload, not another's", async () => {
		mock("scoreProjectAgentHealth").mockReturnValue(new Promise(() => undefined));
		useAgentHealthStore.setState({ projectPath: "/p", health: { scores: [] } as never });
		void useAgentHealthStore.getState().refresh("/p");
		expect(useAgentHealthStore.getState().health).toEqual({ scores: [] });
		void useAgentHealthStore.getState().refresh("/q");
		expect(useAgentHealthStore.getState()).toMatchObject({ projectPath: "/q", health: null });
	});
});

describe("simple slices, the cases the table does not cover", () => {
	it("longevity and licenses need a project", async () => {
		await useLongevityStore.getState().compute("");
		expect(useLongevityStore.getState().error).toBe("projectPath is required");
		await useLicenseStore.getState().scan("");
		expect(useLicenseStore.getState().error).toBe("projectPath is required");
		expect(mock("scoreLongevity")).not.toHaveBeenCalled();
		expect(mock("scanLicenses")).not.toHaveBeenCalled();
	});

	it("longevity resets and keeps a missing report as none", async () => {
		mock("scoreLongevity").mockResolvedValue({ success: true });
		await useLongevityStore.getState().compute("/p");
		expect(useLongevityStore.getState().report).toBeNull();
		useLongevityStore.setState({ phase: "error", error: "x" });
		useLongevityStore.getState().reset();
		expect(useLongevityStore.getState()).toMatchObject({ phase: "idle", error: null });
	});

	it("agent health forgets the last scores on failure", async () => {
		useAgentHealthStore.setState({ health: { scores: [] } as never });
		mock("scoreProjectAgentHealth").mockRejectedValue(new Error("gone"));
		await useAgentHealthStore.getState().refresh("/p");
		expect(useAgentHealthStore.getState()).toMatchObject({
			error: "gone",
			health: null,
		});
	});

	it("licenses scan online by default and keep what the backend says", async () => {
		mock("scanLicenses").mockResolvedValue({ success: true, report: {}, online: false });
		await useLicenseStore.getState().scan("/p");
		expect(mock("scanLicenses")).toHaveBeenCalledWith("/p", undefined, undefined, true);
		expect(useLicenseStore.getState().online).toBe(false);
	});

	it("reads the project's domain and languages", async () => {
		mock("getProjectDomain").mockResolvedValue({
			success: true,
			domain: "health",
			languages: ["py"],
		});
		await useDomainAgentsStore.getState().loadProjectDomain("/p");
		expect(useDomainAgentsStore.getState()).toMatchObject({
			projectPath: "/p",
			projectDomain: "health",
			projectLanguages: ["py"],
		});
		mock("getProjectDomain").mockResolvedValue({ success: false });
		await useDomainAgentsStore.getState().loadProjectDomain("/q");
		expect(useDomainAgentsStore.getState()).toMatchObject({
			projectPath: "/q",
			projectDomain: null,
			projectLanguages: [],
			phase: "error",
			error: "Backend error",
		});
	});

	it("i18n report says where the locales were read and which catalogs", async () => {
		mock("reportI18nFromDir").mockResolvedValue({
			success: true,
			report: { locales: 2 },
			locales_dir: "/p/locales",
			redirected_from: "/p/locales/en",
			layout: "catalogs",
			formats: ["po"],
		});
		await useI18nScalerStore.getState().runReport("/p/locales/en", "en");
		expect(mock("reportI18nFromDir")).toHaveBeenCalledWith("/p/locales/en", "en");
		expect(useI18nScalerStore.getState()).toMatchObject({
			phase: "ok",
			report: { locales: 2 },
			scannedDir: "/p/locales",
			redirectedFrom: "/p/locales/en",
			formats: ["po"],
		});

		mock("reportI18nFromDir").mockResolvedValue({ success: true, report: {}, layout: "catalogs" });
		await useI18nScalerStore.getState().runReport("/x");
		expect(useI18nScalerStore.getState()).toMatchObject({
			scannedDir: null,
			redirectedFrom: null,
			formats: [],
		});
		mock("reportI18nFromDir").mockResolvedValue({
			success: true,
			report: {},
			layout: "json",
			formats: ["json"],
		});
		await useI18nScalerStore.getState().runReport("/x");
		expect(useI18nScalerStore.getState().formats).toEqual([]);
		mock("reportI18nFromDir").mockResolvedValue({ success: false, error: "no dir" });
		await useI18nScalerStore.getState().runReport("/x");
		expect(useI18nScalerStore.getState().error).toBe("no dir");
	});
});

describe("generational tests", () => {
	const gen = () => useGenTestsStore.getState();

	it("lists generations, an absent list as none", async () => {
		mock("listGenerations").mockResolvedValue({ success: true, details: [{ label: "g1" }] });
		await gen().listGenerations("/p");
		expect(gen().generations).toEqual([{ label: "g1" }]);
		mock("listGenerations").mockResolvedValue({ success: true });
		await gen().listGenerations("/p");
		expect(gen().generations).toEqual([]);
		mock("listGenerations").mockResolvedValue({ success: false, error: "e" });
		await gen().listGenerations("/p");
		expect(gen()).toMatchObject({ phase: "error", error: "e" });
	});

	it("detects the commands, none when it fails", async () => {
		mock("detectGenTestCommands").mockResolvedValue({ success: true, commands: [{ id: "v" }] });
		await gen().detect("/p");
		expect(gen().commands).toEqual([{ id: "v" }]);
		mock("detectGenTestCommands").mockResolvedValue({ success: false });
		await gen().detect("/p");
		expect(gen().commands).toEqual([]);
	});

	it("captures a report then rereads the list", async () => {
		mock("captureGeneration").mockResolvedValue({ success: true, format: "junit" });
		mock("listGenerations").mockResolvedValue({ success: true, details: [{ label: "g" }] });
		expect(await gen().capture("/p", "g", "<xml/>")).toBe(true);
		expect(mock("captureGeneration")).toHaveBeenCalledWith("/p", "g", "<xml/>");
		expect(gen()).toMatchObject({
			phase: "ok",
			running: null,
			lastSource: { kind: "report", value: "junit" },
			generations: [{ label: "g" }],
		});
		mock("captureGeneration").mockResolvedValue({ success: false, error: "bad" });
		expect(await gen().capture("/p", "g", "x")).toBe(false);
		expect(gen()).toMatchObject({ phase: "error", error: "bad", running: null });
	});

	it("compares a report with a baseline", async () => {
		mock("compareGeneration").mockResolvedValue({
			success: true,
			report: { regressions: 1 },
			format: "pytest",
		});
		await gen().compare("/p", "g1", "r");
		expect(gen()).toMatchObject({
			phase: "ok",
			regression: { regressions: 1 },
			lastSource: { kind: "report", value: "pytest" },
			running: null,
		});
		mock("compareGeneration").mockRejectedValue(new Error("x"));
		await gen().compare("/p", "g1", "r");
		expect(gen()).toMatchObject({ phase: "error", error: "x", regression: null });
	});

	it("runs the suite to capture, then rereads the list", async () => {
		mock("runGenTests").mockResolvedValue({ success: true, command: "pytest" });
		mock("listGenerations").mockResolvedValue({ success: true, details: [] });
		useGenTestsStore.setState({ regression: { regressions: 2 } as never });
		expect(await gen().runSuite("/p", "capture", "g", "py")).toBe(true);
		expect(mock("runGenTests")).toHaveBeenCalledWith("/p", "capture", "g", "py");
		expect(mock("listGenerations")).toHaveBeenCalledWith("/p");
		expect(gen()).toMatchObject({
			lastSource: { kind: "run", value: "pytest" },
			regression: { regressions: 2 },
			running: null,
		});
	});

	it("runs the suite to compare and keeps the regression report", async () => {
		mock("runGenTests").mockResolvedValue({
			success: true,
			command: "vitest",
			report: { regressions: 0 },
		});
		expect(await gen().runSuite("/p", "compare", "g", "v")).toBe(true);
		expect(gen().regression).toEqual({ regressions: 0 });
		expect(mock("listGenerations")).not.toHaveBeenCalled();
		mock("runGenTests").mockResolvedValue({ success: true, command: "vitest" });
		await gen().runSuite("/p", "compare", "g", "v");
		expect(gen().regression).toBeNull();
		mock("runGenTests").mockResolvedValue({ success: false, error: "red" });
		expect(await gen().runSuite("/p", "compare", "g", "v")).toBe(false);
		expect(gen()).toMatchObject({ phase: "error", error: "red", running: null });
	});

	it("imports a report, staying quiet when the person cancels", async () => {
		mock("importGenTestsReport").mockResolvedValue({
			success: true,
			name: "r.xml",
			content: "<x/>",
		});
		expect(await gen().importFile()).toEqual({ name: "r.xml", content: "<x/>" });
		mock("importGenTestsReport").mockResolvedValue({ success: false, error: "cancelled" });
		expect(await gen().importFile()).toBeNull();
		expect(gen().phase).toBe("idle");
		mock("importGenTestsReport").mockResolvedValue({ success: false, error: "too big" });
		expect(await gen().importFile()).toBeNull();
		expect(gen()).toMatchObject({ phase: "error", error: "too big" });
	});

	it("cancels, deletes a generation and resets", async () => {
		mock("listGenerations").mockResolvedValue({ success: true, details: [] });
		await gen().cancel();
		expect(mock("cancelGenTests")).toHaveBeenCalled();
		await gen().deleteGen("/p", "g");
		expect(mock("deleteGeneration")).toHaveBeenCalledWith("/p", "g");
		expect(mock("listGenerations")).toHaveBeenCalledWith("/p");
		useGenTestsStore.setState({ phase: "error", error: "x", commands: [] });
		gen().reset();
		expect(gen()).toMatchObject({ phase: "idle", error: null, commands: null });
	});
});

describe("pair realtime", () => {
	const pair = () => usePairRealtimeStore.getState();
	const room = (ids: string[]) => ({
		room_id: "r1",
		participants: ids.map((user_id) => ({ user_id })),
	});

	async function join(participants: string[] = ["me"]) {
		mock("pairJoin").mockResolvedValue({ success: true });
		mock("getPairRoom").mockResolvedValue({ success: true, room: room(participants) });
		await pair().createOrJoin("r1", "me", "Me", "driver", "/p");
	}

	it("creates or joins the room and reads it", async () => {
		await join();
		expect(mock("createPairRoom")).toHaveBeenCalledWith("r1");
		expect(mock("pairJoin")).toHaveBeenCalledWith("r1", "me", "Me", "driver");
		expect(pair()).toMatchObject({
			phase: "ok",
			currentRoom: room(["me"]),
			me: "me",
			projectPath: "/p",
		});
	});

	it("reports a failed join or a failed read", async () => {
		mock("pairJoin").mockResolvedValue({ success: false });
		await pair().createOrJoin("r1", "me", "Me", "driver", "/p");
		expect(pair()).toMatchObject({ phase: "error", error: "join failed" });
		mock("pairJoin").mockResolvedValue({ success: true });
		mock("getPairRoom").mockResolvedValue({ success: false });
		await pair().createOrJoin("r1", "me", "Me", "driver", "/p");
		expect(pair().error).toBe("snapshot failed");
		mock("getPairRoom").mockResolvedValue({ success: false, error: "gone" });
		await pair().createOrJoin("r1", "me", "Me", "driver", "/p");
		expect(pair().error).toBe("gone");
	});

	it("does nothing outside a room", async () => {
		await pair().leave();
		await pair().sendChat("hi");
		await pair().inviteAi("AI");
		await pair().askAi();
		await pair().focusFile("a.ts");
		await pair().refreshRoom();
		await pair().subscribe();
		await pair().unsubscribe();
		for (const name of ["pairLeave", "pairChat", "pairJoin", "pairAskAi", "pairCursor", "getPairRoom", "subscribePairRoom", "unsubscribePairRoom"]) {
			expect(mock(name)).not.toHaveBeenCalled();
		}
	});

	it("sends chat, and asks the AI only when it is in the room", async () => {
		await join();
		mock("pairChat").mockResolvedValue({ success: true });
		await pair().sendChat("hello");
		expect(mock("pairChat")).toHaveBeenCalledWith("r1", "me", "hello");
		expect(mock("pairAskAi")).not.toHaveBeenCalled();

		usePairRealtimeStore.setState({ currentRoom: room(["me", PAIR_AI_USER_ID]) as never });
		mock("pairAskAi").mockResolvedValue({ success: true });
		await pair().sendChat("and you?");
		expect(mock("pairAskAi")).toHaveBeenCalledWith("r1", "/p");
		expect(pair()).toMatchObject({ aiThinking: false, aiError: null });

		mock("pairChat").mockResolvedValue({ success: false });
		await pair().sendChat("x");
		expect(pair().error).toBe("chat failed");
	});

	it("keeps the AI's refusal or unavailability", async () => {
		await join();
		mock("pairAskAi").mockResolvedValue({ success: false, error: "empty" });
		await pair().askAi();
		expect(pair().aiError).toBe("empty");
		mock("pairAskAi").mockRejectedValue(new Error("down"));
		await pair().askAi();
		expect(pair()).toMatchObject({ aiError: "unavailable", aiThinking: false });
		usePairRealtimeStore.setState({ aiThinking: true });
		mock("pairAskAi").mockClear();
		await pair().askAi();
		expect(mock("pairAskAi")).not.toHaveBeenCalled();
	});

	it("invites the AI once, then rereads the room", async () => {
		await join();
		mock("getPairRoom").mockResolvedValue({
			success: true,
			room: room(["me", PAIR_AI_USER_ID]),
		});
		await pair().inviteAi("Partner");
		expect(mock("pairJoin")).toHaveBeenLastCalledWith("r1", PAIR_AI_USER_ID, "Partner", "ai");
		expect(pair().currentRoom).toEqual(room(["me", PAIR_AI_USER_ID]));
		mock("pairJoin").mockClear();
		await pair().inviteAi("Partner");
		expect(mock("pairJoin")).not.toHaveBeenCalled();

		usePairRealtimeStore.setState({ currentRoom: room(["me"]) as never });
		mock("pairJoin").mockResolvedValue({ success: false, error: "full" });
		await pair().inviteAi("Partner");
		expect(pair().error).toBe("full");
		mock("pairJoin").mockResolvedValue({ success: false });
		await pair().inviteAi("Partner");
		expect(pair().error).toBe("join failed");
	});

	it("moves my cursor and keeps the old room when a reread fails", async () => {
		await join();
		await pair().focusFile("src/a.ts");
		expect(mock("pairCursor")).toHaveBeenCalledWith("r1", "me", "src/a.ts", 0, 0);
		mock("getPairRoom").mockResolvedValue({ success: false });
		await pair().refreshRoom();
		expect(pair().currentRoom).toEqual(room(["me"]));
	});

	it("subscribes after the last operation seen, then leaves", async () => {
		await join();
		mock("subscribePairRoom").mockResolvedValue({ success: true, subscriptionId: "sub1" });
		await pair().subscribe();
		expect(mock("subscribePairRoom")).toHaveBeenCalledWith("r1", 0);
		usePairRealtimeStore.setState({ ops: [{ sequence: 4, kind: "chat" }] as never });
		await pair().subscribe();
		expect(mock("subscribePairRoom")).toHaveBeenLastCalledWith("r1", 5);
		expect(pair()).toMatchObject({ subscriptionId: "sub1", isStreaming: true });

		await pair().leave();
		expect(mock("unsubscribePairRoom")).toHaveBeenCalledWith("sub1");
		expect(mock("pairLeave")).toHaveBeenCalledWith("r1", "me");
		expect(pair()).toMatchObject({
			currentRoom: null,
			me: null,
			subscriptionId: null,
			isStreaming: false,
		});
	});

	it("reports a refused subscription", async () => {
		await join();
		mock("subscribePairRoom").mockResolvedValue({ success: false });
		await pair().subscribe();
		expect(pair()).toMatchObject({ error: "subscribe failed", isStreaming: false });
		mock("subscribePairRoom").mockResolvedValue({ success: false, error: "403" });
		await pair().subscribe();
		expect(pair().error).toBe("403");
	});

	it("leaves without telling the server who when I am unknown", async () => {
		usePairRealtimeStore.setState({ currentRoom: room([]) as never, me: null });
		await pair().leave();
		expect(mock("pairLeave")).not.toHaveBeenCalled();
		expect(pair().currentRoom).toBeNull();
	});

	it("streams operations of my subscription and rereads the room on a join", async () => {
		const handlers: Record<string, (e: unknown) => void> = {};
		mock("onPairOpEvent").mockImplementation((cb) => {
			handlers.op = cb;
			return () => {
				handlers.op = () => undefined;
			};
		});
		mock("onPairStreamError").mockImplementation((cb) => {
			handlers.error = cb;
			return () => undefined;
		});
		await join();
		usePairRealtimeStore.setState({ subscriptionId: "s1", isStreaming: true });
		const off = setupPairRealtimeListeners();

		handlers.op({ subscriptionId: "other", op: { sequence: 0, kind: "chat" } });
		expect(pair().ops).toEqual([]);
		handlers.op({ subscriptionId: "s1", op: { sequence: 0, kind: "chat" } });
		expect(mock("getPairRoom")).toHaveBeenCalledTimes(1);
		handlers.op({ subscriptionId: "s1", op: { sequence: 1, kind: "join" } });
		expect(pair().ops.map((o) => o.sequence)).toEqual([0, 1]);
		expect(mock("getPairRoom")).toHaveBeenCalledTimes(2);

		handlers.error({ subscriptionId: "other", error: "x" });
		expect(pair().isStreaming).toBe(true);
		handlers.error({ subscriptionId: "s1", error: "stream lost" });
		expect(pair()).toMatchObject({ error: "stream lost", isStreaming: false });

		off();
		handlers.op({ subscriptionId: "s1", op: { sequence: 2, kind: "chat" } });
		expect(pair().ops).toHaveLength(2);
	});
});
