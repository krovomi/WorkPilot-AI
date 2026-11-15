/**
 * @vitest-environment jsdom
 */
/**
 * The task creation wizard: what it sends when a task is created (base
 * branch, file mentions, local branch), its errors, and the draft it keeps
 * when closed before creating.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../stores/project-store";
import { clearDraft, loadDraft, useTaskStore } from "../../stores/task-store";
import { TaskCreationWizard } from "../TaskCreationWizard";

const api = {
	createTask: vi.fn(),
	getGitBranchesWithInfo: vi.fn(),
	getProjectEnv: vi.fn(),
	detectMainBranch: vi.fn(),
};

function renderWizard() {
	const onOpenChange = vi.fn();
	const view = render(
		<TaskCreationWizard projectId="p1" open onOpenChange={onOpenChange} />,
	);
	return { ...view, onOpenChange };
}

function description() {
	return screen.getByPlaceholderText(/Describe the feature, bug fix/) as HTMLTextAreaElement;
}

function titleInput() {
	return document.getElementById("create-title") as HTMLInputElement;
}

function createdMetadata() {
	return api.createTask.mock.calls[0][3];
}

beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(globalThis.electronAPI, api);
	clearDraft("p1");
	api.createTask.mockImplementation(
		async (projectId: string, title: string, desc: string, metadata: unknown) => ({
			success: true,
			data: { id: "t-new", projectId, title, description: desc, metadata, status: "backlog", subtasks: [], logs: [] },
		}),
	);
	api.getGitBranchesWithInfo.mockResolvedValue({
		success: true,
		data: [
			{ name: "develop", type: "local", displayName: "develop" },
			{ name: "origin/release", type: "remote", displayName: "origin/release" },
		],
	});
	api.getProjectEnv.mockResolvedValue({ success: true, data: { defaultBranch: "develop" } });
	api.detectMainBranch.mockResolvedValue({ success: true, data: "main" });
	useProjectStore.setState({
		projects: [{ id: "p1", name: "Repo", path: "/repo", settings: {} } as never],
	});
	useTaskStore.setState({ tasks: [] });
});

describe("TaskCreationWizard create", () => {
	it("cannot create without a description", () => {
		renderWizard();
		expect(screen.getByText("Create New Task")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create Task" })).toBeDisabled();
	});

	it("creates the task on the project default branch with the files it mentions", async () => {
		const { onOpenChange } = renderWizard();
		await waitFor(() => expect(api.getProjectEnv).toHaveBeenCalledWith("p1"));
		fireEvent.change(titleInput(), { target: { value: "  Add logout " } });
		fireEvent.change(description(), {
			target: { value: "Add a logout button next to @src/App.tsx and @src/App.tsx" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		const [projectId, title, desc] = api.createTask.mock.calls[0];
		expect(projectId).toBe("p1");
		expect(title).toBe("Add logout");
		expect(desc).toBe("Add a logout button next to @src/App.tsx and @src/App.tsx");
		const metadata = createdMetadata();
		expect(metadata.sourceType).toBe("manual");
		expect(metadata.baseBranch).toBe("develop");
		// A file mentioned twice is referenced once.
		expect(metadata.referencedFiles).toHaveLength(1);
		expect(metadata.referencedFiles[0]).toMatchObject({ path: "src/App.tsx", isDirectory: false });
		expect(metadata.useLocalBranch).toBeUndefined();
		expect(metadata.provider).toBeDefined();
		expect(useTaskStore.getState().tasks[0].id).toBe("t-new");
	});

	it("detects the main branch when the project names no default", async () => {
		api.getProjectEnv.mockResolvedValue({ success: true, data: {} });
		renderWizard();
		await waitFor(() => expect(api.detectMainBranch).toHaveBeenCalledWith("/repo"));
		fireEvent.change(description(), { target: { value: "Do it" } });
		fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
		await waitFor(() => expect(api.createTask).toHaveBeenCalled());
		expect(createdMetadata().baseBranch).toBe("main");
	});

	it("sends no base branch when none is known", async () => {
		api.getProjectEnv.mockRejectedValue(new Error("no env"));
		api.getGitBranchesWithInfo.mockRejectedValue(new Error("not a repo"));
		renderWizard();
		await waitFor(() => expect(api.getGitBranchesWithInfo).toHaveBeenCalled());
		fireEvent.change(description(), { target: { value: "Do it" } });
		fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
		await waitFor(() => expect(api.createTask).toHaveBeenCalled());
		expect(createdMetadata().baseBranch).toBeUndefined();
	});

	it("uses a chosen local branch and keeps its ignored files", async () => {
		renderWizard();
		fireEvent.click(screen.getByRole("button", { name: /Git Options/ }));
		const combobox = await screen.findByRole("combobox", { name: /Base Branch/ });
		await waitFor(() => expect(combobox).not.toBeDisabled());
		fireEvent.click(combobox);
		fireEvent.click(await screen.findByRole("option", { name: /^develop/ }));
		expect(screen.getByRole("button", { name: /Git Options/ })).toHaveTextContent("develop");
		fireEvent.change(description(), { target: { value: "Do it" } });
		fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
		await waitFor(() => expect(api.createTask).toHaveBeenCalled());
		expect(createdMetadata()).toMatchObject({ baseBranch: "develop", useLocalBranch: true });
	});

	it("uses a remote branch without the local flag", async () => {
		renderWizard();
		fireEvent.click(screen.getByRole("button", { name: /Git Options/ }));
		const combobox = await screen.findByRole("combobox", { name: /Base Branch/ });
		await waitFor(() => expect(combobox).not.toBeDisabled());
		fireEvent.click(combobox);
		fireEvent.click(await screen.findByRole("option", { name: /origin\/release/ }));
		fireEvent.change(description(), { target: { value: "Do it" } });
		fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
		await waitFor(() => expect(api.createTask).toHaveBeenCalled());
		expect(createdMetadata().baseBranch).toBe("origin/release");
		expect(createdMetadata().useLocalBranch).toBeUndefined();
	});

	it("says the task was not created", async () => {
		api.createTask.mockResolvedValue({ success: false, error: "spec dir locked" });
		const { onOpenChange } = renderWizard();
		fireEvent.change(description(), { target: { value: "Do it" } });
		fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
		expect(
			await screen.findByText("Failed to create task. Please try again."),
		).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalled();
	});
});

describe("TaskCreationWizard draft", () => {
	it("keeps what was typed when closed and restores it on the next open", async () => {
		const first = renderWizard();
		fireEvent.change(titleInput(), { target: { value: "Half-written" } });
		fireEvent.change(description(), { target: { value: "Remember me" } });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(first.onOpenChange).toHaveBeenCalledWith(false);
		expect(loadDraft("p1")).toMatchObject({ title: "Half-written", description: "Remember me" });
		first.unmount();

		renderWizard();
		expect(await screen.findByText("Draft restored")).toBeInTheDocument();
		expect(titleInput().value).toBe("Half-written");
		expect(description().value).toBe("Remember me");
		fireEvent.click(screen.getByRole("button", { name: "Start Fresh" }));
		expect(description().value).toBe("");
		expect(loadDraft("p1")).toBeNull();
	});

	it("leaves no draft when closed empty, and clears it once the task exists", async () => {
		const first = renderWizard();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(loadDraft("p1")).toBeNull();
		first.unmount();

		const { onOpenChange } = renderWizard();
		fireEvent.change(description(), { target: { value: "Ship it" } });
		fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(loadDraft("p1")).toBeNull();
	});
});

describe("TaskCreationWizard file references", () => {
	it("toggles the file explorer", () => {
		renderWizard();
		fireEvent.click(screen.getByRole("button", { name: "Browse Files" }));
		expect(screen.getByRole("button", { name: "Hide Files" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Hide Files" }));
		expect(screen.getByRole("button", { name: "Browse Files" })).toBeInTheDocument();
	});

	it("highlights a file mention in the description overlay", () => {
		renderWizard();
		fireEvent.change(description(), { target: { value: "Look at @lib/util.ts please" } });
		const highlighted = screen.getByText("@lib/util.ts");
		expect(highlighted.tagName).toBe("SPAN");
		expect(highlighted.className).toContain("bg-info/20");
	});
});
