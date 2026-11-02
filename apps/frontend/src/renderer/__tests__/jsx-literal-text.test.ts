/**
 * No English (or French) sentence is written straight into renderer JSX.
 *
 * The locale files were at parity while about a thousand literals still sat
 * in components — `<Button>Cancel</Button>`, `placeholder="Search issues..."`,
 * `{ok ? "Saved!" : "Save"}` — so a French user read English (and, in a few
 * settings panels, an English user read French). Parity tests only see the
 * JSON; this one reads the components.
 *
 * Biome 2.5.11 has `style/noJsxLiterals`, but it flags every literal,
 * punctuation and symbols included (`*`, `—`, `•`, `/`), offers only an exact
 * string allowlist, and its only exemption is a Biome suppression comment,
 * whose count per file is capped by a baseline under `tests/baselines/`. So
 * the renderer is parsed with the
 * same parser Vite uses (`parseAst`, oxc) and three places are checked:
 *
 *   - text between tags (`JSXText`) that contains a letter;
 *   - a string or template literal rendered as a child, directly or through a
 *     `?:` / `||` / `??` / `&&` branch (`{busy ? "Saving..." : t("save")}`);
 *   - the attributes a user reads or hears: `title`, `placeholder`, `alt`,
 *     `aria-label`, `label`, `description`.
 *
 * What may stay literal, and why, is in `jsx-literal-allowlist.ts`.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseAst } from "vite";
import { describe, expect, it } from "vitest";
import {
	FILE_EXEMPTIONS,
	NAMES,
	PENDING,
	TERMS,
	VERBATIM_ELEMENTS,
} from "./jsx-literal-allowlist";

const RENDERER = path.resolve(import.meta.dirname, "..");

/** Stands for an interpolation when a template literal is reported. */
const SLOT = "{…}";

const READ_ATTRIBUTES = new Set([
	"title",
	"placeholder",
	"alt",
	"aria-label",
	"label",
	"description",
]);

interface AstNode {
	readonly type: string;
	readonly start: number;
	readonly end: number;
	readonly [key: string]: unknown;
}

interface Finding {
	readonly file: string;
	readonly line: number;
	/** Text as reported: `@attr=value` for an attribute, `?value` for an expression. */
	readonly text: string;
}

const isNode = (value: unknown): value is AstNode =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { type?: unknown }).type === "string";

const ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	middot: "·",
	nbsp: " ",
	quot: '"',
};

/** Collapse whitespace and decode the entities JSX text may carry. */
function normalize(raw: string): string {
	return raw
		.replaceAll(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity: string) => {
			if (entity.startsWith("#")) {
				const hex = entity[1]?.toLowerCase() === "x";
				return String.fromCodePoint(
					Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10),
				);
			}
			return ENTITIES[entity] ?? match;
		})
		.replaceAll(/\s+/g, " ")
		.trim();
}

const hasLetter = (text: string) => /\p{L}/u.test(text);

/** A bare domain or URL shown as link text (`cli.github.com`). */
const isAddress = (value: string) =>
	/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(value);

/** True when the value is a name, an address, a term or symbols, not a sentence. */
function isTermsOnly(value: string): boolean {
	if (NAMES.has(value) || isAddress(value)) return true;
	const words = value.match(/\p{L}+/gu) ?? [];
	return words.every((word) => word.length === 1 || TERMS.has(word));
}

/** A one-token placeholder that shows an input, not an instruction. */
function isExampleValue(value: string): boolean {
	return (
		!/\s/.test(value) &&
		(/^[a-z]/.test(value) || /[/:_@#$^\\{0-9]/.test(value))
	);
}

function elementName(node: AstNode): string | undefined {
	const opening = node.openingElement;
	if (!isNode(opening) || !isNode(opening.name)) return undefined;
	const name = opening.name.name;
	return typeof name === "string" ? name : undefined;
}

function scanSource(file: string, source: string): Finding[] {
	const program = parseAst(source, { lang: "tsx" }) as unknown as AstNode;
	const findings: Finding[] = [];
	const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
	const report = (node: AstNode, text: string) =>
		findings.push({ file, line: lineOf(node.start), text });

	const literalLeaves = (expression: unknown, out: AstNode[]) => {
		if (!isNode(expression)) return;
		switch (expression.type) {
			case "Literal":
				if (typeof expression.value === "string") out.push(expression);
				return;
			case "TemplateLiteral":
				out.push(expression);
				return;
			case "ConditionalExpression":
				literalLeaves(expression.consequent, out);
				literalLeaves(expression.alternate, out);
				return;
			case "LogicalExpression":
				literalLeaves(expression.right, out);
				if (expression.operator !== "&&") literalLeaves(expression.left, out);
				return;
			default:
				return;
		}
	};

	const visit = (node: AstNode, parent: AstNode | null, verbatim: boolean) => {
		const inVerbatim =
			verbatim ||
			(node.type === "JSXElement" &&
				VERBATIM_ELEMENTS.has(elementName(node) ?? ""));
		const isChild =
			parent !== null &&
			(parent.type === "JSXElement" || parent.type === "JSXFragment");

		if (node.type === "JSXText" && !inVerbatim) {
			const text = normalize(String(node.value));
			if (hasLetter(text) && !isTermsOnly(text)) report(node, text);
		}

		if (node.type === "JSXExpressionContainer" && isChild && !inVerbatim) {
			const leaves: AstNode[] = [];
			literalLeaves(node.expression, leaves);
			for (const leaf of leaves) {
				const raw =
					leaf.type === "Literal"
						? String(leaf.value)
						: (leaf.quasis as AstNode[])
								.map((quasi) => (quasi.value as { cooked: string }).cooked)
								.join(SLOT);
				const text = normalize(raw);
				if (hasLetter(text) && !isTermsOnly(text)) report(leaf, `?${text}`);
			}
		}

		if (node.type === "JSXAttribute" && isNode(node.name)) {
			const name = String(node.name.name);
			const value = node.value;
			if (
				READ_ATTRIBUTES.has(name) &&
				isNode(value) &&
				value.type === "Literal" &&
				typeof value.value === "string"
			) {
				const text = normalize(value.value);
				const example = name === "placeholder" && isExampleValue(text);
				if (hasLetter(text) && !isTermsOnly(text) && !example) {
					report(value, `@${name}=${text}`);
				}
			}
		}

		for (const [key, child] of Object.entries(node)) {
			if (key === "type" || key === "start" || key === "end") continue;
			const children = Array.isArray(child) ? child : [child];
			for (const item of children) {
				if (isNode(item)) visit(item, node, inVerbatim);
			}
		}
	};

	visit(program, null, false);
	return findings;
}

const isScanned = (name: string) =>
	name.endsWith(".tsx") && !/\.(test|spec|stories)\.tsx$/.test(name);

function rendererFiles(dir = RENDERER): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (entry.name === "__tests__" || entry.name === "__mocks__") continue;
			files.push(...rendererFiles(path.join(dir, entry.name)));
		} else if (isScanned(entry.name)) {
			files.push(path.join(dir, entry.name));
		}
	}
	return files;
}

function scanRenderer(): Finding[] {
	return rendererFiles().flatMap((absolute) => {
		const file = path.relative(RENDERER, absolute).split(path.sep).join("/");
		return scanSource(file, readFileSync(absolute, "utf-8"));
	});
}

const isExempt = (finding: Finding) =>
	(FILE_EXEMPTIONS[finding.file] ?? []).some(
		(exemption) => exemption.text === finding.text,
	);

describe("renderer JSX literal text", () => {
	const findings = scanRenderer();

	it("finds the literals it is meant to find", () => {
		const sample = [
			'export const A = () => <button title="Close panel">Cancel</button>;',
			'export const B = ({ busy }: { busy: boolean }) => <p>{busy ? "Saving..." : t("x")}</p>;',
			'export const C = () => <input placeholder="Search issues..." aria-label="Search" />;',
			`export const D = () => <p>{\`\${n} files changed\`}</p>;`,
		].join("\n");
		expect(scanSource("sample.tsx", sample).map((f) => f.text)).toEqual([
			"@title=Close panel",
			"Cancel",
			"?Saving...",
			"@placeholder=Search issues...",
			"@aria-label=Search",
			`?${SLOT} files changed`,
		]);
	});

	it("lets names, symbols, verbatim text and example values through", () => {
		const sample = [
			"export const A = () => <span>GitHub Copilot</span>;",
			"export const B = () => <span>{n} MB / {m} ms · {k}x</span>;",
			"export const C = () => <code>git status</code>;",
			'export const D = () => <input placeholder="owner/repo" />;',
			'export const E = () => <input placeholder="main" />;',
			"export const F = () => <span>{t('a')} *</span>;",
		].join("\n");
		expect(scanSource("sample.tsx", sample)).toEqual([]);
	});

	it("leaves no literal text outside t() in renderer JSX", () => {
		const offending = findings.filter(
			(finding) => !isExempt(finding) && !(finding.file in PENDING),
		);
		const report = offending
			.map((f) => `  src/renderer/${f.file}:${f.line}  ${f.text}`)
			.join("\n");
		expect(
			offending,
			`Literal text in JSX. Use t() with a key in both locales/en and locales/fr, or add a documented exemption to jsx-literal-allowlist.ts:\n${report}`,
		).toEqual([]);
	});

	it("keeps every file exemption in use", () => {
		const stale = Object.entries(FILE_EXEMPTIONS).flatMap(([file, entries]) =>
			entries
				.filter(
					(entry) =>
						!findings.some((f) => f.file === file && f.text === entry.text),
				)
				.map((entry) => `${file}: ${entry.text}`),
		);
		expect(stale, "Remove exemptions that no longer match").toEqual([]);
	});

	it("only lets the pending baseline shrink", () => {
		const counts: Record<string, number> = {};
		for (const finding of findings) {
			if (finding.file in PENDING) {
				counts[finding.file] = (counts[finding.file] ?? 0) + 1;
			}
		}
		const pending = Object.entries(PENDING).map(([file, allowed]) => ({
			file,
			allowed,
			actual: counts[file] ?? 0,
		}));
		const left = pending.filter((entry) => entry.actual > 0);
		if (left.length > 0) {
			console.info(
				`JSX literals left in files pending another branch:\n${left
					.map((e) => `  src/renderer/${e.file}: ${e.actual}`)
					.join("\n")}`,
			);
		}
		const changed = pending.filter((entry) => entry.actual !== entry.allowed);
		expect(
			changed,
			"Update PENDING in jsx-literal-allowlist.ts: a count may only go down, and an entry at 0 is removed",
		).toEqual([]);
	});
});
