import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	addProject: vi.fn(),
	selectProject: vi.fn(),
	openProjectTab: vi.fn(),
}));

vi.mock("@/stores/project-store", () => ({
	useProjectStore: { getState: () => store },
}));

import { repoNameFromUrl, ServerProjectDialog } from "./ServerProjectDialog";

const createServerProject = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	(
		globalThis as unknown as { electronAPI: Record<string, unknown> }
	).electronAPI = { createServerProject };
});

describe("ServerProjectDialog", () => {
	it("names a project after its repository", () => {
		expect(repoNameFromUrl("https://github.com/acme/shop.git")).toBe("shop");
		expect(repoNameFromUrl("git@gitlab.com:acme/billing.git/")).toBe("billing");
		expect(repoNameFromUrl("")).toBe("");
	});

	it("sends the repository URL, never a path, and opens the new project", async () => {
		const project = { id: "p-1", name: "shop", remote: { role: "owner" } };
		createServerProject.mockResolvedValue({ success: true, data: project });
		const onOpenChange = vi.fn();
		render(
			<ServerProjectDialog open onOpenChange={onOpenChange} onChooseLocal={vi.fn()} />,
		);

		fireEvent.change(screen.getByLabelText(/repository url|url du dépôt/i), {
			target: { value: "https://github.com/acme/shop.git" },
		});
		fireEvent.click(screen.getByRole("button", { name: /add to the server|ajouter au serveur/i }));

		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(createServerProject).toHaveBeenCalledWith({
			name: "shop",
			repoUrl: "https://github.com/acme/shop.git",
			defaultBranch: undefined,
		});
		expect(store.addProject).toHaveBeenCalledWith(project);
		expect(store.openProjectTab).toHaveBeenCalledWith("p-1");
	});

	it("shows the server's refusal and keeps the dialog open", async () => {
		createServerProject.mockResolvedValue({
			success: false,
			error: "Project quota reached",
		});
		const onOpenChange = vi.fn();
		render(
			<ServerProjectDialog open onOpenChange={onOpenChange} onChooseLocal={vi.fn()} />,
		);
		fireEvent.change(screen.getByLabelText(/repository url|url du dépôt/i), {
			target: { value: "https://github.com/acme/shop.git" },
		});
		fireEvent.click(screen.getByRole("button", { name: /add to the server|ajouter au serveur/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Project quota reached");
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(store.addProject).not.toHaveBeenCalled();
	});
});
