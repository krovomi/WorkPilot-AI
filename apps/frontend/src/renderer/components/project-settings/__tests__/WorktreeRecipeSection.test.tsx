/** @vitest-environment jsdom */
/**
 * The worktree recipe in the project settings: the commands are shown one by
 * one, a recipe file waits for an explicit approval, and the detected recipe
 * can be saved as a file.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import type {
	WorktreeRecipe,
	WorktreeRecipeState,
} from "../../../../shared/types/worktree-recipe";
import { WorktreeRecipeSection } from "../WorktreeRecipeSection";

const base: WorktreeRecipe = {
	source: "detected",
	setup: [
		["npm", "ci"],
		["dotnet", "restore"],
	],
	copy: [],
	link: [],
	passEnv: [],
	timeoutSeconds: 900,
	ports: 0,
	teardown: [],
	errors: [],
	notes: [],
	digest: "d",
};

const detectedState: WorktreeRecipeState = {
	recipe: base,
	detected: base,
	hasFile: false,
	approved: true,
};

const fileRecipe: WorktreeRecipe = {
	...base,
	source: "file",
	setup: [["make", "deps"]],
	copy: [".env.local"],
	ports: 3,
	teardown: [["docker", "compose", "down"]],
	proofs: [["dafny", "verify", "src/Cart.dfy"]],
};

const api = {
	getWorktreeRecipe: vi.fn(),
	approveWorktreeRecipe: vi.fn(),
	saveDetectedWorktreeRecipe: vi.fn(),
};

beforeEach(() => {
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("WorktreeRecipeSection", () => {
	it("lists the detected commands and saves them as a file", async () => {
		api.getWorktreeRecipe.mockResolvedValue({ success: true, data: detectedState });
		api.saveDetectedWorktreeRecipe.mockResolvedValue({
			success: true,
			data: { ...detectedState, hasFile: true, recipe: { ...base, source: "file" } },
		});
		render(<WorktreeRecipeSection projectPath="/repo" />);
		expect(await screen.findByText("npm ci")).toBeInTheDocument();
		expect(screen.getByText("dotnet restore")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /worktree\.toml/i }));
		await waitFor(() =>
			expect(api.saveDetectedWorktreeRecipe).toHaveBeenCalledWith("/repo"),
		);
		expect(await screen.findByText(/Approved/)).toBeInTheDocument();
	});

	it("waits for an approval of a recipe file and shows what it does", async () => {
		const awaiting = { recipe: fileRecipe, detected: base, hasFile: true, approved: false };
		api.getWorktreeRecipe.mockResolvedValue({ success: true, data: awaiting });
		api.approveWorktreeRecipe.mockResolvedValue({
			success: true,
			data: { ...awaiting, approved: true },
		});
		render(<WorktreeRecipeSection projectPath="/repo" />);
		expect(await screen.findByText("make deps")).toBeInTheDocument();
		expect(screen.getByText(/\.env\.local/)).toBeInTheDocument();
		expect(screen.getByText(/3 ports/)).toBeInTheDocument();
		expect(screen.getByText(/docker compose down/)).toBeInTheDocument();
		// The proof checkers are part of what the approval covers: shown too.
		expect(screen.getByText(/dafny verify src\/Cart\.dfy/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		await waitFor(() => expect(api.approveWorktreeRecipe).toHaveBeenCalledWith("/repo"));
		expect(await screen.findByText(/Approved/)).toBeInTheDocument();
	});

	it("offers no approval for an invalid recipe", async () => {
		api.getWorktreeRecipe.mockResolvedValue({
			success: true,
			data: {
				recipe: { ...fileRecipe, setup: [], errors: ["a command is a list"] },
				detected: base,
				hasFile: true,
				approved: false,
			},
		});
		render(<WorktreeRecipeSection projectPath="/repo" />);
		expect(await screen.findByRole("alert")).toHaveTextContent("a command is a list");
		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
	});
});
