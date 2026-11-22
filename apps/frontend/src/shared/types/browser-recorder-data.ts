/**
 * The values typed while recording, as the exported test's data (#387).
 *
 * The exporter (`apps/backend/browser_agent/codegen_data.py`) takes each value
 * typed into a field out of the test: the test reads it by a key from a data
 * file next to it (a JSON file, in Java a test resource of its package, or a
 * Cypress fixture). It also says what each key holds (`kind`), by rules, never
 * by a model. A secret's value is never data: the file holds only the name of
 * its environment variable, read by the test at run time.
 *
 * The runner's answer is read again here: a key in `[a-z0-9_]`, a kind in the
 * closed list, a data file whose path and JSON are strings. Where the file may
 * go is checked by `recorder-export.ts`.
 */

export const DATA_KINDS = ["email", "date", "number", "phone", "url", "name", "text"] as const;
export type DataKind = (typeof DATA_KINDS)[number];

/** One typed value: the key the test reads it by and what it holds (never the value). */
export interface TestDataValue {
	readonly name: string;
	readonly kind: DataKind;
}

/** The data file written next to the test: where (relative to the project) and its JSON. */
export interface TestFixture {
	readonly path: string;
	readonly code: string;
}

export interface TestData {
	readonly fixture?: TestFixture;
	readonly dataValues: readonly TestDataValue[];
}

const KEY = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_VALUES = 300;
const MAX_PATH = 1024;

function isKind(value: unknown): value is DataKind {
	return typeof value === "string" && (DATA_KINDS as readonly string[]).includes(value);
}

function readValue(raw: unknown): TestDataValue | null {
	if (!raw || typeof raw !== "object") return null;
	const { name, kind } = raw as Record<string, unknown>;
	return typeof name === "string" && KEY.test(name) && isKind(kind) ? { name, kind } : null;
}

function readFixture(raw: unknown): TestFixture | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const { path, code } = raw as Record<string, unknown>;
	if (typeof path !== "string" || typeof code !== "string" || !path || path.length > MAX_PATH) return undefined;
	return path.endsWith(".json") ? { path, code } : undefined;
}

/** The data part of the exporter's answer, through the closed lists above. */
export function readTestData(parsed: Record<string, unknown>): TestData {
	const values = Array.isArray(parsed.dataValues) ? parsed.dataValues.slice(0, MAX_VALUES) : [];
	const dataValues = values.map(readValue).filter((v): v is TestDataValue => v !== null);
	const fixture = readFixture(parsed.fixture);
	return fixture ? { fixture, dataValues } : { dataValues };
}
