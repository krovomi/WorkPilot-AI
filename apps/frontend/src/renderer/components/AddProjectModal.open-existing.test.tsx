import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above the file's own statements, so the spy it closes
// over has to be hoisted with it.
const { addProject } = vi.hoisted(() => ({ addProject: vi.fn() }));

vi.mock("@/stores/project-store", () => ({ addProject }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { AddProjectModal } from "./AddProjectModal";

const selectDirectory = vi.fn();
const inspectProjectLocation = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	(
		globalThis as unknown as { electronAPI: Record<string, unknown> }
	).electronAPI = {
		selectDirectory,
		createProjectFolder: vi.fn(),
		checkGitStatus: vi.fn().mockResolvedValue({ success: false }),
		updateProjectEnv: vi.fn(),
		inspectProjectLocation: inspectProjectLocation.mockResolvedValue({
			success: true,
			data: {
				targetPath: null,
				targetExists: false,
				targetHasEntries: false,
				locationIsProject: false,
				insideRepository: null,
				markers: [],
			},
		}),
	};
});

/** Fills the create form, which is what triggers the location check. */
async function fillCreateForm(name: string, location: string) {
	fireEvent.change(screen.getByLabelText(/project name|nom du projet/i), {
		target: { value: name },
	});
	fireEvent.change(screen.getByLabelText(/location|emplacement/i), {
		target: { value: location },
	});
	await waitFor(() => expect(inspectProjectLocation).toHaveBeenCalled());
}

describe("AddProjectModal — opening an existing project", () => {
	/**
	 * Registering a folder that already exists used to be reachable only through
	 * an undocumented Ctrl/Cmd+T: the modal itself could only create an empty
	 * directory, so every project added through it started out with nothing in
	 * it but `.git`.
	 */
	it("registers the selected folder without creating anything", async () => {
		selectDirectory.mockResolvedValue("/home/leub/repos/my-api");
		addProject.mockResolvedValue({
			project: { id: "p1", path: "/home/leub/repos/my-api", name: "my-api" },
		});
		const onProjectAdded = vi.fn();

		render(
			<AddProjectModal
				open
				onOpenChange={vi.fn()}
				onProjectAdded={onProjectAdded}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /existing/i }));

		await waitFor(() => expect(addProject).toHaveBeenCalledTimes(1));
		expect(addProject).toHaveBeenCalledWith("/home/leub/repos/my-api");
		expect(
			(globalThis as unknown as { electronAPI: Record<string, unknown> })
				.electronAPI.createProjectFolder,
		).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(onProjectAdded).toHaveBeenCalledWith(
				expect.objectContaining({ id: "p1" }),
				false,
			),
		);
	});

	it("does nothing when the directory picker is dismissed", async () => {
		selectDirectory.mockResolvedValue(undefined);

		render(<AddProjectModal open onOpenChange={vi.fn()} />);

		fireEvent.click(screen.getByRole("button", { name: /existing/i }));

		await waitFor(() => expect(selectDirectory).toHaveBeenCalled());
		expect(addProject).not.toHaveBeenCalled();
	});
});

/**
 * The two entries do not do the same thing, and the difference is invisible
 * until it has happened: "Create" makes `<location>/<name>` and registers
 * *that*, so a location that already holds the code gets an empty sibling and
 * every later scan reports zero endpoints.
 */
describe("AddProjectModal — creating next to a project that already exists", () => {
	it("says so when the location is itself a project, and offers to open it", async () => {
		inspectProjectLocation.mockResolvedValue({
			success: true,
			data: {
				targetPath: "/repos/rag/dotnet/test",
				targetExists: false,
				targetHasEntries: false,
				locationIsProject: true,
				insideRepository: null,
				markers: ["Rag.sln"],
			},
		});
		addProject.mockResolvedValue({
			project: { id: "p2", path: "/repos/rag/dotnet", name: "dotnet" },
		});

		render(<AddProjectModal open onOpenChange={vi.fn()} />);
		await fillCreateForm("test", "/repos/rag/dotnet");

		await screen.findByText(/Rag\.sln/);
		fireEvent.click(await screen.findByRole("button", { name: /instead|plutôt/i }));

		await waitFor(() => expect(addProject).toHaveBeenCalledWith("/repos/rag/dotnet"));
		expect(
			(globalThis as unknown as { electronAPI: Record<string, unknown> })
				.electronAPI.createProjectFolder,
		).not.toHaveBeenCalled();
	});

	it("offers the target itself when that is what already holds the code", async () => {
		inspectProjectLocation.mockResolvedValue({
			success: true,
			data: {
				targetPath: "/repos/my-api",
				targetExists: true,
				targetHasEntries: true,
				locationIsProject: false,
				insideRepository: null,
				markers: [],
			},
		});
		addProject.mockResolvedValue({
			project: { id: "p3", path: "/repos/my-api", name: "my-api" },
		});

		render(<AddProjectModal open onOpenChange={vi.fn()} />);
		await fillCreateForm("my-api", "/repos");

		fireEvent.click(await screen.findByRole("button", { name: /instead|plutôt/i }));

		await waitFor(() =>
			expect(addProject).toHaveBeenCalledWith("/repos/my-api"),
		);
	});

	it("says so when the location sits inside a checkout", async () => {
		inspectProjectLocation.mockResolvedValue({
			success: true,
			data: {
				targetPath: "/repos/rag/dotnet/test",
				targetExists: false,
				targetHasEntries: false,
				locationIsProject: false,
				insideRepository: "/repos/rag",
				markers: [],
			},
		});
		addProject.mockResolvedValue({
			project: { id: "p4", path: "/repos/rag/dotnet", name: "dotnet" },
		});

		render(<AddProjectModal open onOpenChange={vi.fn()} />);
		await fillCreateForm("test", "/repos/rag/dotnet");

		await screen.findByText(/repository at \/repos\/rag/);
		fireEvent.click(await screen.findByRole("button", { name: /instead|plutôt/i }));

		await waitFor(() =>
			expect(addProject).toHaveBeenCalledWith("/repos/rag/dotnet"),
		);
	});

	it("stays quiet where creating is what the user meant", async () => {
		render(<AddProjectModal open onOpenChange={vi.fn()} />);
		await fillCreateForm("new-thing", "/repos");

		await waitFor(() =>
			expect(screen.queryByRole("button", { name: /instead|plutôt/i })).toBeNull(),
		);
	});
});
