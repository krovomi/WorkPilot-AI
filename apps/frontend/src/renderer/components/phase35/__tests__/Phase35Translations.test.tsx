/** @vitest-environment jsdom */
/**
 * The "Fonctions avancées" panels show the values the backend sends (domain
 * tags, severities, licence categories, violation types…) in the app's
 * language. They used to print the backend's English as is, so a French UI
 * listed "Generic", "Healthcare", "unknown", "approved".
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import {
	useAgentHealthStore,
	useArchDriftStore,
	useCicdAnomalyStore,
	useDomainAgentsStore,
	useLicenseStore,
} from "../../../stores/phase35-stores";
import { AgentHealthPanel } from "../AgentHealthPanel";
import { ArchDriftPanel } from "../ArchDriftPanel";
import { CicdAnomalyPanel } from "../CicdAnomalyPanel";
import { DomainAgentsPanel } from "../DomainAgentsPanel";
import { LicensePanel } from "../LicensePanel";

const DOMAINS = [
	{ tag: "generic", label: "Generic", description: "No domain assumptions — neutral defaults." },
	{ tag: "healthcare", label: "Healthcare", description: "EHR, PHI, HIPAA-aware data flows." },
	{ tag: "data_pipeline", label: "Data Pipeline", description: "ETL, batch jobs, data quality." },
];

beforeEach(async () => {
	await i18n.changeLanguage("fr");
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
		listDomains: vi.fn().mockResolvedValue({ success: true, domains: DOMAINS }),
	};
});

afterEach(() => {
	cleanup();
	useDomainAgentsStore.setState({ domains: [], bundle: null, phase: "idle", error: null });
	useCicdAnomalyStore.setState({ signals: [], phase: "idle", error: null });
	useAgentHealthStore.setState({ health: null, projectPath: null, phase: "idle", error: null });
	useLicenseStore.setState({ report: null, phase: "idle", error: null });
	useArchDriftStore.setState({
		scanReport: null,
		driftReport: null,
		configSource: null,
		baselineCount: null,
		phase: "idle",
		error: null,
	});
});

describe("Fonctions avancées in French", () => {
	it("names every domain in French, with its description", async () => {
		render(<DomainAgentsPanel />);
		expect(await screen.findByRole("option", { name: "Générique" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Santé" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Pipeline de données" })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: "Healthcare" })).not.toBeInTheDocument();
		expect(screen.getByText(/Aucune hypothèse de domaine/)).toBeInTheDocument();
	});

	it("scores agents from the project's tasks, by role and model, and lists those without enough phases", async () => {
		const scoreProjectAgentHealth = vi.fn().mockResolvedValue({
			success: true,
			tasks_read: 4,
			min_runs: 3,
			scores: [
				{
					agent_name: "coder:anthropic:claude-sonnet-5-5",
					role: "coder",
					provider: "anthropic",
					model: "claude-sonnet-5-5",
					score: 52,
					status: "failing",
					success_rate: 0.5,
					error_rate: 0.5,
					retry_rate: 0.25,
					slowness_ratio: 1,
					trend: "degrading",
					runs_in_window: 4,
					actions: ["reduce_parallelism"],
					diagnostics: {},
				},
			],
			pending: [{ agent_name: "qa:-:-", role: "qa", provider: "", model: "", runs: 1 }],
		});
		(globalThis as unknown as { electronAPI: Record<string, unknown> }).electronAPI.scoreProjectAgentHealth =
			scoreProjectAgentHealth;
		render(<AgentHealthPanel projectPath="/work/api" />);
		expect(await screen.findByText("Codeur")).toBeInTheDocument();
		expect(scoreProjectAgentHealth).toHaveBeenCalledWith("/work/api");
		expect(screen.getByText("anthropic · claude-sonnet-5-5")).toBeInTheDocument();
		expect(screen.getByText("défaillant")).toBeInTheDocument();
		expect(screen.getByText("Réduire le parallélisme")).toBeInTheDocument();
		expect(screen.getByText(/Lu dans 4 tâches du projet/)).toBeInTheDocument();
		expect(screen.getByText(/il en faut 3/)).toBeInTheDocument();
		expect(screen.getByText("QA")).toBeInTheDocument();
		expect(screen.getByText("modèle non indiqué dans les logs")).toBeInTheDocument();
		expect(screen.getByText("1 phase")).toBeInTheDocument();
	});

	it("asks for a project instead of showing an empty monitor", () => {
		render(<AgentHealthPanel />);
		expect(screen.getByText(/Ouvrez un projet/)).toBeInTheDocument();
	});

	it("translates a CI signal's kind and severity", () => {
		useCicdAnomalyStore.setState({
			signals: [
				{
					kind: "dependency_conflict",
					severity: "high",
					matching_line: "npm ERR! ERESOLVE unable to resolve dependency tree",
					line_number: 12,
					suggested_fix: "Pin the conflicting peer dep.",
					log_label: "",
				},
			],
		});
		render(<CicdAnomalyPanel />);
		expect(screen.getByText("Conflit de dépendances")).toBeInTheDocument();
		expect(screen.getByText("élevée")).toBeInTheDocument();
		expect(screen.queryByText("dependency_conflict")).not.toBeInTheDocument();
	});

	it("translates a licence conflict's category and remediation", () => {
		useLicenseStore.setState({
			report: {
				dependencies: [{ name: "left-pad", version: "1.0.0", ecosystem: "npm", declared_license: null }],
				conflicts: [
					{
						dependency: { name: "left-pad", version: "1.0.0", ecosystem: "npm", declared_license: null },
						category: "unknown",
						reason: "License None (category=unknown) is not in the project's allowed set.",
						remediation: "Look up the upstream licence and add it to the policy.",
					},
				],
				by_category: { unknown: 1 },
				summary: {},
				passed: false,
			},
		} as never);
		render(<LicensePanel projectPath="/p" />);
		expect(screen.getByText("Inconnue")).toBeInTheDocument();
		expect(screen.getByText(/Chercher la licence en amont/)).toBeInTheDocument();
		expect(screen.queryByText(/Look up the upstream/)).not.toBeInTheDocument();
	});

	it("shows the architecture verdict in French and lists each violation", () => {
		useArchDriftStore.setState({
			configSource: "inferred",
			scanReport: {
				status: "rejected",
				violations: [
					{
						type: "layer_violation",
						severity: "error",
						file: "src/Api/Controllers/OrderController.cs",
						line: 7,
						import_target: "Shop.Infrastructure.Persistence",
						rule: "api -> infrastructure",
						description: "Layer 'api' cannot import from 'infrastructure'",
					},
				],
				warnings: [],
				violation_count: 1,
				warning_count: 0,
				summary: "",
				files_analyzed: 42,
			},
		});
		render(<ArchDriftPanel projectPath="/p" />);
		expect(screen.getByText("Violations trouvées")).toBeInTheDocument();
		expect(screen.queryByText("rejected")).not.toBeInTheDocument();
		expect(screen.getByText("Violation de couche")).toBeInTheDocument();
		expect(screen.getByText("src/Api/Controllers/OrderController.cs:7")).toBeInTheDocument();
		expect(screen.getByText(/Règles déduites de la stack détectée/)).toBeInTheDocument();
		expect(screen.getByText("42 fichiers analysés")).toBeInTheDocument();
	});

	it("says there is no baseline instead of showing an empty drift", () => {
		useArchDriftStore.setState({
			driftReport: {
				has_baseline: false,
				severity: "none",
				new_violations: [],
				resolved_violations: [],
				persistent_violations: [],
				summary: {},
			},
		});
		render(<ArchDriftPanel projectPath="/p" />);
		expect(screen.getByText(/Aucune référence enregistrée/)).toBeInTheDocument();
		expect(screen.queryByText("Nouvelles violations")).not.toBeInTheDocument();
	});
});
