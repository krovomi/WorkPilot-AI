import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	PackageInstallReport,
	TestLibrarySelection,
} from "../../shared/types/test-generation";

/**
 * What the generated tests will be written against, and the user's say in it.
 *
 * The backend answers from the project's own manifests: a solution that
 * references FluentAssertions and Moq gets tests written with them without
 * anyone ticking a box. This hook adds the two things only a person can
 * supply — a different choice, and the decision to actually add the packages
 * the choice needs.
 *
 * The choice is remembered per project, because it is a property of the
 * project: a team that tests with NSubstitute does not want to re-say so on
 * every file.
 */

const STORAGE_PREFIX = "workpilot.testLibraries.";

function storageKey(projectPath: string | undefined): string | null {
	return projectPath ? `${STORAGE_PREFIX}${projectPath}` : null;
}

function readRemembered(projectPath: string | undefined): string[] | null {
	const key = storageKey(projectPath);
	if (!key) return null;
	try {
		const raw = globalThis.localStorage?.getItem(key);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((id): id is string => typeof id === "string")
			: null;
	} catch {
		// A remembered choice is a convenience; losing it costs one click.
		return null;
	}
}

function remember(projectPath: string | undefined, ids: string[]): void {
	const key = storageKey(projectPath);
	if (!key) return;
	try {
		globalThis.localStorage?.setItem(key, JSON.stringify(ids));
	} catch {
		// Private window, blocked storage: the run still uses the choice.
	}
}

/** Injected in tests; defaults to the preload bridge. */
export interface LibrariesGateway {
	resolve: (
		filePath: string,
		projectPath?: string,
	) => Promise<TestLibrarySelection | null>;
	install: (
		selected: string[],
		projectPath: string,
		testDir?: string,
		filePath?: string,
	) => Promise<PackageInstallReport | null>;
}

const defaultGateway: LibrariesGateway = {
	resolve: async (filePath, projectPath) => {
		try {
			const response = await globalThis.electronAPI.resolveTestLibraries(
				filePath,
				projectPath,
			);
			return response?.libraries ?? null;
		} catch {
			// Without an answer the generation still runs; the backend resolves
			// the project's own stack again before building the prompt.
			return null;
		}
	},
	install: async (selected, projectPath, testDir, filePath) => {
		const response = await globalThis.electronAPI.addTestPackages(
			selected,
			projectPath,
			testDir,
			filePath,
		);
		if (!response?.success) {
			throw new Error(response?.error || "The packages could not be added.");
		}
		return response.report ?? null;
	},
};

export function useTestLibraries(
	filePath: string,
	projectPath?: string,
	gateway: LibrariesGateway = defaultGateway,
) {
	const [selection, setSelection] = useState<TestLibrarySelection | null>(null);
	const [chosen, setChosen] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [installing, setInstalling] = useState(false);
	const [report, setReport] = useState<PackageInstallReport | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Held in a ref, and deliberately not an effect dependency: a caller that
	// builds its gateway inline hands us a new object on every render, and an
	// effect keyed on that identity would re-resolve forever. What the effect
	// actually depends on is the file and the project.
	const gatewayRef = useRef(gateway);
	gatewayRef.current = gateway;

	useEffect(() => {
		if (!filePath && !projectPath) return;
		let cancelled = false;
		setLoading(true);
		void gatewayRef.current
			.resolve(filePath, projectPath)
			.then((resolved) => {
				if (cancelled) return;
				setSelection(resolved);
				// The remembered choice wins, but only over ids this project's
				// language actually offers — a C# selection must not survive into
				// a TypeScript file.
				const offered = new Set((resolved?.libraries ?? []).map((l) => l.id));
				const remembered = (readRemembered(projectPath) ?? []).filter((id) =>
					offered.has(id),
				);
				setChosen(remembered.length ? remembered : (resolved?.selected ?? []));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [filePath, projectPath]);

	const toggle = useCallback(
		(id: string) => {
			setChosen((previous) => {
				const next = previous.includes(id)
					? previous.filter((entry) => entry !== id)
					: [...previous, id];
				remember(projectPath, next);
				return next;
			});
			setReport(null);
		},
		[projectPath],
	);

	/** Back to what the project itself says — the answer nobody had to type. */
	const resetToProject = useCallback(() => {
		const fromProject = selection?.selected ?? [];
		setChosen(fromProject);
		remember(projectPath, fromProject);
		setReport(null);
	}, [projectPath, selection]);

	/** Chosen libraries the project does not reference yet. */
	const missing = useMemo(() => {
		if (!selection) return [];
		const installed = new Set(selection.installed);
		return selection.libraries.filter(
			(library) => chosen.includes(library.id) && !installed.has(library.id),
		);
	}, [selection, chosen]);

	const addMissingPackages = useCallback(
		async (testDir?: string) => {
			if (!projectPath || missing.length === 0) return null;
			setInstalling(true);
			setError(null);
			try {
				const result = await gatewayRef.current.install(
					missing.map((library) => library.id),
					projectPath,
					testDir,
					filePath,
				);
				setReport(result);
				// What landed is now installed: re-resolving keeps the picker
				// honest without a second round trip for the ones that failed.
				if (result?.installed.length) {
					setSelection((previous) =>
						previous
							? {
									...previous,
									installed: [
										...new Set([...previous.installed, ...result.installed]),
									],
								}
							: previous,
					);
				}
				return result;
			} catch (caught) {
				setError(
					caught instanceof Error
						? caught.message
						: "The packages could not be added.",
				);
				return null;
			} finally {
				setInstalling(false);
			}
		},
		[filePath, missing, projectPath],
	);

	return {
		selection,
		chosen,
		loading,
		installing,
		report,
		error,
		missing,
		toggle,
		resetToProject,
		addMissingPackages,
	};
}
