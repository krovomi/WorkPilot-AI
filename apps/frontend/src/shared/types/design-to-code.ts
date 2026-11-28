/**
 * Import Design (design → code): the shapes shared by the main process, the
 * preload bridge and the page. The backend's `serialize_result` writes the
 * result; `DESIGN_TO_CODE_STACKS` mirrors `design_to_code_stacks.STACKS`.
 */

import type { GeneratedReview } from "./generated-review";

export const DESIGN_TO_CODE_STACKS = [
	"react",
	"nextjs",
	"vue",
	"nuxt",
	"angular",
	"svelte",
	"blazor",
	"html",
	"react_native",
	"flutter",
	"swiftui",
	"jetpack_compose",
	"maui",
	"wpf",
	"avalonia",
] as const;
export type DesignStack = (typeof DESIGN_TO_CODE_STACKS)[number];

export type DesignStackGroup = "web" | "mobile" | "desktop";

/** Group of each stack, and whether it has a visual-test convention. */
export const DESIGN_STACK_INFO: Record<
	DesignStack,
	{ group: DesignStackGroup; webStyles: boolean; visualTests: boolean }
> = {
	react: { group: "web", webStyles: true, visualTests: true },
	nextjs: { group: "web", webStyles: true, visualTests: true },
	vue: { group: "web", webStyles: true, visualTests: true },
	nuxt: { group: "web", webStyles: true, visualTests: true },
	angular: { group: "web", webStyles: true, visualTests: true },
	svelte: { group: "web", webStyles: true, visualTests: true },
	blazor: { group: "web", webStyles: true, visualTests: true },
	html: { group: "web", webStyles: true, visualTests: true },
	react_native: { group: "mobile", webStyles: false, visualTests: true },
	flutter: { group: "mobile", webStyles: false, visualTests: true },
	swiftui: { group: "mobile", webStyles: false, visualTests: true },
	jetpack_compose: { group: "mobile", webStyles: false, visualTests: true },
	maui: { group: "mobile", webStyles: false, visualTests: false },
	wpf: { group: "desktop", webStyles: false, visualTests: false },
	avalonia: { group: "desktop", webStyles: false, visualTests: false },
};

export const DESIGN_TO_CODE_STYLES = [
	"tailwind",
	"css_modules",
	"scss",
	"styled_components",
] as const;
export type DesignStyle = (typeof DESIGN_TO_CODE_STYLES)[number];

export const DESIGN_SOURCE_TYPES = [
	"screenshot",
	"figma",
	"wireframe",
	"whiteboard",
	"photo",
] as const;
export type DesignSourceKind = (typeof DESIGN_SOURCE_TYPES)[number];

export interface DesignToCodeRequest {
	/** The project the code is for; without one the run uses a scratch folder. */
	projectId?: string;
	imageData?: string;
	framework?: string;
	style?: string;
	sourceType?: string;
	designSystemPath?: string;
	figmaUrl?: string;
	generateTests?: boolean;
	useDesignTokens?: boolean;
	customInstructions?: string;
	/** Render the generated code, compare it with the design and correct it (#379). */
	renderLoop?: boolean;
	/** The loop's limits and passes; the runner bounds every value again. */
	renderLoopOptions?: RenderLoopOptions;
}

/** What the person chose for the render loop (`RENDER_LOOP_BOUNDS`). */
export interface RenderLoopOptions {
	maxIterations: number;
	threshold: number;
	maxTokens: number;
	maxCostUsd: number;
	/** Render the version kept at the mobile, tablet and desktop widths. */
	responsive: boolean;
	/** Capture hover and focus of the first interactive elements. */
	states: boolean;
	/** Send what the passes found back to the model once, kept if it helps. */
	fixPasses: boolean;
	/** Zones drawn on the design, left out of the score (`RENDER_LOOP_MAX_MASKS`). */
	masks: DesignBounds[];
}

/** Where a component sits on the design, as fractions of the image. */
export interface DesignBounds {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface DesignComponentSpec {
	name: string;
	type: string;
	description: string;
	bounds?: DesignBounds | null;
	children: { name: string; type: string }[];
}

export interface DesignSpecSummary {
	components: DesignComponentSpec[];
	color_palette: Record<string, string>;
	typography: Record<string, Record<string, string>>;
}

export interface DesignGeneratedFile {
	path: string;
	content: string;
	language: string;
	description: string;
	/** Set by the main process: the file already exists in the project. */
	exists?: boolean;
}

export interface DesignVisualTest {
	name: string;
	path?: string;
	test_code: string;
	threshold: number;
	description: string;
	exists?: boolean;
}

export interface DesignTokenUsed {
	name: string;
	value: string;
	category: string;
}

export interface DesignToCodeResult {
	success: boolean;
	phase: string;
	design_spec: DesignSpecSummary | null;
	generated_files: DesignGeneratedFile[];
	visual_tests: DesignVisualTest[];
	design_tokens_used: DesignTokenUsed[];
	figma_sync_status: Record<string, unknown> | null;
	errors: string[];
	warnings: string[];
	duration_seconds: number;
	tokens_used: number;
	/** No model answered: the result is a canned example, not an analysis. */
	simulated?: boolean;
	/** The render → diff → correct loop that refined the files, when it was asked for. */
	render_loop?: DesignRenderLoop;
	/** The generated markup scored with the Accessibility page's rules (#391). */
	accessibility?: {
		score: number;
		count: number;
		targetLevel: string;
		violations: { ruleId: string; description: string; severity: string; wcagCriteria: string; file: string; line: number }[];
	} | null;
}

/** A live step of the run, forwarded from the runner as it happens. */
export interface DesignToCodeProgress {
	phase: string;
	status: string;
	detail: {
		spec?: {
			components: {
				name: string;
				type: string;
				children: string[];
				bounds?: DesignBounds | null;
			}[];
			palette: Record<string, string>;
			typography: Record<string, Record<string, string>>;
		};
		tokens?: number;
		tokens_skipped?: boolean;
		files?: string[];
		tests_supported?: boolean;
		loop?: DesignLoopProgress;
	};
}

/** A step of the render loop, as the runner reports it live. */
export interface DesignLoopProgress {
	stage: "render" | "correct" | "responsive" | "states" | "fix_passes";
	iteration: number;
	max_iterations: number;
	score: number | null;
	best: number | null;
}

/** A difference the loop measured, tracked across its iterations. */
export interface DesignLoopIssue {
	id: string;
	region: string;
	kind: "color" | "offset" | "size" | "structure";
	axis?: "x" | "y" | "width" | "height";
	px?: number;
	target?: string;
	render?: string;
	status: "resolved" | "open" | "abandoned";
	first_seen: number;
	last_seen: number;
	resolved_at?: number;
}

export interface DesignLoopIteration {
	/** 0 is the code as generated; each next one follows a correction. */
	index: number;
	score: number;
	pixel_match: number;
	ssim: number;
	/** PNG data URLs, made by the runner. */
	render_image: string;
	diff_image: string;
	regions: { name: string; score: number; issues: Omit<DesignLoopIssue, "id" | "region" | "status" | "first_seen" | "last_seen">[] }[];
	applied_edits: number;
	refused_edits: { path: string; reason: string }[];
	notes: string[];
	duration_seconds: number;
	/** Tokens of the correction that led to this version (0 for v0). */
	tokens?: number;
	/** Its cost in USD, or null when the catalogue has no price for the model. */
	cost_usd?: number | null;
}

/** What the corrections spent (`design_to_code.budget.Spend`). */
export interface DesignLoopSpend {
	input_tokens: number;
	output_tokens: number;
	tokens: number;
	/** Some provider reported no tokens: they were estimated. */
	estimated: boolean;
	cost_status: "priced" | "flat_rate" | "unknown";
	cost_usd: number | null;
	max_tokens: number;
	max_cost_usd: number;
	cost_budget_checked: boolean;
}

/** One width of the responsive pass. */
export interface DesignBreakpointCheck {
	name: "mobile" | "tablet" | "desktop";
	width: number;
	height: number;
	/** The design's width falls here: the render was compared with it. */
	compared: boolean;
	render_image: string;
	overflow_px: number;
	overflowing: string[];
	clipped: string[];
	overlaps: [string, string][];
	score?: number;
	passed?: boolean;
	issues?: Omit<DesignLoopIssue, "id" | "status" | "first_seen" | "last_seen">[];
}

export interface DesignResponsivePass {
	status: "done" | "failed";
	detail?: string;
	breakpoints?: DesignBreakpointCheck[];
}

/** An interactive element in its states; a state is null when it was not reached. */
export interface DesignStateCheck {
	/** Its rank among the elements captured. */
	id: number;
	label: string;
	rest_image: string;
	hover: { changed: boolean; image: string } | null;
	focus: { changed: boolean; image: string } | null;
}

export interface DesignStatesPass {
	status: "done" | "failed";
	detail?: string;
	limit?: number;
	elements?: DesignStateCheck[];
	without_hover?: number;
	without_focus?: number;
	unreached?: number;
}

export type DesignLoopStatus =
	| "converged"
	| "max_iterations"
	| "budget"
	| "stalled"
	| "failed"
	| "skipped";

/** The loop's report (`design_to_code.loop.serialize`, or a skip with its reason). */
export interface DesignRenderLoop {
	status: DesignLoopStatus;
	/** Why it did not run, when `status` is `skipped`. */
	reason?: string;
	detail?: string;
	threshold: number;
	/** The rendering is a static HTML mirror of the stack's files. */
	mirror: boolean;
	best_iteration: number;
	iterations: DesignLoopIteration[];
	issues: DesignLoopIssue[];
	provider?: string;
	route?: string | null;
	model?: string;
	masked?: string[];
	missing_fonts?: string[];
	/** Which budget stopped the loop, when `status` is `budget`. */
	budget_kind?: "" | "time" | "tokens" | "cost";
	spend?: DesignLoopSpend;
	responsive?: DesignResponsivePass;
	states?: DesignStatesPass;
	/** How many zones drawn on the design were left out of the score. */
	drawn_masks?: number;
	/** The correction made from the passes' findings, when it was asked for. */
	pass_fix?: DesignPassFix;
}

/** One correction from the passes' findings (`design_to_code.pass_fix`). */
export interface DesignPassFix {
	status: "nothing_to_fix" | "budget" | "failed" | "no_edits" | "regressed" | "no_gain" | "kept";
	/** Findings before and after the correction. */
	before: number;
	after?: number;
	budget_kind?: "tokens" | "cost";
	detail?: string;
	applied_edits?: number;
	refused_edits?: { path: string; reason: string }[];
	notes?: string[];
	tokens?: number;
	cost_usd?: number | null;
	/** Score at the design's size, before and after the correction. */
	score_before?: number;
	score?: number;
	/** The findings it made disappear, as the runner wrote them (English). */
	resolved?: string[];
}

export interface DesignStackDetection {
	stack: DesignStack | null;
	style: DesignStyle | null;
	/** The files that gave the stack away, relative to the project. */
	evidence: string[];
	/** A design-system folder found in the project, relative to it. */
	designSystemPath: string | null;
}

export interface DesignFileToWrite {
	path: string;
	content: string;
}

export interface DesignWriteOutcome {
	written: { path: string; created: boolean }[];
	refused: { path: string; reason: "outside" | "protected" | "invalid" }[];
	/** The review card the files were committed to (never the project folder). */
	review?: GeneratedReview | null;
}

/**
 * The project's own figures of the render loop (main/design-loop-history.ts),
 * read from `.workpilot/design-to-code/` on this computer: nothing is sent.
 */
export interface DesignLoopStats {
	/** Loops that ran (a skipped loop measured nothing and is not counted). */
	loops: number;
	converged: number;
	/** Mean of the score each loop kept, over every loop that ran. */
	averageScore: number | null;
	/** Mean number of corrections of the loops that converged. */
	averageIterations: number | null;
	/** Writes recorded, and what became of their files (an approximation). */
	writes: number;
	/** Every file still as written, in the project folder. */
	kept: number;
	/** Every file still as written, on the review card's branch not merged yet. */
	pending: number;
	/** A file changed or gone: retouched, or not merged. */
	retouched: number;
}
