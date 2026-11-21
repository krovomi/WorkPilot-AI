/** @vitest-environment jsdom */
/**
 * The recorder tab (#387), in French: start and stop, the steps with a
 * secret shown by its variable only, removing a step, the format, the three
 * exports and what each one gives back.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { RecordedStep, RecorderExportOutcome } from "../../../../shared/types/browser-recorder";
import { useBrowserAgentStore } from "../../../stores/browser-agent-store";
import { useBrowserRecorderStore } from "../../../stores/browser-recorder-store";
import { BrowserAgentDashboard } from "../BrowserAgentDashboard";
import { RecorderTab, selectorSummary } from "../RecorderTab";

vi.mock("../../generated-review/GeneratedReviewBanner", () => ({
	GeneratedReviewBanner: ({ review }: { review: { branch: string } }) => <p>{review.branch}</p>,
}));
const project = vi.hoisted(() => ({ id: "p1" as string | null }));
vi.mock("../../../stores/project-store", () => ({
	useProjectStore: (select: (s: unknown) => unknown) =>
		select({ selectedProjectId: project.id, getSelectedProject: () => ({ path: "/projects/app" }) }),
}));

const STEPS: RecordedStep[] = [
	{ id: "s1", kind: "navigate", selectors: [], url: "http://localhost:3000/" },
	{ id: "s2", kind: "fill", selectors: [{ strategy: "label", value: "E-mail" }], value: "ada@x.io" },
	{ id: "s3", kind: "fill", selectors: [{ strategy: "label", value: "Mot de passe" }], secretEnv: "E2E_PASSWORD" },
	{ id: "s4", kind: "press", selectors: [{ strategy: "css", value: "#pw" }], key: "Enter" },
	{ id: "s5", kind: "assert_text", selectors: [{ strategy: "role", role: "heading", value: "Bienvenue" }], text: "Bienvenue" },
	{ id: "s6", kind: "click", selectors: [{ strategy: "text", value: "Déconnexion" }] },
];

const api = {
	startBrowserRecording: vi.fn(async () => ({ success: true })),
	stopBrowserRecording: vi.fn(async () => ({ success: true })),
	exportBrowserRecording: vi.fn(async (): Promise<RecorderExportOutcome> => ({ success: true, code: "test()" })),
	onBrowserRecorderEvent: vi.fn(),
	invoke: vi.fn(async () => ({ success: false })),
};

const initial = useBrowserRecorderStore.getState();

beforeEach(async () => {
	await i18n.changeLanguage("fr");
	useBrowserRecorderStore.setState(initial, true);
	useBrowserAgentStore.setState({ currentUrl: "http://localhost:3000", activeTab: "browser" });
	(globalThis as unknown as { electronAPI: typeof api }).electronAPI = api;
	vi.clearAllMocks();
});
afterEach(cleanup);

describe("selectorSummary", () => {
	it("names the first selector, or the address of a navigation", () => {
		expect(selectorSummary(STEPS[0])).toBe("http://localhost:3000/");
		expect(selectorSummary(STEPS[4])).toBe('heading "Bienvenue"');
		expect(selectorSummary(STEPS[1])).toBe('label "E-mail"');
		expect(selectorSummary({ id: "s9", kind: "click", selectors: [] })).toBe("");
	});
});

describe("RecorderTab", () => {
	it("starts a recording from the browser's address, then stops it", async () => {
		render(<RecorderTab projectPath="/projects/app" />);
		expect(screen.getByText(/Aucune étape pour l'instant/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
		expect(api.startBrowserRecording).toHaveBeenCalledWith("/projects/app", "http://localhost:3000");

		useBrowserRecorderStore.setState({ status: "recording" });
		expect(await screen.findByText("Enregistrement : agissez dans la fenêtre du navigateur")).toBeInTheDocument();
		expect(screen.getByLabelText("Adresse de départ de l'enregistrement")).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Arrêter" }));
		expect(api.stopBrowserRecording).toHaveBeenCalled();
	});

	it("needs an address to record from", () => {
		render(<RecorderTab projectPath="/projects/app" />);
		fireEvent.change(screen.getByLabelText("Adresse de départ de l'enregistrement"), { target: { value: " " } });
		expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
	});

	it("lists the steps, a secret by its variable only, and removes one", () => {
		useBrowserRecorderStore.setState({ steps: STEPS, truncated: true, error: "Pas d'affichage" });
		render(<RecorderTab projectPath="/projects/app" />);
		expect(screen.getByRole("alert")).toHaveTextContent("Pas d'affichage");
		expect(screen.getByText(/limite de 300 étapes/)).toBeInTheDocument();
		expect(screen.getByText("ada@x.io")).toBeInTheDocument();
		expect(screen.getByText("secret, lu dans E2E_PASSWORD")).toBeInTheDocument();
		expect(screen.getByText("Enter")).toBeInTheDocument();
		expect(screen.getAllByText("Bienvenue")).toHaveLength(1);
		expect(screen.getByText("Vérifier le texte")).toBeInTheDocument();
		fireEvent.click(screen.getAllByRole("button", { name: "Retirer cette étape" })[5]);
		expect(useBrowserRecorderStore.getState().steps.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
	});

	it("notes where a step's element lives and what its replay waits for", () => {
		useBrowserRecorderStore.setState({
			steps: [
				{
					id: "s1",
					kind: "click",
					selectors: [{ strategy: "text", value: "Payer" }],
					frames: ["#pay"],
					shadow: ["x-card"],
					waitVisible: true,
					waitRequest: { method: "POST", path: "/api/pay" },
					waitUrl: "http://a.test/merci",
				},
				{ id: "s2", kind: "click", selectors: [{ strategy: "text", value: "Fin" }] },
			],
		});
		render(<RecorderTab projectPath="/projects/app" />);
		expect(screen.getAllByTestId("step-notes")).toHaveLength(1);
		for (const note of [
			"dans un cadre",
			"dans un shadow root",
			"attend son affichage",
			"attend POST /api/pay",
			"attend http://a.test/merci",
		]) {
			expect(screen.getByText(note)).toBeInTheDocument();
		}
	});

	it("exports in the chosen format and shows what each export gave back", async () => {
		useBrowserRecorderStore.setState({ steps: STEPS });
		render(<RecorderTab projectPath="/projects/app" />);
		fireEvent.change(screen.getByLabelText("Nom du test"), { target: { value: "Connexion" } });
		fireEvent.click(screen.getByRole("tab", { name: "Cypress" }));
		fireEvent.click(screen.getByRole("button", { name: "Aperçu" }));
		await waitFor(() => expect(screen.getByText("test()")).toBeInTheDocument());
		expect(api.exportBrowserRecording).toHaveBeenCalledWith("/projects/app", {
			format: "cypress",
			destination: "preview",
			name: "Connexion",
			stepIds: ["s1", "s2", "s3", "s4", "s5", "s6"],
		});

		api.exportBrowserRecording.mockResolvedValueOnce({
			success: true,
			path: "e2e/connexion.spec.ts",
			envVars: ["E2E_PASSWORD"],
			skipped: 2,
			review: {
				taskId: "007",
				specId: "007",
				title: "t",
				branch: "workpilot/007-test",
				baseBranch: "develop",
				files: [],
				committed: true,
				reused: false,
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "Proposer sur une carte de revue" }));
		expect(await screen.findByText("workpilot/007-test")).toBeInTheDocument();
		expect(screen.getByText(/Définissez ces variables d'environnement.*E2E_PASSWORD/)).toBeInTheDocument();
		expect(screen.getByText(/2 étape\(s\) sans sélecteur/)).toBeInTheDocument();
		expect(screen.queryByText(/Enregistré dans/)).not.toBeInTheDocument();

		api.exportBrowserRecording.mockResolvedValueOnce({ success: true, path: "/out/connexion.cy.js", envVars: [] });
		fireEvent.click(screen.getByRole("button", { name: "Enregistrer dans un fichier…" }));
		expect(await screen.findByText("Enregistré dans /out/connexion.cy.js")).toBeInTheDocument();

		api.exportBrowserRecording.mockResolvedValueOnce({ success: true, path: "/out/x.js", cancelled: true });
		fireEvent.click(screen.getByRole("button", { name: "Enregistrer dans un fichier…" }));
		await waitFor(() => expect(screen.queryByText(/Enregistré dans/)).not.toBeInTheDocument());
	});

	it("is a tab of the Browser Agent", async () => {
		project.id = null;
		useBrowserAgentStore.setState({ activeTab: "recorder" });
		render(<BrowserAgentDashboard />);
		expect(await screen.findByText("Enregistreur")).toBeInTheDocument();
		expect(await screen.findByRole("button", { name: "Enregistrer" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("tab", { name: "Tests E2E" }));
		await waitFor(() => expect(screen.queryByLabelText("Nom du test")).not.toBeInTheDocument());
		project.id = "p1";
	});
});
