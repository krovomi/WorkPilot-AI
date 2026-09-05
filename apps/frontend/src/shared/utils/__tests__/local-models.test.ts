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
	isHostedOnlyModel,
	isLocalProvider,
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
