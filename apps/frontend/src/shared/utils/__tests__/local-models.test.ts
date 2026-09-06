/**
 * The UI and the run must name the same model.
 *
 * These are the same two tables as `tests/test_local_model_coercion.py`, on the
 * TypeScript side. When the two rules drifted, the phase header read
 * "Llama 3.3" while the run asked Ollama for `claude-opus-4-5-20251101`, and
 * the user's only clue was seven copies of "pull model manifest: file does not
 * exist" — a message that names neither the model that was wrong nor why.
 */

import { describe, expect, it } from "vitest";

import {
	canonicalLocalModelName,
	dedupeLocalCatalog,
	isHostedOnlyModel,
	isLocalProvider,
	isSameLocalModel,
	resolveLocalModel,
} from "../local-models";

const HOSTED_ONLY = [
	"claude-opus-4-5-20251101",
	"claude-sonnet-4-6",
	"claude-opus-4.8",
	"claude-fable-5",
	"gpt-5.5",
	"gpt-4.1",
	"chatgpt-4o-latest",
	"o3",
	"o4-mini",
	"gemini-3.1-pro",
	"models/gemini-2.5-flash",
	"grok-4.3",
	"anthropic.claude-opus-4-7",
	"swe-1.6",
];

// Several of these belong to families that ALSO have a hosted API (Mistral,
// DeepSeek, Gemma) — which is precisely why the rule has to stay narrow.
const LOCAL_OK = [
	"llama3.3",
	"llama3.2",
	"mistral",
	"mistral-large",
	"mistral-large-3",
	"mixtral",
	"deepseek-r1",
	"deepseek-v3.2",
	"deepseek-coder-v2",
	"qwen2.5-coder",
	"qwen3-embedding:8b",
	"gemma3",
	"phi4",
	"codellama",
	"hf.co/bartowski/Qwen2.5-Coder-32B-Instruct-GGUF",
];

describe("isLocalProvider", () => {
	it.each(["ollama", "local", "lmstudio", "Ollama"])("accepts %s", (p) => {
		expect(isLocalProvider(p)).toBe(true);
	});

	it.each(["anthropic", "openai", "copilot", "", undefined, null])(
		"rejects %s",
		(p) => {
			expect(isLocalProvider(p)).toBe(false);
		},
	);
});

describe("isHostedOnlyModel", () => {
	it.each(HOSTED_ONLY)("recognises %s as hosted-only", (m) => {
		expect(isHostedOnlyModel(m)).toBe(true);
	});

	it.each(LOCAL_OK)("leaves %s alone", (m) => {
		expect(isHostedOnlyModel(m)).toBe(false);
	});

	it("treats an empty id as not hosted-only", () => {
		expect(isHostedOnlyModel("")).toBe(false);
		expect(isHostedOnlyModel(undefined)).toBe(false);
	});
});

describe("resolveLocalModel", () => {
	it("replaces a leftover Claude id with the configured local model", () => {
		// The exact case from the bug report: the task was planned on Claude and
		// later switched to Ollama, and the saved id came along for the ride.
		expect(resolveLocalModel("claude-opus-4-5-20251101", "llama3.3")).toBe(
			"llama3.3",
		);
	});

	it("keeps a deliberate per-phase local pick", () => {
		// Overriding this unconditionally — which the phase header used to do —
		// meant picking a coding model in the dropdown appeared to do nothing.
		expect(resolveLocalModel("qwen2.5-coder", "llama3.3")).toBe(
			"qwen2.5-coder",
		);
		expect(resolveLocalModel("hf.co/org/model-GGUF", "llama3.3")).toBe(
			"hf.co/org/model-GGUF",
		);
	});

	it("falls back to the configured model when nothing is stored", () => {
		expect(resolveLocalModel("", "llama3.3")).toBe("llama3.3");
		expect(resolveLocalModel(undefined, "llama3.3")).toBe("llama3.3");
	});

	it("keeps the stored id when no local model is configured", () => {
		// Nothing better to show. The backend's own fallback still applies at run
		// time; the header must not invent a model that was never chosen.
		expect(resolveLocalModel("claude-opus-4-6", "")).toBe("claude-opus-4-6");
	});
});

describe("canonicalLocalModelName", () => {
	it("treats a bare name and its :latest tag as one model", () => {
		// Ollama's implicit tag. This is the whole reason `llama3.3` and
		// `llama3.3:latest` appeared as two rows in the picker.
		expect(canonicalLocalModelName("llama3.3:latest")).toBe("llama3.3");
		expect(canonicalLocalModelName("llama3.3")).toBe("llama3.3");
		expect(isSameLocalModel("llama3.3", "llama3.3:latest")).toBe(true);
	});

	it("keeps a non-latest tag distinct", () => {
		// `llama3.3:70b` is a different artefact, and asking Ollama for the bare
		// name when only :70b is on disk makes it pull :latest.
		expect(isSameLocalModel("llama3.3", "llama3.3:70b")).toBe(false);
		expect(isSameLocalModel("qwen3-embedding", "qwen3-embedding:8b")).toBe(
			false,
		);
	});

	it("ignores case and surrounding space", () => {
		expect(isSameLocalModel(" Llama3.3 ", "llama3.3:LATEST")).toBe(true);
	});

	it("never matches an empty name", () => {
		expect(isSameLocalModel("", "")).toBe(false);
		expect(isSameLocalModel(undefined, null)).toBe(false);
	});
});

describe("dedupeLocalCatalog", () => {
	// What the picker actually receives: the live /api/tags listing first, then
	// the curated static suggestions.
	type Row = { value: string; label: string; installed?: boolean };
	const catalog: Row[] = [
		{ value: "llama3.3:latest", label: "llama3.3:latest" },
		{ value: "qwen3-embedding:8b", label: "qwen3-embedding:8b" },
		{ value: "llama3.3", label: "Llama 3.3" },
		{ value: "llama3.2", label: "Llama 3.2" },
	];

	it("shows an installed model once, not twice", () => {
		// The reported bug: after pulling Llama 3.3 the dropdown listed it twice
		// — once as the installed tag, once as a suggestion offering to download
		// the model the user had just downloaded.
		const rows = dedupeLocalCatalog(catalog, [
			"llama3.3:latest",
			"qwen3-embedding:8b",
		]);
		expect(rows.filter((r) => isSameLocalModel(r.value, "llama3.3"))).toHaveLength(
			1,
		);
		expect(rows).toHaveLength(3);
	});

	it("marks the surviving row installed", () => {
		// The exact-string check missed this, so the one row that WAS on disk
		// still rendered "↓ Télécharger".
		const rows = dedupeLocalCatalog(catalog, ["llama3.3:latest"]);
		const llama = rows.find((r) => isSameLocalModel(r.value, "llama3.3"));
		expect(llama?.installed).toBe(true);
	});

	it("keeps the curated label and the tag the server reported", () => {
		// The label is what the user recognises; the value is what Ollama will
		// answer for.
		const rows = dedupeLocalCatalog(catalog, ["llama3.3:latest"]);
		const llama = rows.find((r) => isSameLocalModel(r.value, "llama3.3"));
		expect(llama?.label).toBe("Llama 3.3");
		expect(llama?.value).toBe("llama3.3:latest");
	});

	it("leaves a model that is not installed downloadable", () => {
		const rows = dedupeLocalCatalog(catalog, ["llama3.3:latest"]);
		expect(rows.find((r) => r.value === "llama3.2")?.installed).toBe(false);
	});

	it("does not merge different tags of one family", () => {
		const rows = dedupeLocalCatalog<Row>(
			[
				{ value: "llama3.3:8b", label: "llama3.3:8b" },
				{ value: "llama3.3:70b", label: "llama3.3:70b" },
			],
			["llama3.3:8b", "llama3.3:70b"],
		);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.installed)).toBe(true);
	});

	it("preserves the catalog order", () => {
		const rows = dedupeLocalCatalog(catalog, ["llama3.3:latest"]);
		expect(rows.map((r) => r.label)).toEqual([
			"Llama 3.3",
			"qwen3-embedding:8b",
			"Llama 3.2",
		]);
	});

	it("drops entries with no name", () => {
		const rows = dedupeLocalCatalog<Row>([{ value: "", label: "" }], []);
		expect(rows).toHaveLength(0);
	});
});
