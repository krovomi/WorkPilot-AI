/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { offeredDestinations } from "../voice-destinations";
import { resolveSentence, stopAgentsAfterStep } from "../voice-resolve";

const offered = [
	{ id: "kanban", label: "Tableau Kanban" },
	{ id: "roadmap", label: "Feuille de route" },
];

describe("reading a sentence", () => {
	const interpretVoiceCommand = vi.fn();
	const thinking = vi.fn();
	beforeEach(() => {
		vi.clearAllMocks();
		Object.assign(window.electronAPI, { interpretVoiceCommand });
	});
	const read = (said: string) => resolveSentence(said, offered, "fr-FR", "p1", thinking);

	it("says nothing was heard for an empty sentence", async () => {
		expect(await read("  ")).toEqual({ kind: "message", key: "results.nothingHeard" });
	});

	it("reads a spoken stop itself, never asking the model", async () => {
		expect(await read("Arrête tout")).toEqual({ kind: "stop" });
		expect(interpretVoiceCommand).not.toHaveBeenCalled();
	});

	it("acts on a sure local reading without the model", async () => {
		expect(await read("Ouvre le tableau kanban")).toEqual({
			kind: "intent",
			intent: { kind: "navigate", view: "kanban" },
		});
		expect(thinking).not.toHaveBeenCalled();
	});

	it("asks the model otherwise, saying it is thinking", async () => {
		interpretVoiceCommand.mockResolvedValue({
			success: true,
			intent: { kind: "navigate", view: "roadmap" },
		});
		expect(await read("montre-moi ce qui est prévu")).toEqual({
			kind: "intent",
			intent: { kind: "navigate", view: "roadmap" },
		});
		expect(thinking).toHaveBeenCalledOnce();
		expect(interpretVoiceCommand).toHaveBeenCalledWith("montre-moi ce qui est prévu", offered, "fr-FR", "p1");
	});

	it("falls back to the unsure local reading when the model does not answer", async () => {
		interpretVoiceCommand.mockRejectedValue(new Error("gone"));
		const views = offeredDestinations([{ id: "visual-to-code", label: "Visuel vers Code" }]);
		const outcome = await resolveSentence("dessiner une architecture", views, "fr-FR", undefined, thinking);
		expect(outcome).toEqual({ kind: "intent", intent: { kind: "navigate", view: "visual-to-code" } });
		expect(thinking).toHaveBeenCalledOnce();
	});

	it("offers the sidebar's views with what each is for, never itself", () => {
		expect(
			offeredDestinations([
				{ id: "voice-control", label: "Assistant vocal" },
				{ id: "kanban", label: "Tableau Kanban" },
				{ id: "a-view-without-hint", label: "Autre" },
			]),
		).toEqual([
			{ id: "kanban", label: "Tableau Kanban", hint: expect.any(String) },
			{ id: "a-view-without-hint", label: "Autre" },
		]);
	});

	it("says no model answered, or that it did not understand", async () => {
		interpretVoiceCommand.mockResolvedValueOnce({ success: false, error: "unavailable" });
		expect(await read("bla bla")).toEqual({ kind: "message", key: "results.noModel", text: "bla bla" });
		interpretVoiceCommand.mockResolvedValueOnce({ success: false, error: "unparsable" });
		expect(await read("bla bla")).toEqual({ kind: "message", key: "results.unknown", text: "bla bla" });
	});
});

describe("reading a sentence in pair mode", () => {
	const interpretVoiceCommand = vi.fn();
	const thinking = vi.fn();
	const followed = { id: "t1", title: "Export CSV" };
	beforeEach(() => {
		vi.clearAllMocks();
		Object.assign(window.electronAPI, { interpretVoiceCommand });
	});
	const read = (said: string) => resolveSentence(said, offered, "fr-FR", "p1", thinking, followed);

	it("still reads a stop and a sure command first", async () => {
		expect(await read("stop")).toEqual({ kind: "stop" });
		expect(await read("Ouvre le tableau kanban")).toEqual({
			kind: "intent",
			intent: { kind: "navigate", view: "kanban" },
		});
	});

	it("makes « tell it… » a message, even when it reads like a command", async () => {
		expect(await read("Dis-lui d'ouvrir le tableau kanban")).toEqual({
			kind: "guide",
			taskId: "t1",
			title: "Export CSV",
			text: "ouvrir le tableau kanban",
		});
	});

	it("gives any other sentence to the agent, never to the model", async () => {
		expect(await read("utilise plutôt zod pour valider")).toEqual({
			kind: "guide",
			taskId: "t1",
			title: "Export CSV",
			text: "utilise plutôt zod pour valider",
		});
		expect(interpretVoiceCommand).not.toHaveBeenCalled();
		expect(thinking).not.toHaveBeenCalled();
	});
});

describe("the confirmed stop", () => {
	const stop = vi.fn();
	beforeEach(() => {
		vi.clearAllMocks();
		Object.assign(window.electronAPI, { stopAgentsAfterStep: stop });
	});

	it("counts the tasks that stop after their step", async () => {
		stop.mockResolvedValue({ success: true, data: { stoppingTasks: ["a", "b"], failedTasks: [] } });
		expect(await stopAgentsAfterStep()).toEqual({ key: "stop.stopping", count: 2 });
	});

	it("says when nothing runs", async () => {
		stop.mockResolvedValue({ success: true, data: { stoppingTasks: [], failedTasks: [] } });
		expect(await stopAgentsAfterStep()).toEqual({ key: "stop.none", count: 0 });
	});

	it("says when a task could not be asked, or the call failed", async () => {
		stop.mockResolvedValueOnce({ success: true, data: { stoppingTasks: ["a"], failedTasks: ["b"] } });
		expect(await stopAgentsAfterStep()).toEqual({ key: "stop.failed", count: 1 });
		stop.mockResolvedValueOnce({ success: false, error: "no" });
		expect(await stopAgentsAfterStep()).toEqual({ key: "stop.failed", count: 0 });
		stop.mockRejectedValueOnce(new Error("gone"));
		expect(await stopAgentsAfterStep()).toEqual({ key: "stop.failed", count: 0 });
	});
});
