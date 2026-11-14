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
	useDomainAgentsStore,
	useLicenseStore,
	usePairRealtimeStore,
} from "../../../stores/phase35-stores";
import { ArchDriftPanel } from "../ArchDriftPanel";
import { CicdAnomalyPanel } from "../CicdAnomalyPanel";
import { DomainAgentsPanel } from "../DomainAgentsPanel";
import { LicensePanel } from "../LicensePanel";
import { PairProgrammingPanel } from "../PairProgrammingPanel";

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
	usePairRealtimeStore.setState({ currentRoom: null, ops: [], isStreaming: false, aiError: null });
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
	it("shows a pair room in French, with the AI's proposal and roles", () => {
		usePairRealtimeStore.setState({
			isStreaming: true,
			subscribe: () => Promise.resolve(),
			currentRoom: {
				room_id: "pair",
				created_at: 0,
				participants: [
					{ user_id: "ana", display_name: "Ana", role: "driver", joined_at: 0, last_seen: 0 },
					{
						user_id: "workpilot-ai",
						display_name: "WorkPilot IA",
						role: "ai",
						joined_at: 0,
						last_seen: 0,
					},
				],
				op_count: 2,
				last_op_sequence: 2,
				closed: false,
			},
			ops: [
				{
					op_id: "1",
					sequence: 1,
					kind: "cursor",
					actor: "ana",
					timestamp: 0,
					payload: { file_path: "src/Orders.cs" },
				},
				{
					op_id: "2",
					sequence: 2,
					kind: "suggestion",
					actor: "workpilot-ai",
					timestamp: 0,
					payload: { file_path: "src/Orders.cs", suggestion: "class Orders {}" },
				},
			],
			aiError: "unavailable",
		});
		render(<PairProgrammingPanel projectPath="/work/shop" />);
		expect(screen.getByText(/Pilote/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /L'IA est dans la salle/ })).toBeDisabled();
		expect(screen.getByText(/Proposition pour src\/Orders.cs/)).toBeInTheDocument();
		expect(screen.getByText(/Le fournisseur n'a pas répondu/)).toBeInTheDocument();
		expect(screen.getByText(/Cette salle vit sur cet ordinateur/)).toBeInTheDocument();
	});
});
