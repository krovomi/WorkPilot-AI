/**
 * The CI/CD dashboard's data: a project's trigger config, saved only when the
 * main process wrote it, its pipeline runs, and a manual trigger. Answers for
 * a project left behind are dropped.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCICDTriggersStore } from "../cicd-triggers-store";

const invoke = vi.fn();
const state = () => useCICDTriggersStore.getState();
const INITIAL = useCICDTriggersStore.getState();

function answer(channel: string, projectDir: string): unknown {
	if (channel === "cicdTriggers:getConfig") return { success: true, data: { provider: "github", enabled: true, project: projectDir } };
	if (channel === "cicdTriggers:listRuns") return { success: true, data: [{ id: `${projectDir}-run` }] };
	return { success: true };
}

function deferred() {
	let resolve: (value: unknown) => void = vi.fn();
	let reject: (reason: unknown) => void = vi.fn();
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(async () => {
	useCICDTriggersStore.setState(INITIAL, true);
	invoke.mockReset().mockImplementation(async (channel: string, projectDir: string) => answer(channel, projectDir));
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = { invoke };
	await state().loadConfig("/a");
	await state().loadRuns("/a");
});

describe("the project's config and runs", () => {
	it("loads them", () => {
		expect(invoke).toHaveBeenCalledWith("cicdTriggers:getConfig", "/a");
		expect(invoke).toHaveBeenCalledWith("cicdTriggers:listRuns", "/a", 50);
		expect(state()).toMatchObject({ config: { project: "/a" }, runs: [{ id: "/a-run" }], isLoading: false, error: null });
	});

	it("says why they could not be read", async () => {
		invoke.mockResolvedValueOnce({ success: false, error: "no .env" });
		await state().loadConfig("/a");
		expect(state()).toMatchObject({ error: "no .env", isLoading: false });
		invoke.mockResolvedValueOnce({ success: false });
		await state().loadConfig("/a");
		expect(state().error).toBe("Failed to load CI/CD config");
		invoke.mockRejectedValueOnce(new Error("ipc closed"));
		await state().loadConfig("/a");
		expect(state().error).toBe("Error: ipc closed");

		invoke.mockResolvedValueOnce({ success: false, error: "corrupt" });
		await state().loadRuns("/a", 10);
		expect(state().error).toBe("corrupt");
		invoke.mockResolvedValueOnce({ success: false });
		await state().loadRuns("/a");
		expect(state().error).toBe("Failed to load runs");
		invoke.mockRejectedValueOnce(new Error("x"));
		await state().loadRuns("/a");
		expect(state().error).toBe("Error: x");
		state().clearError();
		expect(state().error).toBeNull();
	});

	it("drops the last project's config and runs at once on another project", async () => {
		const slow = deferred();
		invoke.mockReturnValueOnce(slow.promise);
		const loading = state().loadConfig("/b");
		expect(state()).toMatchObject({ config: null, runs: [] });
		slow.resolve(answer("cicdTriggers:getConfig", "/b"));
		await loading;
		expect(state().config).toMatchObject({ project: "/b" });
	});

	it("drops every answer, or failure, for the project left behind", async () => {
		const config = deferred();
		const configFailing = deferred();
		const runs = deferred();
		const runsFailing = deferred();
		invoke
			.mockReturnValueOnce(config.promise)
			.mockReturnValueOnce(configFailing.promise)
			.mockReturnValueOnce(runs.promise)
			.mockReturnValueOnce(runsFailing.promise);
		const pending = [state().loadConfig("/a"), state().loadConfig("/a"), state().loadRuns("/a"), state().loadRuns("/a")];
		await state().loadConfig("/b");
		config.resolve(answer("cicdTriggers:getConfig", "/a"));
		configFailing.reject(new Error("late"));
		runs.resolve(answer("cicdTriggers:listRuns", "/a"));
		runsFailing.reject(new Error("late"));
		await Promise.all(pending);
		expect(state()).toMatchObject({ config: { project: "/b" }, runs: [], error: null, isLoading: false });
	});
});

describe("saving the config", () => {
	it("sends every value as text and shows it once written", async () => {
		await state().setConfig("/a", { enabled: false, github_workflow: "ci.yml" });
		expect(invoke).toHaveBeenCalledWith("cicdTriggers:setConfig", "/a", { enabled: "false", github_workflow: "ci.yml" });
		expect(state().config).toMatchObject({ provider: "github", enabled: false, github_workflow: "ci.yml" });
	});

	it("starts a config from what was saved when there was none", async () => {
		useCICDTriggersStore.setState({ config: null });
		await state().setConfig("/a", { provider: "gitlab" });
		expect(state().config).toEqual({ provider: "gitlab" });
	});

	it("does not show values the main process refused to write", async () => {
		invoke.mockResolvedValueOnce({ success: false, error: "unknown key" });
		await state().setConfig("/a", { enabled: false });
		expect(state()).toMatchObject({ config: { enabled: true }, error: "unknown key" });
		invoke.mockResolvedValueOnce(undefined);
		await state().setConfig("/a", { enabled: false });
		expect(state()).toMatchObject({ config: { enabled: true }, error: "Failed to save CI/CD config" });
		invoke.mockRejectedValueOnce(new Error("disk full"));
		await state().setConfig("/a", { enabled: false });
		expect(state()).toMatchObject({ config: { enabled: true }, error: "Error: disk full" });
	});

	it("does not merge a save of the project left behind into the one on screen", async () => {
		const slow = deferred();
		invoke.mockReturnValueOnce(slow.promise);
		const saving = state().setConfig("/a", { provider: "jenkins" });
		await state().loadConfig("/b");
		slow.resolve({ success: true });
		await saving;
		expect(state().config).toMatchObject({ provider: "github", project: "/b" });
	});
});

describe("triggering a pipeline", () => {
	it("triggers it and reads the runs again", async () => {
		invoke.mockClear();
		const pending = state().triggerPipeline("/a", { provider: "github", prUrl: "https://example.test/pr/1", branch: "main", workflow: "ci.yml" });
		expect(state().isTriggering).toBe(true);
		expect(await pending).toEqual({ success: true });
		expect(invoke).toHaveBeenCalledWith("cicdTriggers:trigger", "/a", {
			provider: "github",
			pr_url: "https://example.test/pr/1",
			branch: "main",
			workflow: "ci.yml",
		});
		expect(invoke).toHaveBeenCalledWith("cicdTriggers:listRuns", "/a", 50);
		expect(state().isTriggering).toBe(false);
	});

	it("says why it could not trigger", async () => {
		invoke.mockResolvedValueOnce({ success: false, error: "no token" });
		expect(await state().triggerPipeline("/a", { provider: "github" })).toEqual({ success: false, error: "no token" });
		invoke.mockResolvedValueOnce({ success: false });
		expect(await state().triggerPipeline("/a", { provider: "github" })).toEqual({ success: false, error: "Trigger failed" });
		invoke.mockRejectedValueOnce(new Error("x"));
		expect(await state().triggerPipeline("/a", { provider: "github" })).toEqual({ success: false, error: "Error: x" });
		expect(state()).toMatchObject({ error: "Error: x", isTriggering: false });
	});
});
