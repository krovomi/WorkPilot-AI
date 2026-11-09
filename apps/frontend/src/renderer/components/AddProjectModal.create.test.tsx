import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { addProject } = vi.hoisted(() => ({ addProject: vi.fn() }));

vi.mock("@/stores/project-store", () => ({ addProject }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { AddProjectModal } from "./AddProjectModal";

const createProjectFolder = vi.fn();
const checkGitStatus = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	(
		globalThis as unknown as { electronAPI: Record<string, unknown> }
	).electronAPI = {
		selectDirectory: vi.fn(),
		createProjectFolder,
		checkGitStatus,
		updateProjectEnv: vi.fn(),
		readFile: vi.fn().mockResolvedValue({ success: false }),
		detectRepoProvider: vi.fn().mockResolvedValue({ success: true, data: { provider: "unknown" } }),
		inspectProjectLocation: vi.fn().mockResolvedValue({
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

function fillCreateForm(name: string, location: string) {
	fireEvent.change(screen.getByLabelText(/project name|nom du projet/i), {
		target: { value: name },
	});
	fireEvent.change(screen.getByLabelText(/location|emplacement/i), {
		target: { value: location },
	});
}

describe("AddProjectModal — creating a new project", () => {
	it("lets the user go on with a complete form, no remote chosen", async () => {
		// The target does not exist yet: nothing to detect, nothing auto-picked.
		checkGitStatus.mockResolvedValue({ success: true, data: { isGitRepo: false } });
		render(<AddProjectModal open onOpenChange={vi.fn()} />);
		fillCreateForm("Mon Projet", "/home/leub/code");

		// "Skip for now" is shown as the current choice...
		const skip = screen.getByRole("button", { pressed: true });
		expect(skip.textContent).toMatch(/skip|plus tard/i);
		// ...so Next must not wait for a click on it.
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /^(Next|Suivant)$/ })).toBeEnabled(),
		);
	});

	it("hands a fresh repository to the app once, without a git dialog of its own", async () => {
		// The sidebar asks for the first commit when the new project is selected:
		// a second dialog here stayed behind, stale, after "Initialize Git".
		checkGitStatus.mockResolvedValue({
			success: true,
			data: { isGitRepo: true, hasCommits: false, currentBranch: "main" },
		});
		createProjectFolder.mockResolvedValue({
			success: true,
			data: { path: "/home/leub/code/mon-projet", name: "mon-projet", gitInitialized: true },
		});
		addProject.mockResolvedValue({
			project: { id: "p1", path: "/home/leub/code/mon-projet", name: "Mon Projet" },
		});
		const onProjectAdded = vi.fn();
		const onOpenChange = vi.fn();
		render(
			<AddProjectModal open onOpenChange={onOpenChange} onProjectAdded={onProjectAdded} />,
		);
		fillCreateForm("Mon Projet", "/home/leub/code");
		const next = screen.getByRole("button", { name: /^(Next|Suivant)$/ });
		await waitFor(() => expect(next).toBeEnabled());
		fireEvent.click(next);
		// The summary shows where the folder is created, not only its parent.
		await screen.findByText("/home/leub/code/mon-projet");
		fireEvent.click(screen.getByRole("button", { name: /create project|créer le projet/i }));

		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(onProjectAdded).toHaveBeenCalledTimes(1);
		expect(screen.queryByText(/Git Repository Required|Dépôt Git requis/i)).toBeNull();
	});
});
