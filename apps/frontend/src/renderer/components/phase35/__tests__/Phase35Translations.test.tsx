/** @vitest-environment jsdom */
/**
 * The "Fonctions avancées" panels show the values the backend sends (domain
 * tags, severities, licence categories, violation types…) in the app's
 * language. They used to print the backend's English as is, so a French UI
 * listed "Generic", "Healthcare", "unknown", "approved".
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
	useCicdAnomalyStore.setState({ signals: [], report: null, phase: "idle", error: null });
	useAgentHealthStore.setState({ health: null, projectPath: null, phase: "idle", error: null });
	useLicenseStore.setState({ report: null, online: null, phase: "idle", error: null });
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

	it("words each CI fix in French from its id and shows the fixes that recur across builds", async () => {
		const signal = {
			kind: "dependency_conflict",
			severity: "high" as const,
			matching_line: "error NU1605: Detected package downgrade: Serilog from 4.0.0 to 3.1.1",
			line_number: 7,
			suggested_fix: "Reference the package version NuGet asks for directly.",
			fix_id: "nuget_conflict",
			log_label: "Build 1",
		};
		const analyseCicdLogs = vi.fn().mockResolvedValue({
			success: true,
			report: {
				signals: [signal, { ...signal, log_label: "Build 2" }],
				recurring_kinds: ["dependency_conflict"],
				summary: { samples: 2, total_signals: 2, by_kind: {}, by_severity: {} },
				fix_recommendations: ["[recurring] Reference the package version NuGet asks for directly."],
				recommendations: [
					{
						kind: "dependency_conflict",
						fix_id: "nuget_conflict",
						suggested_fix: signal.suggested_fix,
						recurring: true,
					},
				],
				has_critical: false,
			},
		});
		(globalThis as unknown as { electronAPI: Record<string, unknown> }).electronAPI.analyseCicdLogs =
			analyseCicdLogs;
		render(<CicdAnomalyPanel />);
		fireEvent.change(screen.getByLabelText("Contenu du log"), { target: { value: "log one" } });
		fireEvent.click(screen.getByRole("button", { name: "Ajouter le log d'un autre build" }));
		fireEvent.change(screen.getByLabelText("Build 2"), { target: { value: "log two" } });
		fireEvent.click(screen.getByRole("button", { name: "Scanner" }));
		expect(await screen.findByText("revient")).toBeInTheDocument();
		expect(analyseCicdLogs).toHaveBeenCalledWith([
			{ label: "Build 1", text: "log one" },
			{ label: "Build 2", text: "log two" },
		]);
		expect(screen.getAllByText(/Référencez directement la version que NuGet demande/)).toHaveLength(3);
		expect(screen.getByText("Build 2, ligne 7")).toBeInTheDocument();
		expect(screen.queryByText(/Reference the package version/)).not.toBeInTheDocument();
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

	it("keeps licences it could not find apart from real conflicts", () => {
		const dep = (name: string, licence: string | null) => ({
			name,
			version: "1.0.0",
			ecosystem: "nuget",
			declared_license: licence,
		});
		useLicenseStore.setState({
			online: false,
			report: {
				dependencies: [
					{ ...dep("MediatR", "Apache-2.0"), is_direct: true, license_source: "installed" },
					{ ...dep("Internal.Lib", null), is_direct: true, license_source: "" },
				],
				conflicts: [
					{ dependency: dep("Internal.Lib", null), category: "unknown", reason: "", remediation: "" },
				],
				by_category: { permissive: 1, unknown: 1 },
				summary: { by_ecosystem: { nuget: 2 }, by_source: { installed: 1 }, unresolved: 1 },
				passed: false,
			},
		});
		render(<LicensePanel projectPath="/p" />);
		// Nothing breaks the policy: only one licence is left to check.
		expect(screen.getByText("Licences à vérifier")).toBeInTheDocument();
		expect(screen.queryByText("Conflits trouvés")).not.toBeInTheDocument();
		expect(screen.getByText("1 dépendance dont la licence est introuvable")).toBeInTheDocument();
		expect(screen.getByText("1 lue dans le paquet installé")).toBeInTheDocument();
		expect(screen.getByText(/Les registres n’ont pas été interrogés/)).toBeInTheDocument();
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

	it("words layer and domain rules in French from the backend's structured fields", () => {
		useArchDriftStore.setState({
			configSource: "inferred",
			scanReport: {
				status: "approved",
				violations: [],
				warnings: [
					{
						type: "layer_violation",
						severity: "warning",
						file: "src/Shop.Domain/Order.cs",
						line: 2,
						import_target: "Shop.Infrastructure.Persistence",
						rule: "Layer 'domain' cannot import from 'infrastructure'",
						source_layer: "domain",
						target_layer: "infrastructure",
					},
					{
						type: "forbidden_import",
						severity: "warning",
						file: "src/Shop.Domain/User.cs",
						line: 3,
						import_target: "Microsoft.EntityFrameworkCore",
						rule: "The domain layer must not depend on a persistence or web framework",
						rule_id: "domain_framework",
					},
				],
				violation_count: 0,
				warning_count: 2,
				summary: "",
			},
		});
		render(<ArchDriftPanel projectPath="/p" />);
		expect(
			screen.getByText("La couche « Domaine » ne doit pas dépendre de la couche « Infrastructure »."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Le domaine ne doit dépendre d’aucun framework de persistance ou web."),
		).toBeInTheDocument();
		expect(screen.queryByText(/cannot import/)).not.toBeInTheDocument();
		expect(screen.getByText(/Imports lus pour \.NET/)).toBeInTheDocument();
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
