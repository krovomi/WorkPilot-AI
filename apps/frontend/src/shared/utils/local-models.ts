/**
 * Which model ids a locally-hosted server can actually serve.
 *
 * This mirrors `phase_config.is_hosted_only_model` / `is_local_provider` in the
 * backend, and it has to: the UI and the run must name the same model. When
 * they disagreed, the phase header showed "Llama 3.3" while the run asked
 * Ollama for `claude-opus-4-5-20251101` — and the only visible symptom was
 * seven copies of "pull model manifest: file does not exist".
 *
 * Keep the two in step. `tests/test_local_model_coercion.py` and
 * `local-models.test.ts` assert the same table of ids on each side.
 */

/** Providers backed by a server running on the user's own machine. */
const LOCAL_PROVIDERS = new Set(["ollama", "local", "lmstudio"]);

export function isLocalProvider(provider: string | undefined | null): boolean {
	return LOCAL_PROVIDERS.has((provider ?? "").trim().toLowerCase());
}

/**
 * Model families that only ever exist behind a hosted API.
 *
 * Deliberately narrow: a local server legitimately serves `mistral`,
 * `deepseek-r1`, `qwen2.5-coder` and `gemma3` — those names ARE in the Ollama
 * library — so anything wider would reject a model the user really has on disk.
 * Only the proprietary families nobody can pull are listed.
 */
const HOSTED_ONLY_MODEL =
	/^(claude-|chatgpt-|gpt-[0-9]|o[1-9](-|$)|gemini-|models\/gemini-|grok-|anthropic\.|swe-1)/i;

/** True when `model` is an API-only id that no local server can serve. */
export function isHostedOnlyModel(model: string | undefined | null): boolean {
	const id = (model ?? "").trim();
	return id.length > 0 && HOSTED_ONLY_MODEL.test(id);
}

/**
 * The model a local phase will really run.
 *
 * A stored id the local server cannot serve — typically left behind when a task
 * was switched to Ollama after being planned on Claude — resolves to the model
 * configured for the local provider, which is exactly what the backend does
 * with it. An id a local server CAN serve is kept, so a deliberate per-phase
 * pick (`qwen2.5-coder` for coding, say) is honoured rather than flattened onto
 * the global default.
 */
export function resolveLocalModel(
	storedModel: string | undefined | null,
	configuredLocalModel: string | undefined | null,
): string {
	const stored = (storedModel ?? "").trim();
	const configured = (configuredLocalModel ?? "").trim();
	if (!stored || isHostedOnlyModel(stored)) return configured || stored;
	return stored;
}
