import type { SpecCreationMetadata } from "./types";

/** The Kanban planning row owns both spec creation and implementation planning. */
export function buildSpecModelArgs(metadata?: SpecCreationMetadata): string[] {
	const args: string[] = [];
	if (metadata?.provider) args.push("--provider", metadata.provider);
	const model =
		metadata?.phaseModels?.planning ||
		metadata?.phaseModels?.spec ||
		metadata?.model;
	const effort =
		metadata?.phaseThinking?.planning ||
		metadata?.phaseThinking?.spec ||
		metadata?.thinkingLevel;
	if (model) args.push("--model", model);
	if (effort) args.push("--thinking-level", effort);
	return args;
}
