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

/**
 * Ollama's implicit tag.
 *
 * `llama3.3` and `llama3.3:latest` are the same model: the bare name IS the
 * `:latest` tag. Nothing else collapses — `llama3.3:70b` is a genuinely
 * different artefact, and asking Ollama for the bare `llama3.3` when only
 * `:70b` is on disk makes it go and pull `:latest`.
 */
export function canonicalLocalModelName(
	name: string | undefined | null,
): string {
	const id = (name ?? "").trim().toLowerCase();
	return id.endsWith(":latest") ? id.slice(0, -":latest".length) : id;
}

/** True when two local model names denote the same artefact. */
export function isSameLocalModel(
	a: string | undefined | null,
	b: string | undefined | null,
): boolean {
	const left = canonicalLocalModelName(a);
	return left.length > 0 && left === canonicalLocalModelName(b);
}

/**
 * The catalogue row that is not a model.
 *
 * `{ value: "custom", label: "Autre (saisie libre)" }` sits in the Ollama
 * catalogue as a sentinel: picking it is supposed to open a free-text field so
 * the user can name a tag the curated list does not carry (`qwen2.5-coder:7b`,
 * `hf.co/org/model`). It is NOT a model id, and any code that forwards it to a
 * server asks Ollama to pull an image literally called "custom" — which fails
 * with "pull model manifest: file does not exist".
 */
export const CUSTOM_MODEL_SENTINEL = "custom";

/** True when `value` is the free-text placeholder rather than a model id. */
export function isCustomModelSentinel(value: string | undefined | null): boolean {
	return (value ?? "").trim().toLowerCase() === CUSTOM_MODEL_SENTINEL;
}

interface LocalCatalogEntry {
	value: string;
	label: string;
	installed?: boolean;
}

/**
 * Collapse a local provider's catalog to one row per model, and mark which
 * rows are on the server.
 *
 * Two sources feed the dropdown: the live `/api/tags` listing (real tags, e.g.
 * `llama3.3:latest`) and a curated static list of pullable names (`llama3.3`,
 * labelled "Llama 3.3"). The generic catalog dedupe cannot merge those — it
 * keys on a Claude-shaped identity that knows nothing about Ollama tags — so a
 * model the user had just pulled appeared TWICE: once as the installed tag and
 * once as a suggestion still offering to download it. Neither row was usable,
 * because the exact-string `installed` check also failed to recognise that the
 * bare name was the tag on disk.
 *
 * The surviving row takes the installed tag as its `value` — that is the name
 * the server will actually answer for — and keeps the curated `label` when
 * there is one, because "Llama 3.3" is what the user recognises.
 */
export function dedupeLocalCatalog<T extends LocalCatalogEntry>(
	entries: readonly T[],
	installedNames: readonly string[],
): T[] {
	const installed = new Set(installedNames.map(canonicalLocalModelName));
	const byModel = new Map<string, T>();
	const order: string[] = [];

	for (const entry of entries) {
		const key = canonicalLocalModelName(entry.value);
		if (!key) continue;
		const seen = byModel.get(key);
		if (!seen) {
			byModel.set(key, { ...entry, installed: installed.has(key) });
			order.push(key);
			continue;
		}
		// A curated label is one that does not merely repeat its own value.
		const curatedLabel =
			seen.label !== seen.value
				? seen.label
				: entry.label !== entry.value
					? entry.label
					: seen.label;
		// Prefer the value the server actually reports, so the phase stores a
		// name Ollama can serve verbatim.
		const value = installed.has(canonicalLocalModelName(entry.value))
			? pickInstalledValue(seen.value, entry.value, installedNames)
			: seen.value;
		byModel.set(key, {
			...seen,
			...entry,
			value,
			label: curatedLabel,
			installed: installed.has(key),
		});
	}

	return order.map((k) => byModel.get(k) as T);
}

/** Of two spellings of one model, the one the server literally listed. */
function pickInstalledValue(
	a: string,
	b: string,
	installedNames: readonly string[],
): string {
	const listed = new Set(installedNames.map((n) => n.trim().toLowerCase()));
	if (listed.has(a.trim().toLowerCase())) return a;
	if (listed.has(b.trim().toLowerCase())) return b;
	return a;
}
