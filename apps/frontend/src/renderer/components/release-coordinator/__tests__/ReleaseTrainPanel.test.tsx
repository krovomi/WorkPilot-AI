/** @vitest-environment jsdom */
/**
 * The release train page (#362), in French: a file to approve before it runs
 * anything, the waves, a production service waiting for its click, and a
 * failure offering retry, rollback or stop.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { TrainRun, TrainState } from "../../../../shared/types/release-train";
import { useReleaseTrainStore } from "../../../stores/release-train-store";
import { ReleaseTrainPanel } from "../ReleaseTrainPanel";

const STATE: TrainState = {
	present: true,
	approved: false,
	view: {
		path: "release-train.yaml",
		sha256: "a".repeat(64),
		environments: [
			{ name: "staging", production: false },
			{ name: "production", production: true },
		],
		services: [
			{
				name: "auth",
				path: "services/auth",
				dependsOn: [],
				criticality: "high",
				external: false,
				steps: { deploy: { command: ["./deploy.sh", "{environment}"], url: "", timeout: 600, expectStatus: 200, retries: 3 } },
				passEnv: [],
			},
			{ name: "web", path: "", dependsOn: ["auth"], criticality: "normal", external: false, steps: {}, passEnv: [] },
		],
		order: { waves: [["auth"], ["web"]], cycle: [], suggestion: null, unknown: {} },
		flags: [],
		problems: [{ code: "no_deploy", service: "web" }],
		variables: ["AWS_PROFILE"],
		calendar: {
			slots: [
				{ service: "auth", environment: "production", at: "2026-11-12T14:00:00Z", end: "2026-11-12T15:00:00Z", minutes: 60, conflict: true },
			],
			conflicts: [[0, 1]],
		},
		runs: [],
	},
};

const item = (service: string, status: TrainRun["items"][number]["status"]) => ({
	service,
	wave: 0,
	version: "1.1.0",
	previousVersion: "1.0.0",
	external: false,
	confirm: true,
	confirmed: false,
	status,
	phase: "",
	steps: {},
	rollback: null,
	detail: "",
});

const RUN: TrainRun = {
	id: "rt-20261110-010203-abcdef",
	environment: "production",
	production: true,
	express: false,
	status: "waiting",
	createdAt: "2026-11-10T01:02:03+00:00",
	gateFailures: 0,
	blocked: null,
	warnings: [],
	items: [item("auth", "waiting_confirmation"), item("web", "pending")],
	flags: [],
	journal: [],
};

const api = {
	releaseTrainState: vi.fn(),
	releaseTrainMetrics: vi.fn(),
	approveReleaseTrain: vi.fn(),
	startReleaseTrain: vi.fn(),
	advanceReleaseTrain: vi.fn(),
	releaseTrainRun: vi.fn(),
	releaseTrainNotes: vi.fn(),
	onReleaseTrainEvent: vi.fn(() => () => undefined),
};

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockClear();
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	api.releaseTrainState.mockResolvedValue(STATE);
	api.releaseTrainMetrics.mockResolvedValue({ months: [] });
	useReleaseTrainStore.setState({ projectPath: "", state: null, run: null, error: null, busy: false, notes: null });
	await i18n.changeLanguage("fr");
});

afterEach(cleanup);

describe("ReleaseTrainPanel", () => {
	it("asks to approve the file, showing its commands, before it can start", async () => {
		api.approveReleaseTrain.mockResolvedValue(true);
		render(<ReleaseTrainPanel projectPath="/p" />);
		expect(await screen.findByText(/Approuvez ce fichier du train/)).toBeInTheDocument();
		expect(screen.getByText("./deploy.sh {environment}")).toBeInTheDocument();
		expect(screen.getByText(/AWS_PROFILE/)).toBeInTheDocument();
		expect(screen.getByText("web n'a pas de commande de déploiement.")).toBeInTheDocument();
		expect(screen.getByText("Vague 2")).toBeInTheDocument();
		expect(screen.getByText("Conflit")).toBeInTheDocument();
		expect(screen.queryByText("Lancer le train")).not.toBeInTheDocument();
		api.releaseTrainState.mockResolvedValue({ ...STATE, approved: true });
		fireEvent.click(screen.getByText("Approuver cette version"));
		await waitFor(() => expect(api.approveReleaseTrain).toHaveBeenCalledWith("/p", "a".repeat(64)));
		expect(await screen.findByText("Lancer le train")).toBeInTheDocument();
	});

	it("waits for a click before a production service, then offers the choices of a failure", async () => {
		api.releaseTrainState.mockResolvedValue({ ...STATE, approved: true });
		api.startReleaseTrain.mockResolvedValue(RUN);
		render(<ReleaseTrainPanel projectPath="/p" />);
		fireEvent.change(await screen.findByLabelText("Environnement"), { target: { value: "production" } });
		expect(screen.getByText(/chaque service attend votre clic/)).toBeInTheDocument();
		fireEvent.click(screen.getByText("Lancer le train"));
		await waitFor(() => expect(api.startReleaseTrain).toHaveBeenCalledWith({ projectPath: "/p", environment: "production" }));
		const go = await screen.findByText("Déployer auth");
		api.advanceReleaseTrain.mockResolvedValue({
			...RUN,
			status: "blocked",
			blocked: { kind: "service", name: "auth", step: "health", detail: "expected 200, got 503" },
			items: [{ ...item("auth", "failed"), steps: { health: { status: "failed", detail: "", exitCode: null, httpStatus: 503, attempts: 3, durationS: 9, output: "" } } }, item("web", "pending")],
		});
		fireEvent.click(go);
		await waitFor(() =>
			expect(api.advanceReleaseTrain).toHaveBeenCalledWith({ projectPath: "/p", runId: RUN.id, action: "confirm", target: "auth" }),
		);
		expect(await screen.findByText("auth : le contrôle de santé a échoué (expected 200, got 503).")).toBeInTheDocument();
		fireEvent.click(screen.getByText("Revenir en arrière sur la chaîne"));
		await waitFor(() =>
			expect(api.advanceReleaseTrain).toHaveBeenLastCalledWith({ projectPath: "/p", runId: RUN.id, action: "rollback", target: "auth" }),
		);
	});

	it("explains how to write a train file when there is none", async () => {
		api.releaseTrainState.mockResolvedValue({ present: false, approved: false });
		render(<ReleaseTrainPanel projectPath="/p" />);
		expect(await screen.findByText("Pas encore de fichier du train")).toBeInTheDocument();
	});
});
