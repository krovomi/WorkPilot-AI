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
	useArchDriftStore,
	useCicdAnomalyStore,
	useCogContextStore,
	useDomainAgentsStore,
	useLicenseStore,
} from "../../../stores/phase35-stores";
import { ArchDriftPanel } from "../ArchDriftPanel";
import { CicdAnomalyPanel } from "../CicdAnomalyPanel";
import { CogContextPanel } from "../CogContextPanel";
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
	useLicenseStore.setState({ report: null, phase: "idle", error: null });
	useCogContextStore.setState({ context: null, phase: "idle", error: null });
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
	it("asks for a project before optimizing a context", () => {
		render(<CogContextPanel />);
		expect(screen.queryByRole("button", { name: "Optimiser" })).not.toBeInTheDocument();
	});

	it("lists the files it refused to read, in French, and the sources it proposed", () => {
		useCogContextStore.setState({
			phase: "ok",
			context: {
				slices: [
					{
						file_path: "src/Orders/OrderService.cs",
						content: "public class OrderService {}",
						full_size_tokens: 900,
						included_tokens: 120,
						truncated: true,
						relevance: {
							file_path: "src/Orders/OrderService.cs",
							score: 1.5,
							keyword_hits: 2,
							path_score: 0.5,
							explicit_mention: false,
							recency_score: 0,
							breakdown: {},
						},
					},
				],
				token_budget: 8000,
				tokens_used: 120,
				files_skipped: [],
				summary: { candidates: 12, keywords_detected: ["order", "total"] },
				discovered: true,
				refused: [{ path: "/etc/hosts", reason: "outside" }],
			},
		});
		render(<CogContextPanel projectPath="/work/shop" />);
		expect(screen.getByText("Fichiers non lus")).toBeInTheDocument();
		expect(screen.getByText(/hors du projet/)).toBeInTheDocument();
		expect(screen.getByText("Extrait")).toBeInTheDocument();
		expect(screen.getByText(/12 sources du projet examinées/)).toBeInTheDocument();
		expect(screen.getByText(/Mots-clés lus dans la tâche : order, total/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Copier le contexte/ })).toBeInTheDocument();
	});
});
