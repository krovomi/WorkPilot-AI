/** @vitest-environment jsdom */
/**
 * The style profile on the Coach page (#376), in French: what the history
 * says per language, a choice by hand that is saved, and a task in review
 * checked against the profile.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { CoachProfileState } from "../../../../shared/types/agent-coach";
import { useTaskStore } from "../../../stores/task-store";
import { CoachProfilePanel } from "../CoachProfilePanel";

const STATE: CoachProfileState = {
	profile: {
		version: 1,
		builtAt: 1_800_000_000,
		commits: { gold: 12, accepted: 4, corrected: 1, team: 3, agent: 0 },
		hasEmail: true,
		lint: ["pyproject.toml"],
		languages: {
			python: {
				naming_functions: { value: "snake_case", share: 0.95, weight: 20, state: "preferred", source: "history" },
				comments: { value: "none", share: 0.5, weight: 8, state: "indifferent", source: "history" },
			},
		},
		metrics: {
			withCoach: { merged: 4, keptAsIs: 3, rate: 75 },
			withoutCoach: { merged: 2, keptAsIs: 1, rate: 50 },
			dimensionsPreferred: 1,
		},
	},
	preferences: { enabled: true, overrides: {} },
	effective: { python: { naming_functions: "snake_case" } },
	injected: true,
};

const api = {
	getCoachProfile: vi.fn(),
	buildCoachProfile: vi.fn(),
	setCoachPreferences: vi.fn(),
	exportCoachProfile: vi.fn(),
	importCoachProfile: vi.fn(),
	checkCoachTask: vi.fn(),
};

beforeEach(async () => {
	vi.clearAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	api.getCoachProfile.mockResolvedValue(STATE);
	useTaskStore.setState({ tasks: [] });
	await i18n.changeLanguage("fr");
});

afterEach(cleanup);

describe("CoachProfilePanel", () => {
	it("shows what the history says, and says an indifferent dimension is not given", async () => {
		render(<CoachProfilePanel projectPath="/p" />);
		expect(await screen.findByText("Python")).toBeInTheDocument();
		expect(screen.getAllByText("snake_case").length).toBeGreaterThan(0);
		expect(screen.getByText("Indifférent")).toBeInTheDocument();
		expect(screen.getByText(/75 % avec votre profil \(4\), 50 % sans \(2\)/)).toBeInTheDocument();
		expect(screen.getByText(/Le codeur et le correcteur QA reçoivent ces préférences/)).toBeInTheDocument();
	});

	it("saves a choice made by hand", async () => {
		api.setCoachPreferences.mockResolvedValue(STATE);
		render(<CoachProfilePanel projectPath="/p" />);
		const select = await screen.findByRole("combobox", { name: "Votre choix pour Noms de fonctions" });
		fireEvent.change(select, { target: { value: "camelCase" } });
		await waitFor(() =>
			expect(api.setCoachPreferences).toHaveBeenCalledWith({
				projectPath: "/p",
				preferences: { enabled: true, overrides: { python: { naming_functions: "camelCase" } } },
			}),
		);
	});

	it("checks a task in review against the profile", async () => {
		useTaskStore.setState({
			tasks: [{ id: "t1", specId: "003-login", title: "Connexion", status: "human_review" } as never],
		});
		api.checkCoachTask.mockResolvedValue({
			spec: "003-login",
			deviations: [{ language: "python", dimension: "naming_functions", expected: "snake_case", found: "camelCase", count: 3 }],
		});
		render(<CoachProfilePanel projectPath="/p" />);
		fireEvent.change(await screen.findByRole("combobox", { name: "Tâche à vérifier" }), {
			target: { value: "003-login" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Vérifier$/ }));
		expect(
			await screen.findByText("Python · Noms de fonctions : camelCase (3×), votre profil dit snake_case"),
		).toBeInTheDocument();
		expect(api.checkCoachTask).toHaveBeenCalledWith({ projectPath: "/p", spec: "003-login" });
	});

	it("offers to build a profile when there is none", async () => {
		api.getCoachProfile.mockResolvedValue({ ...STATE, profile: null, effective: {}, injected: false });
		api.buildCoachProfile.mockResolvedValue(STATE);
		render(<CoachProfilePanel projectPath="/p" />);
		expect(await screen.findByText(/Pas encore de profil/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Construire depuis mon historique/ }));
		await waitFor(() => expect(api.buildCoachProfile).toHaveBeenCalledWith({ projectPath: "/p" }));
		expect(await screen.findByText("Python")).toBeInTheDocument();
	});
});
