import type { SpecCreationMetadata } from "./types";

/**
 * The model and effort of the spec pipeline.
 *
 * A task that owns its engine (`engineLocked`) names its spec phase and is
 * read as such. A legacy task is read the old way: the Kanban planning row
 * owned both spec creation and implementation planning.
 */
export function buildSpecModelArgs(metadata?: SpecCreationMetadata): string[] {
	const args: string[] = [];
	if (metadata?.provider) args.push("--provider", metadata.provider);
	const [first, second] = metadata?.engineLocked
		? (["spec", "planning"] as const)
		: (["planning", "spec"] as const);
	const model =
		metadata?.phaseModels?.[first] ||
		metadata?.phaseModels?.[second] ||
		metadata?.model;
	const effort =
		metadata?.phaseThinking?.[first] ||
		metadata?.phaseThinking?.[second] ||
		metadata?.thinkingLevel;
	if (model) args.push("--model", model);
	if (effort) args.push("--thinking-level", effort);
	return args;
}
