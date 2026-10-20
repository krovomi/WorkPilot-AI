/**
 * Tests for the test-library choice.
 *
 * What is pinned here is what decides whether a generated C# test compiles and
 * reads like the rest of the suite: the project's own packages arrive ticked, a
 * choice survives to the next file of the same project, a choice made for one
 * language never leaks into another, and only the chosen-but-absent packages
 * are ever installed.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	PackageInstallReport,
	TestLibrary,
	TestLibrarySelection,
} from "../../../shared/types/test-generation";
import type { LibrariesGateway } from "../use-test-libraries";
import { useTestLibraries } from "../use-test-libraries";

function library(
	id: string,
	overrides: Partial<TestLibrary> = {},
): TestLibrary {
	return {
		id,
		name: id,
		package: id,
		ecosystem: "nuget",
		language: "csharp",
		category: "framework",
		usage: "",
		recommended: false,
		installed: false,
		...overrides,
	};
}

const DOTNET: TestLibrarySelection = {
	language: "csharp",
	selected: ["xunit"],
	installed: ["xunit"],
	explicit: false,
	libraries: [
		library("xunit", { installed: true }),
		library("fluentassertions", { category: "assertions" }),
		library("moq", { category: "mocking" }),
	],
	missing: [],
	installCommands: [],
};

const NODE: TestLibrarySelection = {
	language: "typescript",
	selected: ["vitest"],
	installed: ["vitest"],
	explicit: false,
	libraries: [library("vitest", { language: "typescript", installed: true })],
	missing: [],
	installCommands: [],
};

function gatewayFor(
	selection: TestLibrarySelection | null,
	install?: LibrariesGateway["install"],
): LibrariesGateway {
	return {
		resolve: vi.fn().mockResolvedValue(selection),
		install: install ?? vi.fn().mockResolvedValue(null),
	};
}

beforeEach(() => {
	globalThis.localStorage?.clear();
});

describe("useTestLibraries", () => {
	it("opens on what the project already references", async () => {
		const gateway = gatewayFor(DOTNET);

		const { result } = renderHook(() =>
			useTestLibraries("/proj/src/Program.cs", "/proj", gateway),
		);

		await waitFor(() => expect(result.current.selection).toEqual(DOTNET));
		expect(result.current.chosen).toEqual(["xunit"]);
		// Nothing to install: the project already has what it was given.
		expect(result.current.missing).toEqual([]);
	});

	it("reports a ticked package the project lacks", async () => {
		const gateway = gatewayFor(DOTNET);
		const { result } = renderHook(() =>
			useTestLibraries("/proj/src/Program.cs", "/proj", gateway),
		);
		await waitFor(() => expect(result.current.selection).not.toBeNull());

		act(() => result.current.toggle("fluentassertions"));

		expect(result.current.chosen).toEqual(["xunit", "fluentassertions"]);
		expect(result.current.missing.map((l) => l.id)).toEqual(["fluentassertions"]);
	});

	it("remembers the choice for the next file of the same project", async () => {
		const gateway = gatewayFor(DOTNET);
		const first = renderHook(() =>
			useTestLibraries("/proj/src/A.cs", "/proj", gateway),
		);
		await waitFor(() => expect(first.result.current.selection).not.toBeNull());
		act(() => first.result.current.toggle("moq"));

		const second = renderHook(() =>
			useTestLibraries("/proj/src/B.cs", "/proj", gateway),
		);

		await waitFor(() =>
			expect(second.result.current.chosen).toEqual(["xunit", "moq"]),
		);
	});

	it("never carries a C# choice into a TypeScript file", async () => {
		const dotnet = renderHook(() =>
			useTestLibraries("/proj/src/A.cs", "/proj", gatewayFor(DOTNET)),
		);
		await waitFor(() => expect(dotnet.result.current.selection).not.toBeNull());
		act(() => dotnet.result.current.toggle("moq"));

		const node = renderHook(() =>
			useTestLibraries("/proj/src/a.ts", "/proj", gatewayFor(NODE)),
		);

		await waitFor(() => expect(node.result.current.chosen).toEqual(["vitest"]));
	});

	it("resets to what the project itself says", async () => {
		const gateway = gatewayFor(DOTNET);
		const { result } = renderHook(() =>
			useTestLibraries("/proj/src/Program.cs", "/proj", gateway),
		);
		await waitFor(() => expect(result.current.selection).not.toBeNull());
		act(() => result.current.toggle("moq"));

		act(() => result.current.resetToProject());

		expect(result.current.chosen).toEqual(["xunit"]);
	});

	it("installs only the packages that are missing", async () => {
		const install = vi.fn().mockResolvedValue({
			ok: true,
			installed: ["moq"],
			steps: [],
			manualCommands: [],
			reason: "",
			target: "/proj/tests/App.Tests/App.Tests.csproj",
		} satisfies PackageInstallReport);
		const { result } = renderHook(() =>
			useTestLibraries(
				"/proj/src/Program.cs",
				"/proj",
				gatewayFor(DOTNET, install),
			),
		);
		await waitFor(() => expect(result.current.selection).not.toBeNull());
		act(() => result.current.toggle("moq"));

		await act(() => result.current.addMissingPackages("/proj/tests"));

		// xunit is already referenced and is not re-added.
		expect(install).toHaveBeenCalledWith(
			["moq"],
			"/proj",
			"/proj/tests",
			"/proj/src/Program.cs",
		);
		// What landed counts as installed, so the warning clears.
		expect(result.current.missing).toEqual([]);
	});

	it("surfaces an install failure instead of throwing", async () => {
		const install = vi.fn().mockRejectedValue(new Error("dotnet not found"));
		const { result } = renderHook(() =>
			useTestLibraries(
				"/proj/src/Program.cs",
				"/proj",
				gatewayFor(DOTNET, install),
			),
		);
		await waitFor(() => expect(result.current.selection).not.toBeNull());
		act(() => result.current.toggle("moq"));

		await act(() => result.current.addMissingPackages());

		expect(result.current.error).toBe("dotnet not found");
		expect(result.current.installing).toBe(false);
	});

	it("carries on when the pre-flight cannot answer", async () => {
		const { result } = renderHook(() =>
			useTestLibraries("/proj/src/Program.cs", "/proj", gatewayFor(null)),
		);

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.selection).toBeNull();
		expect(result.current.chosen).toEqual([]);
	});
});
