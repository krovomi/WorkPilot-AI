import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above the file's own statements, so the spy it closes
// over has to be hoisted with it.
const { addProject } = vi.hoisted(() => ({ addProject: vi.fn() }));

vi.mock("@/stores/project-store", () => ({ addProject }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { AddProjectModal } from "./AddProjectModal";

const selectDirectory = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	(
		globalThis as unknown as { electronAPI: Record<string, unknown> }
	).electronAPI = {
		selectDirectory,
		createProjectFolder: vi.fn(),
		checkGitStatus: vi.fn().mockResolvedValue({ success: false }),
		updateProjectEnv: vi.fn(),
	};
});

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
