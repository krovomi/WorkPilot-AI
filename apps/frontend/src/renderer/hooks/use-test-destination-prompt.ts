import { useCallback, useRef, useState } from "react";
import type { TestDestination } from "../../shared/types/test-generation";

/**
 * Ask the user where generated tests should go — but only when the project
 * cannot answer on its own.
 *
 * The backend resolves the destination from the project's layout: the `tests`
 * directory beside the source root, an existing test file's own directory, the
 * `__tests__` a JS project already uses. Any of those and this hook stays out
 * of the way. It is the remaining case — no test directory anywhere — that used
 * to be answered by dropping the file at the project root, and that is the one
 * a person should answer.
 *
 * Usage:
 *   const { prompt, pending, confirm, cancel } = useTestDestinationPrompt();
 *   const choice = await prompt(filePath, projectPath);
 *   if (choice.cancelled) return;               // user backed out
 *   await generateUnitTests(file, undefined, target, choice.directory);
 */

/** What a prompt round produced. */
export interface DestinationChoice {
	/** The directory to generate into, or undefined to let the backend decide. */
	directory?: string;
	/** True when the user dismissed the question: generate nothing. */
	cancelled: boolean;
	/** The resolution the question was based on, when there was one. */
	destination: TestDestination | null;
}

/** Injected in tests; defaults to the preload bridge. */
export type DestinationResolver = (
	filePath: string,
	projectPath?: string,
	existingTestPath?: string,
) => Promise<TestDestination | null>;

const defaultResolver: DestinationResolver = async (
	filePath,
	projectPath,
	existingTestPath,
) => {
	try {
		const response = await globalThis.electronAPI.resolveTestDestination(
			filePath,
			projectPath,
			existingTestPath,
		);
		return response?.destination ?? null;
	} catch {
		// A pre-flight that cannot run is not a reason to refuse the generation:
		// the runner resolves the destination again on its own before writing.
		return null;
	}
};

export function useTestDestinationPrompt(resolver: DestinationResolver = defaultResolver) {
	const [pending, setPending] = useState<TestDestination | null>(null);
	const answerRef = useRef<((choice: DestinationChoice) => void) | null>(null);

	/**
	 * Resolve the destination and, when it needs a decision, wait for one.
	 *
	 * `remembered` short-circuits the question: a batch of files asks once and
	 * writes the rest to the same directory, because asking twenty times for
	 * twenty files in one build is not consent, it is an obstacle.
	 */
	const prompt = useCallback(
		async (
			filePath: string,
			projectPath?: string,
			options?: { existingTestPath?: string; remembered?: string },
		): Promise<DestinationChoice> => {
			if (options?.remembered) {
				return {
					directory: options.remembered,
					cancelled: false,
					destination: null,
				};
			}

			const destination = await resolver(
				filePath,
				projectPath,
				options?.existingTestPath,
			);
			if (destination?.status !== "needs_choice") {
				return { cancelled: false, destination };
			}

			setPending(destination);
			return await new Promise<DestinationChoice>((resolve) => {
				answerRef.current = resolve;
			});
		},
		[resolver],
	);

	const settle = useCallback((choice: DestinationChoice) => {
		setPending(null);
		const answer = answerRef.current;
		answerRef.current = null;
		answer?.(choice);
	}, []);

	/** The user picked (or typed) a directory. */
	const confirm = useCallback(
		(directory: string) => {
			const trimmed = directory.trim();
			if (!trimmed) return;
			settle({ directory: trimmed, cancelled: false, destination: null });
		},
		[settle],
	);

	/** The user dismissed the question — nothing is generated. */
	const cancel = useCallback(() => {
		settle({ cancelled: true, destination: null });
	}, [settle]);

	return { prompt, pending, confirm, cancel };
}
