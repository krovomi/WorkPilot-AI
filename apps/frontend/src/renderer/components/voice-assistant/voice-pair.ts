import type { Task } from "@shared/types";

/**
 * Pair mode (issue #385): in the continuous mode, the assistant follows one
 * running task. It says what the task does (`voice-narration.ts`), and a
 * sentence that is not a command becomes a message to its agent, sent after a
 * spoken « yes » through the task's steering queue
 * (`docs/architecture/steering.md`), which every provider's build reads at its
 * next session. The sentence is the person's own words: it never goes to a
 * model to be read, only to the agent they are guiding.
 */

/** The tasks an agent is working on now: those the assistant can follow. */
export function followableTasks(tasks: readonly Task[]): Task[] {
	return tasks.filter(
		(task) => task.metadata?.abandoned !== true && (task.status === "in_progress" || task.status === "ai_review"),
	);
}

/** Said first, these make the rest of the sentence a message, even when it reads like a command. */
const PREFIXES = ["dis lui", "dis a l agent", "demande lui", "tell it", "tell the agent", "ask it", "ask the agent"];
/** The joining word after the formula (« dis-lui d'ajouter », « tell it to add »). */
const JOINER = /^(?:d['’]|de\s|qu['’]|que\s|to\s|that\s)/iu;

function plain(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * The message in a sentence that starts with « tell it… » / « dis-lui… »,
 * without that formula, or null when it does not start with one.
 */
export function readGuidance(sentence: string): string | null {
	const said = sentence.trim();
	const words = said.split(/\s+/);
	for (const prefix of PREFIXES) {
		const wanted = prefix.split(" ");
		// Count the sentence's words until their plain form covers the prefix.
		for (let count = 1; count <= Math.min(words.length, wanted.length); count += 1) {
			const head = plain(words.slice(0, count).join(" "));
			if (head === prefix) {
				const rest = words
					.slice(count)
					.join(" ")
					.replace(/^[\s,.;:!?-]+/u, "")
					.replace(JOINER, "")
					.trim();
				return rest || null;
			}
			if (head.length > prefix.length) break;
		}
	}
	return null;
}
