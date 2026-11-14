/** @vitest-environment jsdom */
/**
 * The "Fonctions avancées" panels show the values the backend sends (domain
 * tags, severities, licence categories, violation types…) in the app's
 * language. They used to print the backend's English as is, so a French UI
 * listed "Generic", "Healthcare", "unknown", "approved".
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import {
	useArchDriftStore,
	useCicdAnomalyStore,
	useDomainAgentsStore,
	useLicenseStore,
	useModelRouterStore,
} from "../../../stores/phase35-stores";
import { ArchDriftPanel } from "../ArchDriftPanel";
import { CicdAnomalyPanel } from "../CicdAnomalyPanel";
import { DomainAgentsPanel } from "../DomainAgentsPanel";
import { LicensePanel } from "../LicensePanel";
import { ModelRouterPanel } from "../ModelRouterPanel";

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
	useDomainAgentsStore.setState({
		domains: [],
		bundle: null,
		phase: "idle",
		error: null,
		projectPath: null,
		projectDomain: null,
		projectLanguages: [],
	});
	useCicdAnomalyStore.setState({ signals: [], phase: "idle", error: null });
	useLicenseStore.setState({ report: null, phase: "idle", error: null });
	useModelRouterStore.setState({ chosen: null, comparison: null, phase: "idle", error: null });
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

	it("shows the project's domain and stacks, and applies the chosen domain to the project", async () => {
		const setProjectDomain = vi.fn().mockResolvedValue({ success: true, domain: "data_pipeline" });
		const api = (globalThis as unknown as { electronAPI: Record<string, unknown> }).electronAPI;
		api.getProjectDomain = vi
			.fn()
			.mockResolvedValue({ success: true, domain: "healthcare", languages: ["c#", "go"] });
		api.setProjectDomain = setProjectDomain;
		render(<DomainAgentsPanel projectPath="/work/shop" />);
		expect(await screen.findByText("Domaine appliqué à ce projet : Santé")).toBeInTheDocument();
		expect(screen.getByText("Stacks détectées : c#, go")).toBeInTheDocument();
		await screen.findByRole("option", { name: "Santé" });
		const apply = screen.getByRole("button", { name: "Appliquer à ce projet" });
		const domainSelect = screen.getByRole("combobox", { name: "Domaine" }) as HTMLSelectElement;
		await waitFor(() => expect(domainSelect.value).toBe("healthcare"));
		expect(apply).toBeDisabled();
		fireEvent.change(domainSelect, { target: { value: "data_pipeline" } });
		expect(apply).toBeEnabled();
		fireEvent.click(apply);
		await waitFor(() => expect(setProjectDomain).toHaveBeenCalledWith("/work/shop", "data_pipeline"));
		expect(
			await screen.findByText("Domaine appliqué à ce projet : Pipeline de données"),
		).toBeInTheDocument();
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

	it("words the router's reason in French and says when a provider has no model", () => {
		useModelRouterStore.setState({
			chosen: {
				provider: "copilot",
				model: "claude-haiku-4.5",
				task_class: "trivial",
				tier: "budget",
				estimated_cost_usd: 0,
				reason: "subscription provider copilot (no per-token price)",
				reason_code: "unpriced_provider",
				reason_params: { provider: "copilot", billing: "subscription" },
			},
			comparison: {
				budget: {
					provider: "opencode",
					model: "",
					task_class: "trivial",
					tier: "budget",
					estimated_cost_usd: 0,
					reason: "no model of the available providers in the catalog",
					reason_code: "no_model",
					reason_params: { provider: "opencode", providers: ["opencode"] },
				},
			},
		});
		render(<ModelRouterPanel />);
		expect(
			screen.getByText(/GitHub Copilot est facturé à l’abonnement : aucun coût par token\./),
		).toBeInTheDocument();
		expect(screen.queryByText(/no per-token price/)).not.toBeInTheDocument();
		expect(screen.getByText("aucun modèle à proposer")).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Déduit du prompt" })).toBeInTheDocument();
	});
});
