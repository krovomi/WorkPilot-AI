/**
 * Typed client for the three agent-tooling endpoints added with the
 * "Cost Estimator / Restart / Prompt Preview" feature.
 *
 *   POST /api/cost-estimator/preview
 *   GET  /api/restart/plan
 *   POST /api/restart/prepare
 *   GET  /api/prompt-preview/
 *
 * Each call returns `{ ok: true, data: T } | { ok: false, error: string }`
 * so callers don't have to repeat the success/error switch. AbortSignal
 * is supported on every call (for useEffect cleanup).
 */

export type ApiResult<T> =
	| { ok: true; data: T }
	/** `detail`: the backend's own words, when it has any worth showing. */
	| { ok: false; error: string; detail?: string };

const backendUrl = (): string => import.meta.env?.VITE_BACKEND_URL ?? "";

async function _post<T>(
	path: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<ApiResult<T>> {
	try {
		const res = await fetch(`${backendUrl()}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		const json = (await res.json()) as Record<string, unknown>;
		if (json.success === true) {
			return { ok: true, data: json as T };
		}
		return {
			ok: false,
			error:
				typeof json.error === "string"
					? json.error
					: `request failed with HTTP ${res.status}`,
			...(typeof json.detail === "string" ? { detail: json.detail } : {}),
		};
	} catch (err) {
		if ((err as { name?: string })?.name === "AbortError") {
			return { ok: false, error: "aborted" };
		}
		return {
			ok: false,
			error: err instanceof Error ? err.message : "network error",
		};
	}
}

async function _get<T>(
	path: string,
	params: Record<string, string>,
	signal?: AbortSignal,
): Promise<ApiResult<T>> {
	try {
		const qs = new URLSearchParams(params).toString();
		const res = await fetch(`${backendUrl()}${path}?${qs}`, { signal });
		const json = (await res.json()) as Record<string, unknown>;
		if (json.success === true) {
			return { ok: true, data: json as T };
		}
		return {
			ok: false,
			error:
				typeof json.error === "string"
					? json.error
					: `request failed with HTTP ${res.status}`,
		};
	} catch (err) {
		if ((err as { name?: string })?.name === "AbortError") {
			return { ok: false, error: "aborted" };
		}
		return {
			ok: false,
			error: err instanceof Error ? err.message : "network error",
		};
	}
}

// ---------------------------------------------------------------------------
// Cost Estimator

export interface PhaseEstimate {
	phase: string;
	provider: string;
	model: string;
	input_tokens: number;
	output_tokens: number;
	iterations: number;
	estimated_cost_usd: number;
	notes: string[];
}

export interface CostEstimate {
	spec_id: string;
	spec_chars: number;
	base_input_tokens: number;
	phases: PhaseEstimate[];
	total_cost_usd: number;
	confidence: "high" | "medium" | "low";
	warnings: string[];
}

export async function previewBuildCost(
	specDir: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ estimate: CostEstimate }>> {
	return _post<{ estimate: CostEstimate }>(
		"/api/cost-estimator/preview",
		{ spec_dir: specDir },
		signal,
	);
}

// ---------------------------------------------------------------------------
// Restart Planner

export type RestartMode = "qa" | "coder" | "full";

export interface RestartPlan {
	spec_id: string;
	can_restart_qa: boolean;
	can_restart_coder: boolean;
	can_restart_full: boolean;
	reasons: Record<string, string>;
	next_subtask_for_coder: string | null;
	completed_subtasks: number;
	total_subtasks: number;
	files_to_clean: Record<RestartMode, string[]>;
}

export async function fetchRestartPlan(
	specDir: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ plan: RestartPlan }>> {
	return _get<{ plan: RestartPlan }>(
		"/api/restart/plan",
		{ spec_dir: specDir },
		signal,
	);
}

export interface RestartPrepareResult {
	mode: RestartMode;
	deleted: string[];
	warnings: string[];
}

export async function prepareRestart(
	specDir: string,
	mode: RestartMode,
	signal?: AbortSignal,
): Promise<ApiResult<RestartPrepareResult>> {
	return _post<RestartPrepareResult>(
		"/api/restart/prepare",
		{ spec_dir: specDir, mode },
		signal,
	);
}

// ---------------------------------------------------------------------------
// System Prompt Preview

export interface PromptPreview {
	project_dir: string;
	spec_dir: string;
	agent_type: string;
	model: string;
	provider: string;
	system_prompt: string;
	system_prompt_length: number;
	claude_md_included: boolean;
	domain_addendum_included: boolean;
	domain_addendum_chars: number;
	allowed_tools: string[];
	notes: string[];
}

export async function fetchPromptPreview(
	projectDir: string,
	specDir: string,
	agentType: string = "coder",
	signal?: AbortSignal,
): Promise<ApiResult<{ preview: PromptPreview }>> {
	return _get<{ preview: PromptPreview }>(
		"/api/prompt-preview/",
		{
			project_dir: projectDir,
			spec_dir: specDir,
			agent_type: agentType,
		},
		signal,
	);
}

// ---------------------------------------------------------------------------
// Timeline (audit trail per spec)

export interface TimelineEntry {
	sequence: number;
	timestamp_unix: number;
	timestamp_iso: string;
	delta_seconds: number;
	kind: string;
	actor: string;
	phase: string;
	summary: string;
	payload: Record<string, unknown>;
	event_hash: string;
}

export interface Timeline {
	correlation_id: string;
	entries: TimelineEntry[];
	entry_count: number;
	integrity: { intact: boolean; reason: string | null };
	duration_seconds: number;
	phase_counts: Record<string, number>;
}

export async function fetchTimeline(
	projectDir: string,
	correlationId: string,
	options?: {
		actor?: string;
		kind?: string;
		signal?: AbortSignal;
	},
): Promise<ApiResult<{ timeline: Timeline }>> {
	const params: Record<string, string> = { project_dir: projectDir };
	if (options?.actor) params.actor = options.actor;
	if (options?.kind) params.kind = options.kind;
	return _get<{ timeline: Timeline }>(
		`/api/timeline/${encodeURIComponent(correlationId)}`,
		params,
		options?.signal,
	);
}

// ---------------------------------------------------------------------------
// Progress indicator (fine-grained sub-status)

export interface ProgressIndicatorPayload {
	spec_id: string;
	label: string;
	phase: "planning" | "coding" | "qa" | "idle" | "completed" | "unknown";
	sub_phase: string | null;
	subtasks_completed: number;
	subtasks_total: number;
	current_subtask_id: string | null;
	current_session: number | null;
	last_activity_iso: string | null;
	warnings: string[];
}

export async function fetchProgressIndicator(
	specDir: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ indicator: ProgressIndicatorPayload }>> {
	return _get<{ indicator: ProgressIndicatorPayload }>(
		"/api/progress-indicator/",
		{ spec_dir: specDir },
		signal,
	);
}

// ---------------------------------------------------------------------------
// QA auto-promotion (item 8)

export interface PromotionDecision {
	spec_id: string;
	score: number;
	threshold: number | null;
	promote: boolean;
	reasons: string[];
	breakdown: Record<string, number>;
}

export async function fetchPromotionDecision(
	specDir: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ decision: PromotionDecision }>> {
	return _post<{ decision: PromotionDecision }>(
		"/api/qa-promotion/decide",
		{ spec_dir: specDir },
		signal,
	);
}

// ---------------------------------------------------------------------------
// Parallel variations (item 9)

export interface VariationDescriptor {
	label: string;
	path: string;
	spec_id: string;
	seed: number;
}

export interface VariationManifest {
	spec_id: string;
	parent_path: string;
	variations: VariationDescriptor[];
}

export interface VariationComparison {
	spec_id: string;
	rows: Array<{
		label: string;
		subtasks_completed: number;
		subtasks_total: number;
		qa_status: string;
		qa_report_chars: number;
		has_self_review: boolean;
	}>;
	suggested_winner: string | null;
}

export async function listVariations(
	specDir: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ manifest: VariationManifest }>> {
	return _get<{ manifest: VariationManifest }>(
		"/api/parallel-variations/list",
		{ spec_dir: specDir },
		signal,
	);
}

export async function createVariations(
	specDir: string,
	count: number,
	signal?: AbortSignal,
): Promise<ApiResult<{ manifest: VariationManifest }>> {
	return _post<{ manifest: VariationManifest }>(
		"/api/parallel-variations/create",
		{ spec_dir: specDir, count },
		signal,
	);
}

export async function compareVariations(
	specDir: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ comparison: VariationComparison }>> {
	return _get<{ comparison: VariationComparison }>(
		"/api/parallel-variations/compare",
		{ spec_dir: specDir },
		signal,
	);
}

// ---------------------------------------------------------------------------
// Virtual reviewer (item 10)

export interface VirtualReviewSummaryPayload {
	spec_id: string;
	spec_chars: number;
	qa_report_chars: number;
	self_review_present: boolean;
	diff_excerpt: string;
	diff_truncated: boolean;
	error: string | null;
}

export async function fetchVirtualReviewSummary(
	specDir: string,
	projectDir: string,
	signal?: AbortSignal,
): Promise<
	ApiResult<{ summary: VirtualReviewSummaryPayload; enabled: boolean }>
> {
	return _get<{ summary: VirtualReviewSummaryPayload; enabled: boolean }>(
		"/api/virtual-reviewer/summary",
		{ spec_dir: specDir, project_dir: projectDir },
		signal,
	);
}

export async function runVirtualReview(
	specDir: string,
	projectDir: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ written_to: string; filename: string }>> {
	return _post<{ written_to: string; filename: string }>(
		"/api/virtual-reviewer/run",
		{ spec_dir: specDir, project_dir: projectDir },
		signal,
	);
}

// ---------------------------------------------------------------------------
// Workflow profile — what the chosen effort level actually buys
//
// Chantier 4 asks for the resolved pipeline to be visible *before* a build
// runs, so the user sees what an effort level bought or cost rather than
// inferring it from a log afterwards. Until now it was printed to a terminal
// the Kanban user never opens.

export interface WorkflowPhasePayload {
	id: string;
	impl: string;
	pack: string;
	skill: string;
	description: string;
	minEffort: string;
	hardGate: string | null;
	always: boolean;
	gate: string | null;
	conditional: boolean;
	whenGlobs: string[];
	/** False for a phase this effort level or change set dropped. */
	runs: boolean;
	dispatch: string;
	/** Set when the provider could not give the dispatch the phase asked for. */
	degradedFrom: string | null;
	degradedReason: string;
	/** "effort" | "untouched" — why it was dropped, when it was. */
	skipReason: string | null;
	deterministic: boolean;
}

export interface WorkflowLevelPayload {
	effort: string;
	phaseIds: string[];
	count: number;
}

export interface WorkflowProfilePayload {
	jev?: {
		observation: import("../../shared/types/jev").JevObservation | null;
		airgapStrict: boolean;
	};
	workflow: string;
	description: string;
	effort: string;
	provider: string | null;
	/** False when WORKPILOT_WORKFLOW_ENGINE is switched off. */
	enabled: boolean;
	phases: WorkflowPhasePayload[];
	runCount: number;
	missing: Array<{
		phaseId: string;
		impl: string;
		pack: string;
		reason: string;
	}>;
	levels?: WorkflowLevelPayload[];
}

export interface WorkflowProfileQuery {
	/** Absolute spec directory, when the caller has one. */
	specDir?: string;
	/** Otherwise the pair that names it — the server owns the layout. */
	projectDir?: string;
	specId?: string;
	/** Preview another level without changing the task's configuration. */
	effort?: string;
	provider?: string;
	workflow?: string;
	includeLevels?: boolean;
}

// ---------------------------------------------------------------------------
// Spec traceability — what the spec left open, and what the plan will not build
//
// The backend recomputes this rather than reading back the `traceability.json`
// a build wrote, so the answer is right for a task that has not been planned
// yet — which is most of the tasks someone opens this panel on.

export interface TraceabilityRequirement {
	id: string;
	title: string;
	line: number;
}

export interface TraceabilityOpenQuestion {
	question: string;
	section: string;
	line: number;
}

export interface TraceabilityCoverage {
	/** False when the question cannot be asked — see `reason`. */
	applicable: boolean;
	reason: string;
	/** Null when not applicable: a spec with no ids is not a spec at 0%. */
	percent: number | null;
	covered: Record<string, string[]>;
	uncovered: string[];
	/** A subtask citing a requirement `spec.md` does not declare. */
	unknownRefs: Record<string, string[]>;
	summary: string;
}

export interface TraceabilityPayload {
	spec: string;
	requirements: TraceabilityRequirement[];
	openQuestions: TraceabilityOpenQuestion[];
	coverage: TraceabilityCoverage;
}

export interface SpecTraceabilityQuery {
	specDir?: string;
	projectDir?: string;
	specId?: string;
}

/** The backend speaks snake_case; the renderer speaks camelCase. */
interface RawTraceability {
	spec: string;
	requirements: TraceabilityRequirement[];
	open_questions: TraceabilityOpenQuestion[];
	coverage: Omit<TraceabilityCoverage, "unknownRefs"> & {
		unknown_refs: Record<string, string[]>;
	};
}

export async function fetchSpecTraceability(
	query: SpecTraceabilityQuery,
	signal?: AbortSignal,
): Promise<ApiResult<TraceabilityPayload>> {
	const params: Record<string, string> = {};
	if (query.specDir) params.spec_dir = query.specDir;
	if (query.projectDir) params.project_dir = query.projectDir;
	if (query.specId) params.spec_id = query.specId;

	const res = await _get<{ traceability: RawTraceability }>(
		"/api/spec-traceability/",
		params,
		signal,
	);
	if (!res.ok) return res;

	const raw = res.data.traceability;
	const { unknown_refs, ...coverage } = raw.coverage;
	return {
		ok: true,
		data: {
			spec: raw.spec,
			requirements: raw.requirements,
			openQuestions: raw.open_questions,
			coverage: { ...coverage, unknownRefs: unknown_refs },
		},
	};
}

/* -------------------------------------------------------------------------
 * Docintel — task attachments and ADRs, as the agents will read them
 *
 *   GET /api/docintel/?project_dir=…&spec_id=…
 *
 * Recomputed on every call, nothing written; refused in server mode by the
 * same addressing rules as the traceability endpoint.
 * ---------------------------------------------------------------------- */

/** See `STATUSES` in docintel/models.py. */
export type DocintelStatus =
	| "diagram"
	| "text"
	| "image"
	| "document"
	| "skipped"
	| "redacted"
	| "withheld";

export interface DocintelDocument {
	path: string;
	status: DocintelStatus;
	engine: string;
	/** Why nothing (or less than everything) was read: a reason code. */
	reason: string;
	/** `safe` | `suspect` | `blocked` — from injection_guard. */
	threat: string;
	/** Kinds of secret found (never a value), from security/scan_secrets.py. */
	secrets: string[];
	/** True when a local vision model described the image. */
	described: boolean;
	nodeCount: number;
	edgeCount: number;
	/** A crash or a failed build found in the text, located in the repository. */
	diagnosis: DocintelDiagnosis | null;
	/** A PDF's pages, and how many were rendered for OCR (0 otherwise). */
	pagesTotal: number;
	pagesRead: number;
}

/** See `summary` in docintel/diagnostics.py. */
export interface DocintelDiagnosis {
	trace?: {
		exception: string;
		language: string;
		projectFrames: number;
		frameworkFrames: number;
		/** `path:line` of the innermost frame the project owns. */
		top: string | null;
	};
	ci?: {
		errors: number;
		/** First codes, e.g. `CS0103`, `NU1101`, `TS2345`. */
		codes: string[];
		failingTests: number;
	};
}

export interface DocintelAdr {
	id: string;
	title: string;
	status: string;
	path: string;
	decision: string;
	binding: boolean;
}

/** See `_code_checks` in docintel/api.py. */
export interface DocintelErdSummary {
	diagrams: { path: string; origin: "attachment" | "repository" }[];
	findings: number;
	kinds: string[];
	ambiguous: number;
}

export interface DocintelSequenceSummary {
	path: string;
	origin: "attachment" | "repository";
	verified: number;
	checkable: number;
}

export interface DocintelApiTestSummary {
	method: string;
	path: string;
	status: number | null;
	origin: string;
	/** Where the drafted test goes, relative to the project; "" when undecided. */
	destination: string;
	stack: string;
}

export interface DocintelPayload {
	documents: DocintelDocument[];
	adrs: DocintelAdr[];
	/** A stack trace or build log pasted into the task description. */
	descriptionDiagnosis: DocintelDiagnosis | null;
	/** ERD vs. ORM mapping, when an ERD exists. */
	erd: DocintelErdSummary | null;
	/** Sequence diagrams whose calls were looked up in the code. */
	sequences: DocintelSequenceSummary[];
	/** HTTP captures of the task, each drafted as an integration test. */
	apiTests: DocintelApiTestSummary[];
}

interface RawDocintelDocument {
	path: string;
	status: DocintelStatus;
	engine: string;
	reason: string;
	threat: string;
	secrets?: string[];
	described?: boolean;
	diagram: { nodes?: unknown[]; edges?: unknown[] } | null;
	diagnosis_summary?: DocintelDiagnosis | null;
	pages_total?: number;
	pages_read?: number;
}

export async function fetchDocintel(
	query: SpecTraceabilityQuery,
	signal?: AbortSignal,
): Promise<ApiResult<DocintelPayload>> {
	const params: Record<string, string> = {};
	if (query.specDir) params.spec_dir = query.specDir;
	if (query.projectDir) params.project_dir = query.projectDir;
	if (query.specId) params.spec_id = query.specId;

	const res = await _get<{
		documents: RawDocintelDocument[];
		adrs: DocintelAdr[];
		description_diagnosis?: DocintelDiagnosis | null;
		erd?: DocintelErdSummary | null;
		sequences?: DocintelSequenceSummary[];
		apiTests?: DocintelApiTestSummary[];
	}>("/api/docintel/", params, signal);
	if (!res.ok) return res;

	return {
		ok: true,
		data: {
			documents: (res.data.documents ?? []).map((doc) => ({
				path: doc.path,
				status: doc.status,
				engine: doc.engine,
				reason: doc.reason,
				threat: doc.threat,
				secrets: doc.secrets ?? [],
				described: doc.described ?? false,
				nodeCount: doc.diagram?.nodes?.length ?? 0,
				edgeCount: doc.diagram?.edges?.length ?? 0,
				diagnosis: doc.diagnosis_summary ?? null,
				pagesTotal: doc.pages_total ?? 0,
				pagesRead: doc.pages_read ?? 0,
			})),
			adrs: res.data.adrs ?? [],
			descriptionDiagnosis: res.data.description_diagnosis ?? null,
			erd: res.data.erd ?? null,
			sequences: res.data.sequences ?? [],
			apiTests: res.data.apiTests ?? [],
		},
	};
}

/* -------------------------------------------------------------------------
 * Docintel drafts — requirements, criteria and rule tables proposed from the
 * attachments, and a whiteboard photo turned into a diagram
 *
 *   GET  /api/docintel/drafts
 *   POST /api/docintel/drafts/extract   read the attachments now (OCR included)
 *   POST /api/docintel/drafts/decide    accept / reject; accepted go to spec.md
 *   POST /api/docintel/whiteboard       photo -> attachments/<name>.whiteboard.drawio
 * ---------------------------------------------------------------------- */

export type DraftStatus = "proposed" | "accepted" | "rejected";

export interface RequirementDraft {
	key: string;
	/** Provisional until accepted: the next free id in spec.md at that moment. */
	id: string;
	kind: "FR" | "NFR";
	text: string;
	source: string;
	page: number;
	/** The document's own reference (`REQ-12`, `EF-03`). */
	ref: string;
	status: DraftStatus;
}

export interface CriterionDraft {
	key: string;
	text: string;
	source: string;
	page: number;
	status: DraftStatus;
}

export interface RuleTestDraft {
	language: string;
	framework: string;
	code: string;
	notes: string[];
}

export interface RuleTableDraft {
	key: string;
	table: {
		headers: string[];
		rows: string[][];
		caption: string;
		source: string;
		page: number;
	};
	source: string;
	tests: RuleTestDraft[];
	status: "proposed" | "rejected";
}

export interface DocintelDrafts {
	requirements: RequirementDraft[];
	criteria: CriterionDraft[];
	tables: RuleTableDraft[];
	sources: string[];
	generated_at: string;
}

export interface DocintelVision {
	images: string[];
	available: boolean;
	/** Why a photo cannot be converted here: `model-not-installed`… */
	reason: string;
	model?: string;
}

export interface DocintelDraftsPayload {
	drafts: DocintelDrafts | null;
	pending: number;
	/** Attachments a proposal can be read from (prose, PDF, images). */
	readable: string[];
	pdfBackends: string[];
	vision: DocintelVision;
}

export interface DraftDecisionResult {
	requirements: { id: string; text: string; key: string }[];
	criteria: string[];
	spec_updated: boolean;
	description_section: string;
	traceability: string;
}

export interface DraftDecision {
	acceptRequirements?: Record<string, string>;
	rejectRequirements?: string[];
	acceptCriteria?: Record<string, string>;
	rejectCriteria?: string[];
	rejectTables?: string[];
}

export interface WhiteboardResult {
	/** `converted`, or why not: `no-vision-model`, `injection`, `exists`… */
	status: string;
	reason: string;
	path: string;
	nodes: number;
	edges: number;
	secrets: string[];
	conformance: {
		status: string;
		findings: number;
		inverted: number;
	} | null;
}

function specAddress(query: SpecTraceabilityQuery): Record<string, string> {
	const address: Record<string, string> = {};
	if (query.specDir) address.spec_dir = query.specDir;
	if (query.projectDir) address.project_dir = query.projectDir;
	if (query.specId) address.spec_id = query.specId;
	return address;
}

export function fetchDocintelDrafts(
	query: SpecTraceabilityQuery,
	signal?: AbortSignal,
): Promise<ApiResult<DocintelDraftsPayload>> {
	return _get<DocintelDraftsPayload>(
		"/api/docintel/drafts",
		specAddress(query),
		signal,
	);
}

export function extractDocintelDrafts(
	query: SpecTraceabilityQuery,
	signal?: AbortSignal,
): Promise<ApiResult<DocintelDraftsPayload>> {
	return _post<DocintelDraftsPayload>(
		"/api/docintel/drafts/extract",
		specAddress(query),
		signal,
	);
}

export function decideDocintelDrafts(
	query: SpecTraceabilityQuery,
	decision: DraftDecision,
	signal?: AbortSignal,
): Promise<ApiResult<DocintelDraftsPayload & { decision: DraftDecisionResult }>> {
	return _post<DocintelDraftsPayload & { decision: DraftDecisionResult }>(
		"/api/docintel/drafts/decide",
		{
			...specAddress(query),
			accept_requirements: decision.acceptRequirements ?? {},
			reject_requirements: decision.rejectRequirements ?? [],
			accept_criteria: decision.acceptCriteria ?? {},
			reject_criteria: decision.rejectCriteria ?? [],
			reject_tables: decision.rejectTables ?? [],
		},
		signal,
	);
}

export function convertWhiteboard(
	query: SpecTraceabilityQuery,
	path: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ result: WhiteboardResult }>> {
	return _post<{ result: WhiteboardResult }>(
		"/api/docintel/whiteboard",
		{ ...specAddress(query), path },
		signal,
	);
}

export async function fetchWorkflowProfile(
	query: WorkflowProfileQuery,
	signal?: AbortSignal,
): Promise<ApiResult<{ profile: WorkflowProfilePayload }>> {
	const params: Record<string, string> = {};
	if (query.specDir) params.spec_dir = query.specDir;
	if (query.projectDir) params.project_dir = query.projectDir;
	if (query.specId) params.spec_id = query.specId;
	if (query.effort) params.effort = query.effort;
	if (query.provider) params.provider = query.provider;
	if (query.workflow) params.workflow = query.workflow;
	if (query.includeLevels === false) params.includeLevels = "false";

	return _get<{ profile: WorkflowProfilePayload }>(
		"/api/workflow-profile/",
		params,
		signal,
	);
}

/* -------------------------------------------------------------------------
 * Hermes — readiness, persona, and the learning cycle
 *
 *   GET  /api/hermes/status
 *   POST /api/hermes/cycle
 *   POST /api/hermes/soul/install
 *
 * All three are refused in server mode: every answer is about $HERMES_HOME on
 * the machine running the backend, which on a shared deployment belongs to the
 * server and not to the tenant asking. The caller renders `reason === "server-mode"`
 * as "not available here" rather than as a failure.
 * ---------------------------------------------------------------------- */

export interface HermesCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
	readonly remedy: string;
	readonly required: boolean;
}

export interface HermesReadiness {
	readonly state: "absent" | "ready" | "degraded";
	readonly installed: boolean;
	readonly ready: boolean;
	readonly degraded: boolean;
	readonly home: string;
	readonly checks: readonly HermesCheck[];
}

export interface HermesSoul {
	readonly state: "installed" | "diverged" | "not-installed" | "unavailable";
	readonly offered: boolean;
	readonly installed: boolean;
	readonly matches: boolean;
	readonly installedPath: string;
	readonly repoPath: string;
}

export interface HermesStatus {
	readonly readiness: HermesReadiness;
	readonly soul: HermesSoul;
	readonly pending: readonly string[];
	/**
	 * Candidats encore dans la file mais que ce dépôt a déjà écartés — filés
	 * avant que le triage existe. Un nombre, pas une liste : ce n'est plus du
	 * travail pour personne, le prochain cycle les retire.
	 */
	readonly stale: number;
	/** Skills adoptés dans `skills/<adoptedPack>/`, encore présents. */
	readonly adopted: readonly string[];
	/** Le pack d'adoption — non listé dans `.workpilot/skills.toml`, donc émis nulle part. */
	readonly adoptedPack: string;
	readonly surfaces: readonly {
		readonly id: string;
		readonly description: string;
	}[];
}

export interface HermesCycle {
	readonly surface: string;
	readonly surfaceDescription: string;
	readonly readiness: HermesReadiness;
	readonly ran: boolean;
	readonly proposed: number;
	readonly pending: readonly string[];
	readonly stale: number;
	readonly ingest: {
		readonly found: number;
		readonly proposed: number;
		readonly files: readonly string[];
		readonly unchanged: number;
		readonly deferred: number;
		/** Ce que le triage a écarté à l'entrée, par motif (`hermes_triage`). */
		readonly dropped: Readonly<Record<string, number>>;
		readonly droppedTotal: number;
		/** Candidats déjà en file que ce cycle a retirés. */
		readonly pruned: number;
		/** Ce que ce cycle a adopté, par nom de skill. */
		readonly adopted: readonly string[];
		/** Noms que le registre d'adoption avait déjà tranchés. */
		readonly alreadyAdopted: number;
		readonly reason: string;
	} | null;
}

export async function fetchHermesStatus(
	signal?: AbortSignal,
): Promise<ApiResult<{ status: HermesStatus }>> {
	return _get<{ status: HermesStatus }>("/api/hermes/status", {}, signal);
}

export async function runHermesCycle(
	surface: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ cycle: HermesCycle }>> {
	return _post<{ cycle: HermesCycle }>(
		"/api/hermes/cycle",
		{ surface, dryRun: false },
		signal,
	);
}

export async function installHermesSoul(
	overwrite: boolean,
	signal?: AbortSignal,
): Promise<ApiResult<{ changed: boolean; message: string; soul: HermesSoul }>> {
	return _post<{ changed: boolean; message: string; soul: HermesSoul }>(
		"/api/hermes/soul/install",
		{ overwrite },
		signal,
	);
}

/* ------------------------------------------------------------------ */
/* rtk — command output condensed before an agent reads it            */
/*                                                                    */
/* GET /api/rtk/status                                                */
/*                                                                    */
/* Read-only, and there is no companion action on purpose: the one    */
/* command a user might want a button for is `rtk init -g`, which     */
/* writes a hook into their own Claude Code settings for every        */
/* session on the machine — not only the ones WorkPilot drives. The   */
/* panel prints the command; the person types it.                     */
/* ------------------------------------------------------------------ */

export interface RtkCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
	readonly remedy: string;
}

export interface RtkReadiness {
	readonly installed: boolean;
	readonly enabled: boolean;
	readonly version: string;
	readonly binary: string;
	/** "absent" | "disabled" | "degraded" | "active" */
	readonly state: string;
	readonly checks: readonly RtkCheck[];
}

export interface RtkSavings {
	readonly available: boolean;
	readonly commands: number;
	readonly inputBytes: number;
	readonly outputBytes: number;
	readonly savedBytes: number;
	/** rtk's own estimate: bytes / 4. Neither side ships a tokenizer. */
	readonly savedTokens: number;
	readonly averagePct: number;
	readonly reason: string;
}

export interface RtkStatus {
	readonly readiness: RtkReadiness;
	readonly savings: RtkSavings;
}

export async function fetchRtkStatus(
	projectDir?: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ status: RtkStatus }>> {
	// `_get` builds the query string itself — a `?` in the path would give
	// the request two of them.
	return _get<{ status: RtkStatus }>(
		"/api/rtk/status",
		projectDir ? { project_dir: projectDir } : {},
		signal,
	);
}

/* ------------------------------------------------------------------ */
/* Brain — the shared brain every agent reads and writes              */
/*                                                                    */
/* GET  /api/brain/settings     where it is, its remote, its vault    */
/* POST /api/brain/settings     plug a folder and/or a git remote     */
/* GET  /api/brain/task         what one Kanban task taught it        */
/* POST /api/brain/instruction  activate / turn down a proposed rule  */
/* POST /api/brain/sync         commit, pull, push now                */
/*                                                                    */
/* Refused in server mode, like hermes: the brain lives in the home   */
/* directory of the machine running the backend.                      */
/* ------------------------------------------------------------------ */

export interface BrainSettings {
	readonly path: string;
	readonly defaultPath: string;
	/** Who chose the folder: the environment, Settings, or nobody. */
	readonly source: "env" | "config" | "default";
	readonly envVariable: string;
	readonly configPath: string;
	readonly enabled: boolean;
	/** Enabled and a brain exists: every feature is plugged into it. */
	readonly active: boolean;
	readonly exists: boolean;
	readonly folderExists: boolean;
	readonly git: boolean;
	readonly gitAvailable: boolean;
	readonly remote: string | null;
	readonly obsidianVault: boolean;
	readonly notes: number;
	readonly proposals: number;
}

export interface BrainSettingsUpdate {
	/** A folder under the home directory; "" goes back to the default. */
	path?: string;
	/** A git remote, or GitHub's `owner/repo`. */
	remote?: string;
	enabled?: boolean;
	/** Create, clone or adopt the brain now. */
	connect?: boolean;
}

export interface BrainNoteSummary {
	readonly path: string;
	readonly absPath: string;
	readonly title: string;
	readonly kind: string;
	readonly status: string | null;
	readonly agents: readonly string[];
	readonly updated: string | null;
}

export interface BrainBuildNote extends BrainNoteSummary {
	readonly qa: boolean | null;
	readonly tests: boolean | null;
	readonly merged: string | null;
}

export interface BrainTaskLearning {
	readonly active: boolean;
	readonly task: string;
	readonly root?: string;
	readonly build: BrainBuildNote | null;
	readonly notes: readonly BrainNoteSummary[];
	readonly proposals: readonly BrainNoteSummary[];
}

export interface BrainSyncResult {
	readonly committed: boolean;
	readonly pulled: boolean;
	readonly pushed: boolean;
	readonly remote: string | null;
	readonly conflicts: readonly string[];
	readonly skipped: string | null;
	readonly error: string | null;
	/** Where it failed: `commit`, `fetch`, `pull`, `push` or `git`. */
	readonly step?: string | null;
	/** git's own message, credentials removed. */
	readonly detail?: string | null;
}

export async function fetchBrainSettings(
	signal?: AbortSignal,
): Promise<ApiResult<{ settings: BrainSettings }>> {
	return _get<{ settings: BrainSettings }>("/api/brain/settings", {}, signal);
}

export async function saveBrainSettings(
	update: BrainSettingsUpdate,
	signal?: AbortSignal,
): Promise<ApiResult<{ settings: BrainSettings }>> {
	return _post<{ settings: BrainSettings }>(
		"/api/brain/settings",
		update,
		signal,
	);
}

export async function fetchBrainTask(
	projectDir: string,
	specId: string,
	signal?: AbortSignal,
): Promise<ApiResult<{ learning: BrainTaskLearning }>> {
	return _get<{ learning: BrainTaskLearning }>(
		"/api/brain/task",
		{ project_dir: projectDir, spec_id: specId },
		signal,
	);
}

export async function setBrainInstructionStatus(
	path: string,
	status: "active" | "retired",
	signal?: AbortSignal,
): Promise<ApiResult<{ path: string; status: string }>> {
	return _post<{ path: string; status: string }>(
		"/api/brain/instruction",
		{ path, status },
		signal,
	);
}

export async function syncBrain(
	signal?: AbortSignal,
): Promise<ApiResult<BrainSyncResult>> {
	return _post<BrainSyncResult>(
		"/api/brain/sync",
		{ message: "brain: sync from WorkPilot" },
		signal,
	);
}

/** Opens a note in Obsidian — the vault must be one Obsidian knows. */
export function obsidianUri(absPath: string): string {
	return `obsidian://open?path=${encodeURIComponent(absPath)}`;
}
