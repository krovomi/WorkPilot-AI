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
	};
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
