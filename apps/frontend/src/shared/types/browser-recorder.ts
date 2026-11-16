/**
 * The Browser Agent recorder (#387): a person drives a page, each action is a
 * step, and the steps become a Playwright or Cypress test.
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

export const TEST_FORMATS = ["playwright-ts", "playwright-python", "cypress"] as const;
export type TestFormat = (typeof TEST_FORMATS)[number];

/** Where an export goes: shown only, a review card, or a file the person picks. */
export const EXPORT_DESTINATIONS = ["preview", "review", "file"] as const;
export type ExportDestination = (typeof EXPORT_DESTINATIONS)[number];

export const MAX_RECORDED_STEPS = 300;
const MAX_TEXT = 2048;
const STEP_ID = /^s\d{1,6}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

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
	const step: RecordedStep = {
		id: r.id,
		kind: r.kind,
		selectors,
		...(text(r.url) && { url: text(r.url) }),
		...(text(r.value, 1000) && { value: text(r.value, 1000) }),
		...(typeof r.secretEnv === "string" && ENV_NAME.test(r.secretEnv) && { secretEnv: r.secretEnv }),
		...(text(r.key, 10) && { key: text(r.key, 10) }),
		...(text(r.text, 200) && { text: text(r.text, 200) }),
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
