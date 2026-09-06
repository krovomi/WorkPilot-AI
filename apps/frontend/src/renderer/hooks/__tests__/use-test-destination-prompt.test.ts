/**
 * Tests for the "where do these tests go?" prompt.
 *
 * The properties pinned here are the ones that decide whether a generated test
 * file lands somewhere a person would look for it: a project that already has
 * a test directory is never asked about, a project that has none stops and
 * waits for an answer, a dismissed question generates nothing, and a batch of
 * files asks once rather than once per file.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TestDestination } from "../../../shared/types/test-generation";
import { useTestDestinationPrompt } from "../use-test-destination-prompt";

const RESOLVED: TestDestination = {
	directory: "/proj/tests",
	fileName: "ProgramTests.cs",
	path: "/proj/tests/ProgramTests.cs",
	status: "resolved",
	reason: "existing_tests_dir",
	projectRoot: "/proj",
	sourceRoot: "/proj/src",
	candidates: [],
};

const NEEDS_CHOICE: TestDestination = {
	...RESOLVED,
	status: "needs_choice",
	reason: "no_tests_dir",
	candidates: [
		{ path: "/proj/tests", kind: "sibling_of_source_root", exists: false },
		{ path: "/proj/src", kind: "source_dir", exists: true },
	],
};

describe("useTestDestinationPrompt", () => {
	it("does not ask when the project already has a test directory", async () => {
		const resolver = vi.fn().mockResolvedValue(RESOLVED);
		const { result } = renderHook(() => useTestDestinationPrompt(resolver));

		const choice = await act(() =>
			result.current.prompt("/proj/src/Program.cs", "/proj"),
		);

		expect(choice).toEqual({ cancelled: false, destination: RESOLVED });
		expect(result.current.pending).toBeNull();
	});

	it("waits for an answer when no test directory exists", async () => {
		const resolver = vi.fn().mockResolvedValue(NEEDS_CHOICE);
		const { result } = renderHook(() => useTestDestinationPrompt(resolver));

		let settled: unknown;
		act(() => {
			void result.current
				.prompt("/proj/src/Program.cs", "/proj")
				.then((choice) => {
					settled = choice;
				});
		});

		await waitFor(() => expect(result.current.pending).toEqual(NEEDS_CHOICE));
		expect(settled).toBeUndefined();

		act(() => result.current.confirm("/proj/tests/App.UnitTests"));

		await waitFor(() =>
			expect(settled).toEqual({
				directory: "/proj/tests/App.UnitTests",
				cancelled: false,
				destination: null,
			}),
		);
		expect(result.current.pending).toBeNull();
	});

	it("reports a dismissal so the caller generates nothing", async () => {
		const resolver = vi.fn().mockResolvedValue(NEEDS_CHOICE);
		const { result } = renderHook(() => useTestDestinationPrompt(resolver));

		let settled: { cancelled: boolean } | undefined;
		act(() => {
			void result.current.prompt("/proj/src/Program.cs", "/proj").then((c) => {
				settled = c;
			});
		});
		await waitFor(() => expect(result.current.pending).not.toBeNull());

		act(() => result.current.cancel());

		await waitFor(() => expect(settled?.cancelled).toBe(true));
	});

	it("asks once for a batch: a remembered directory short-circuits", async () => {
		const resolver = vi.fn().mockResolvedValue(NEEDS_CHOICE);
		const { result } = renderHook(() => useTestDestinationPrompt(resolver));

		const choice = await act(() =>
			result.current.prompt("/proj/src/Other.cs", "/proj", {
				remembered: "/proj/tests",
			}),
		);

		expect(choice).toEqual({
			directory: "/proj/tests",
			cancelled: false,
			destination: null,
		});
		expect(resolver).not.toHaveBeenCalled();
		expect(result.current.pending).toBeNull();
	});

	it("carries on without a directory when the pre-flight cannot answer", async () => {
		const resolver = vi.fn().mockResolvedValue(null);
		const { result } = renderHook(() => useTestDestinationPrompt(resolver));

		const choice = await act(() =>
			result.current.prompt("/proj/src/Program.cs", "/proj"),
		);

		// Not cancelled, no directory: the runner resolves it again on write.
		expect(choice).toEqual({ cancelled: false, destination: null });
	});
});
