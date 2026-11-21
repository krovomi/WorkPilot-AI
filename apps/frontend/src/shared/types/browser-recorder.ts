/**
 * The Browser Agent recorder (#387): a person drives a page, each action is a
 * step, and the steps become a Playwright, Cypress, Selenium or WebdriverIO
 * test. A step also says where its element lives (the iframes and open shadow
 * roots above it, each a CSS selector) and what its action caused (the page
 * it led to, the request it started, an element that appeared), which the
 * exports wait for instead of pausing. A selector that matches several
 * elements carries the element's place among them (`nth`). A step with
 * `after` is a check the recorder proposes after that action: the person
 * keeps it or not. A step may also hover, scroll (no selector: the window),
 * drag onto another element (`drop`), pick several options (`values`), and
 * carry the answer the person gave in the app to the dialog its action
 * opened (`dialog`); an iframe inside open shadow roots names their hosts
 * (`frameShadow`, one list per frame).
 *
 * Steps are made by the Python recorder (`apps/backend/browser_agent/`) from
 * what the page reported, so their text is page content: data, shown as text,
 * never markup or an instruction. `parseRecordedStep` keeps only the closed
 * lists and bounds below; the main process reads every runner line through it.
 */

import type { GeneratedReview } from "./generated-review";

export const RECORDED_STEP_KINDS = [
	"navigate",
	"click",
	"fill",
	"select",
	"press",
	"assert_text",
	"hover",
	"scroll",
	"drag",
] as const;
export type RecordedStepKind = (typeof RECORDED_STEP_KINDS)[number];

export const SELECTOR_STRATEGIES = ["testid", "role", "label", "placeholder", "text", "css"] as const;
export type SelectorStrategy = (typeof SELECTOR_STRATEGIES)[number];

export const TEST_FORMATS = [
	"playwright-ts",
	"playwright-python",
	"cypress",
	"selenium-python",
	"selenium-java",
	"selenium-csharp",
	"selenium-ruby",
	"selenium-js",
	"webdriverio",
	"webdriverio-ts",
] as const;
export type TestFormat = (typeof TEST_FORMATS)[number];

/** Where an export goes: shown only, a review card, or a file the person picks. */
export const EXPORT_DESTINATIONS = ["preview", "review", "file"] as const;
export type ExportDestination = (typeof EXPORT_DESTINATIONS)[number];

export const MAX_RECORDED_STEPS = 300;
const MAX_TEXT = 2048;
const STEP_ID = /^s\d{1,6}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_CHAIN = 8;
const MAX_VALUES = 20;
const MAX_SCROLL = 10_000_000;
export const DRAG_MODES = ["html5", "pointer"] as const;
export const DIALOG_TYPES = ["alert", "confirm", "prompt", "beforeunload"] as const;
export type DialogType = (typeof DIALOG_TYPES)[number];
const MAX_SELECTOR = 300;
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
const REQUEST_PATH = /^\/[^\s?#]{0,299}$/;
/** A selector matching more elements than this is not kept, even with a place. */
const MAX_MATCHES = 20;
/** The selectors a loading indicator is waited for by (built by the recorder from these patterns only). */
const LOADER =
	/^(?:\[data-testid="(?:[^"\\]|\\.)+"\]|#[A-Za-z][A-Za-z0-9_-]*|\[role="progressbar"\]|\[aria-busy="true"\]|\.[A-Za-z_-][A-Za-z0-9_-]*)$/;
/** At most this many proposed checks per session. */
export const MAX_SUGGESTIONS = 100;

export interface RecordedSelector {
	readonly strategy: SelectorStrategy;
	readonly value: string;
	readonly role?: string;
	/** The element's place among those the selector matches, when not unique. */
	readonly nth?: number;
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
	/** A loading indicator the action showed: the replay waits until none shows. */
	readonly waitHidden?: string;
	/** A proposed check (`assert_text`): the id of the action it follows. */
	readonly after?: string;
	/** The options picked in a multiple-choice list. */
	readonly values?: readonly string[];
	/** Where a `scroll` step scrolls to. */
	readonly scrollX?: number;
	readonly scrollY?: number;
	/** The element a `drag` step drops onto, and how the page listened to the drag. */
	readonly drop?: readonly RecordedSelector[];
	readonly dragMode?: (typeof DRAG_MODES)[number];
	/** The answer the person gave to the dialog the action opened. */
	readonly dialog?: DialogAnswer;
	/** The open shadow hosts above each iframe of `frames`. */
	readonly frameShadow?: readonly (readonly string[])[];
}

export interface DialogAnswer {
	readonly type: DialogType;
	readonly accept: boolean;
	readonly text?: string;
	/** The dialog's message: page text, shown as text. */
	readonly message?: string;
}

/** A dialog the page opened while recording, waiting for the person's answer. */
export interface PendingDialog {
	readonly id: number;
	readonly type: DialogType;
	readonly message: string;
	readonly defaultValue: string;
}

export type RecorderStatus = "idle" | "starting" | "recording" | "stopping";

export type RecorderEvent =
	| { readonly type: "step"; readonly step: RecordedStep }
	| { readonly type: "started"; readonly url: string }
	| { readonly type: "stopped"; readonly reason: string; readonly truncated: boolean }
	| { readonly type: "dialog"; readonly dialog: PendingDialog }
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

function parseSelectors(raw: unknown): RecordedSelector[] {
	const selectors: RecordedSelector[] = [];
	for (const item of Array.isArray(raw) ? raw.slice(0, 6) : []) {
		const s = (item ?? {}) as Record<string, unknown>;
		const value = text(s.value, 300);
		if (!isOneOf(SELECTOR_STRATEGIES, s.strategy) || !value) continue;
		const placed = typeof s.nth === "number" && Number.isInteger(s.nth) && s.nth >= 0 && s.nth < MAX_MATCHES;
		if (s.nth !== undefined && !placed) continue;
		selectors.push({
			strategy: s.strategy,
			value,
			...(s.strategy === "role" && { role: text(s.role, 20) }),
			...(placed && { nth: s.nth as number }),
		});
	}
	return selectors;
}

function isScroll(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_SCROLL;
}

/** The answer to a dialog, as the runner printed it, or undefined. */
function dialogAnswer(value: unknown): DialogAnswer | undefined {
	if (!value || typeof value !== "object") return undefined;
	const d = value as Record<string, unknown>;
	if (!isOneOf(DIALOG_TYPES, d.type) || typeof d.accept !== "boolean") return undefined;
	return {
		type: d.type,
		accept: d.accept,
		...(d.accept && d.type === "prompt" && text(d.text, 1000) && { text: text(d.text, 1000) }),
		...(text(d.message, 200) && { message: text(d.message, 200) }),
	};
}

/** The shadow hosts above each of `frames` iframes: undefined when absent, null when malformed. */
function frameShadowOf(value: unknown, frames: number): string[][] | undefined | null {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length !== frames) return null;
	const chains = value.map((item) => cssChain(item) ?? null);
	if (chains.some((chain) => chain === null)) return null;
	return chains as string[][];
}

/** A step as the runner printed it, or null when it is not one. */
export function parseRecordedStep(raw: unknown): RecordedStep | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || !STEP_ID.test(r.id) || !isOneOf(RECORDED_STEP_KINDS, r.kind)) return null;
	const selectors = parseSelectors(r.selectors);
	const frames = cssChain(r.frames);
	const shadow = cssChain(r.shadow);
	const frameShadow = frameShadowOf(r.frameShadow, frames?.length ?? 0);
	if (frames === null || shadow === null || frameShadow === null) return null;
	const waitRequest = requestWait(r.waitRequest);
	const drop = parseSelectors(r.drop);
	const dialog = dialogAnswer(r.dialog);
	const values = Array.isArray(r.values) && r.values.length > 1 && r.values.length <= MAX_VALUES
		? r.values.map((v) => text(v, 200))
		: [];
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
		...(typeof r.waitHidden === "string" &&
			r.waitHidden.length <= MAX_SELECTOR &&
			LOADER.test(r.waitHidden) && { waitHidden: r.waitHidden }),
		...(r.kind === "assert_text" && typeof r.after === "string" && STEP_ID.test(r.after) && { after: r.after }),
		...(r.kind === "select" && values.length && { values }),
		...(r.kind === "scroll" && isScroll(r.scrollX) && isScroll(r.scrollY) && { scrollX: r.scrollX, scrollY: r.scrollY }),
		...(r.kind === "drag" && drop.length && isOneOf(DRAG_MODES, r.dragMode) && { drop, dragMode: r.dragMode }),
		...(dialog && { dialog }),
		...(frameShadow?.some((hosts) => hosts.length) && { frameShadow }),
	};
	if (step.kind === "navigate") return step.url ? step : null;
	if (step.kind === "scroll" && step.scrollX === undefined) return null;
	if (step.kind === "drag" && !step.drop) return null;
	// Only a scroll of the top window names no element.
	return selectors.length || (step.kind === "scroll" && !frames?.length && !shadow?.length) ? step : null;
}

/** The person's answer to a pending dialog, as the renderer sent it, or null (S6). */
export function readDialogAnswer(raw: unknown): { id: number; accept: boolean; text: string } | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "number" || !Number.isSafeInteger(r.id) || r.id < 1) return null;
	if (typeof r.accept !== "boolean") return null;
	if (r.text !== undefined && typeof r.text !== "string") return null;
	return { id: r.id, accept: r.accept, text: text(r.text, 1000) };
}

/** A dialog the runner asks the app to answer, or null. */
export function parsePendingDialog(raw: unknown): PendingDialog | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "number" || !Number.isSafeInteger(r.id) || r.id < 1) return null;
	if (!isOneOf(DIALOG_TYPES, r.type)) return null;
	return { id: r.id, type: r.type, message: text(r.message, 200), defaultValue: text(r.defaultValue, 200) };
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
