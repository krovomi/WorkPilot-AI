/** @vitest-environment jsdom */
/**
 * The rewrite of a branch (#360), in French: the plan before and after, a step
 * put back as it was, the replay on a new branch, the merged branches deleted.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { RewritePlan } from "../../../../shared/types/git-surgeon";
import { undoStep, useGitRewriteStore } from "../../../stores/git-rewrite-store";
import { conformsTo, readabilityOf } from "../conventions";
import { GitBranchesPanel } from "../GitBranchesPanel";
import { GitRewritePanel } from "../GitRewritePanel";

const sha = (c: string) => c.repeat(40);
const commit = (c: string, subject: string) => ({
	sha: sha(c),
	subject,
	body: "",
	message: subject,
	author: "Ana",
	date: "2026-11-01T00:00:00+00:00",
	files: ["src/auth/a.py"],
	fileCount: 1,
	lines: 3,
	signed: false,
	merge: false,
});

const PLAN: RewritePlan = {
	base: sha("0"),
	head: sha("c"),
	branch: "feature",
	convention: { kind: "conventional", source: "history", pattern: "" },
	before: { conforming: 0, total: 3, percent: 0 },
	after: { conforming: 2, total: 2, percent: 100 },
	commits: [commit("a", "add login"), commit("b", "wip"), commit("c", "update")],
	plan: [
		{ id: "p1", kind: "squash", sources: [sha("a"), sha("b")], message: "feat(auth): add login", reason: "fixups", paths: [], author: "Ana", conforms: true },
		{ id: "p2", kind: "reword", sources: [sha("c")], message: "chore(auth): update a", reason: "vague", paths: [], author: "Ana", conforms: true },
	],
	keptCommits: 0,
	warnings: [{ code: "pushed", count: 3, remotes: ["origin/feature"] }],
	blocked: "",
	messagesBy: "rules",
	modelMessages: 0,
};

const api = {
	planGitRewrite: vi.fn(),
	applyGitRewrite: vi.fn(),
	listGitBranches: vi.fn(),
	deleteMergedBranches: vi.fn(),
	gitSurgeonHistory: vi.fn(),
};

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockReset();
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	api.planGitRewrite.mockResolvedValue(PLAN);
	api.gitSurgeonHistory.mockResolvedValue({ months: [{ month: "2026-11", runs: 1, squash: 1, reword: 1, split: 0, readability: 100 }] });
	api.listGitBranches.mockResolvedValue({
		defaultBranch: "main",
		branches: [
			{ name: "done", lastCommitAt: "", ageDays: 120, upstream: "", gone: true, merged: true, stale: true, current: false, protected: false, checkedOut: false, suggestedName: "feat/done" },
			{ name: "feature", lastCommitAt: "", ageDays: 0, upstream: "", gone: false, merged: false, stale: false, current: true, protected: false, checkedOut: false, suggestedName: "feat/feature" },
		],
	});
	useGitRewriteStore.getState().reset();
	useGitRewriteStore.setState({ base: "", ai: false, branches: null, deletion: null, months: [] });
	await i18n.changeLanguage("fr");
});

afterEach(cleanup);

describe("GitRewritePanel", () => {
	it("shows the plan, puts a squash back as it was and replays it on a new branch", async () => {
		api.applyGitRewrite.mockResolvedValue({
			branch: "surgeon/feature-20261110-101010",
			head: sha("d"),
			base: sha("0"),
			source: sha("c"),
			commits: 3,
			kept: 0,
			treeMatches: true,
			counts: { keep: 2, reword: 1, squash: 0, split: 0 },
			before: { conforming: 0, total: 3, percent: 0 },
			after: { conforming: 1, total: 3, percent: 33 },
		});
		render(<GitRewritePanel projectPath="/p" />);
		fireEvent.click(screen.getByRole("checkbox", { name: /Rédiger les messages avec le modèle/ }));
		fireEvent.click(screen.getByRole("button", { name: /Préparer la réécriture/ }));
		expect(await screen.findByText("feat(auth): add login")).toBeInTheDocument();
		expect(api.planGitRewrite).toHaveBeenCalledWith({ projectPath: "/p", base: undefined, ai: true });
		expect(screen.getByText(/push forcé, ce que WorkPilot ne fait jamais/)).toBeInTheDocument();
		expect(screen.getByText("Regroupé")).toBeInTheDocument();

		fireEvent.click(screen.getAllByRole("button", { name: /Garder tel quel/ })[0]);
		expect(useGitRewriteStore.getState().steps.map((s) => s.kind)).toEqual(["keep", "keep", "reword"]);

		fireEvent.click(screen.getByRole("button", { name: /Créer la branche nettoyée/ }));
		await waitFor(() => expect(api.applyGitRewrite).toHaveBeenCalled());
		const sent = api.applyGitRewrite.mock.calls[0][0];
		expect(sent.plan.plan.map((s: { sources: string[] }) => s.sources)).toEqual([[sha("a")], [sha("b")], [sha("c")]]);
		expect(await screen.findByText(/Branche surgeon\/feature-20261110-101010 créée/)).toBeInTheDocument();
	});

	it("scores an edited message with the convention", () => {
		const steps = [...PLAN.plan];
		expect(readabilityOf(steps, PLAN)).toBe(100);
		steps[1] = { ...steps[1], message: "stuff" };
		expect(readabilityOf(steps, PLAN)).toBe(50);
		expect(conformsTo("fix(auth): token race", PLAN.convention)).toBe(true);
		expect(conformsTo("x", { kind: "custom", source: "project", pattern: "^X" })).toBe(false);
		expect(conformsTo("X-1 login", { kind: "custom", source: "project", pattern: "^X" })).toBeNull();
		expect(undoStep(PLAN.plan, PLAN, "p2")[1]).toMatchObject({ kind: "keep", message: "update" });
	});
});

describe("GitBranchesPanel", () => {
	it("deletes only the merged branches chosen", async () => {
		api.deleteMergedBranches.mockResolvedValue({ deleted: ["done"], refused: {} });
		render(<GitBranchesPanel projectPath="/p" />);
		const box = await screen.findByRole("checkbox", { name: "Choisir done" });
		expect(screen.queryByRole("checkbox", { name: "Choisir feature" })).toBeNull();
		expect(screen.getByText("→ feat/done")).toBeInTheDocument();
		expect(screen.getByText("2026-11")).toBeInTheDocument();
		fireEvent.click(box);
		fireEvent.click(screen.getByRole("button", { name: /Supprimer 1 branche fusionnée/ }));
		await waitFor(() => expect(api.deleteMergedBranches).toHaveBeenCalledWith({ projectPath: "/p", names: ["done"] }));
		expect(await screen.findByText(/1 branche supprimée/)).toBeInTheDocument();
	});
});
