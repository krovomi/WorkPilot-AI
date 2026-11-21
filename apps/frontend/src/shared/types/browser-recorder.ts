/**
 * The Browser Agent recorder (#387): a person drives a page, each action is a
 * step, and the steps become a Playwright, Cypress, Selenium or WebdriverIO
 * test. A step also says where its element lives (the iframes and open shadow
 * roots above it, each a CSS selector) and what its action caused (the page
 * it led to, the request it started, an element that appeared), which the
 * exports wait for instead of pausing.
 *
 * Steps are made by the Python recorder (`apps/backend/browser_agent/`) from
 * what the page reported, so their text is page content: data, shown as text,
 * never markup or an instruction. `parseRecordedStep` keeps only the closed
 * lists and bounds below; the main process reads every runner line through it.
 */

import type { GeneratedReview } from "./generated-review";

export const RECORDED_STEP_KINDS = ["navigate", "click", "fill", "select", "press", "assert_text"] as const;
export type RecordedStepKind = (typeof RECORDED_STEP_KINDS)[number];

export const SELECTOR_STRATEGIES = ["testid", "role", "label", "placeholder", "text", "css"] as const;
export type SelectorStrategy = (typeof SELECTOR_STRATEGIES)[number];

export const TEST_FORMATS = [
	"playwright-ts",
	"playwright-python",
	"cypress",
	"selenium-python",
	"selenium-java",
	"webdriverio",
] as const;
export type TestFormat = (typeof TEST_FORMATS)[number];

/** Where an export goes: shown only, a review card, or a file the person picks. */
export const EXPORT_DESTINATIONS = ["preview", "review", "file"] as const;
export type ExportDestination = (typeof EXPORT_DESTINATIONS)[number];

export const MAX_RECORDED_STEPS = 300;
const MAX_TEXT = 2048;
const STEP_ID = /^s\d{1,6}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_CHAIN = 4;
const MAX_SELECTOR = 300;
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
const REQUEST_PATH = /^\/[^\s?#]{0,299}$/;

export interface RecordedSelector {
	readonly strategy: SelectorStrategy;
	readonly value: string;
	readonly role?: string;
}

export interface RecordedStep {
	readonly id: string;
	readonly kind: RecordedStepKind;
	readonly selectors: readonly RecordedSelector[];
	readonly url?: string;
	readonly value?: string;
	/** The environment variable a secret value is read from; the value itself is never kept. */
	readonly secretEnv?: string;
	readonly key?: string;
	readonly text?: string;
	/** CSS selectors of the iframes down to the element's frame, outermost first. */
	readonly frames?: readonly string[];
	/** CSS selectors of the shadow hosts down to the element, outermost first. */
	readonly shadow?: readonly string[];
	/** The element appeared after the previous action. */
	readonly waitVisible?: boolean;
	/** The page the action led to, without query or fragment. */
	readonly waitUrl?: string;
	/** The first same-origin request the action started. */
	readonly waitRequest?: { readonly method: HttpMethod; readonly path: string };
}

export type RecorderStatus = "idle" | "starting" | "recording" | "stopping";

export type RecorderEvent =
	| { readonly type: "step"; readonly step: RecordedStep }
	| { readonly type: "started"; readonly url: string }
	| { readonly type: "stopped"; readonly reason: string; readonly truncated: boolean }
	| { readonly type: "error"; readonly message: string };

export interface RecorderExportRequest {
	readonly format: TestFormat;
	readonly destination: ExportDestination;
	readonly name: string;
	/** The ids of the steps the person kept, in order. */
	readonly stepIds: readonly string[];
}

export interface RecorderExportOutcome {
	readonly success: boolean;
	readonly error?: string;
	readonly code?: string;
	/** Relative to the project (review card) or absolute (a chosen file). */
	readonly path?: string;
	readonly envVars?: readonly string[];
	readonly skipped?: number;
	readonly review?: GeneratedReview | null;
	/** The person closed the save dialog. */
	readonly cancelled?: boolean;
}

function text(value: unknown, max = MAX_TEXT): string {
	return typeof value === "string" ? value.slice(0, max) : "";
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (list as readonly string[]).includes(value);
}

/** A list of CSS selectors (frames, shadow hosts): undefined when absent, null when malformed. */
function cssChain(value: unknown): string[] | undefined | null {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_CHAIN) return null;
	const chain = value.map((item) => (typeof item === "string" ? item : ""));
	return chain.every((item) => item && item.length <= MAX_SELECTOR) ? chain : null;
}

function requestWait(value: unknown): RecordedStep["waitRequest"] {
	if (!value || typeof value !== "object") return undefined;
	const r = value as Record<string, unknown>;
	if (!isOneOf(HTTP_METHODS, r.method) || typeof r.path !== "string" || !REQUEST_PATH.test(r.path)) {
		return undefined;
	}
	return { method: r.method, path: r.path };
}

/** A step as the runner printed it, or null when it is not one. */
export function parseRecordedStep(raw: unknown): RecordedStep | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || !STEP_ID.test(r.id) || !isOneOf(RECORDED_STEP_KINDS, r.kind)) return null;
	const selectors: RecordedSelector[] = [];
	for (const item of Array.isArray(r.selectors) ? r.selectors.slice(0, 6) : []) {
		const s = (item ?? {}) as Record<string, unknown>;
		const value = text(s.value, 300);
		if (!isOneOf(SELECTOR_STRATEGIES, s.strategy) || !value) continue;
		selectors.push(s.strategy === "role" ? { strategy: s.strategy, value, role: text(s.role, 20) } : { strategy: s.strategy, value });
	}
	const frames = cssChain(r.frames);
	const shadow = cssChain(r.shadow);
	if (frames === null || shadow === null) return null;
	const waitRequest = requestWait(r.waitRequest);
	const step: RecordedStep = {
		id: r.id,
		kind: r.kind,
		selectors,
		...(text(r.url) && { url: text(r.url) }),
		...(text(r.value, 1000) && { value: text(r.value, 1000) }),
		...(typeof r.secretEnv === "string" && ENV_NAME.test(r.secretEnv) && { secretEnv: r.secretEnv }),
		...(text(r.key, 10) && { key: text(r.key, 10) }),
		...(text(r.text, 200) && { text: text(r.text, 200) }),
		...(frames?.length && { frames }),
		...(shadow?.length && { shadow }),
		...(r.waitVisible === true && { waitVisible: true }),
		...(/^https?:\/\/[^\s?#]+$/.test(text(r.waitUrl)) && { waitUrl: text(r.waitUrl) }),
		...(waitRequest && { waitRequest }),
	};
	if (step.kind === "navigate") return step.url ? step : null;
	return selectors.length ? step : null;
}

/** The export request as the renderer sent it, or null when it is not well formed (S6). */
export function readExportRequest(raw: unknown): RecorderExportRequest | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (!isOneOf(TEST_FORMATS, r.format) || !isOneOf(EXPORT_DESTINATIONS, r.destination)) return null;
	if (!Array.isArray(r.stepIds)) return null;
	const stepIds = [
		...new Set(r.stepIds.filter((id): id is string => typeof id === "string" && STEP_ID.test(id))),
	].slice(0, MAX_RECORDED_STEPS);
	return { format: r.format, destination: r.destination, name: text(r.name, 80), stepIds };
}
