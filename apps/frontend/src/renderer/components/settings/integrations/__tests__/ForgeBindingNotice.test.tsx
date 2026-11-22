/**
 * ForgeBindingNotice — on a forge's settings, a repository that is none of
 * the project's remotes is flagged with the remote's repository as a fix,
 * and a project with nothing saved is told which remote it uses.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../../__tests__/helpers/renderer-api";
import type { ForgeBinding, ProjectForgeBindings } from "../../../../../shared/types";
import { ForgeBindingNotice } from "../ForgeBindingNotice";

const none: ForgeBinding = { status: "none", saved: null, candidates: [] };

let api: RendererApi | undefined;

function answer(github: ForgeBinding): ReturnType<typeof vi.fn> {
	const getForgeBindings = vi.fn(async () => ({
		success: true,
		data: { github, gitlab: none, azureDevOps: none } satisfies ProjectForgeBindings,
	}));
	api = installRendererApi({ getForgeBindings });
	return getForgeBindings;
}

afterEach(() => {
	cleanup();
	api?.restore();
	api = undefined;
});

describe("ForgeBindingNotice", () => {
	it("flags another project's repository and applies the remote's on click", async () => {
		const getForgeBindings = answer({
			status: "mismatch",
			saved: "krovomi/WorkPilot-AI",
			candidates: [{ label: "leub/dotnet", fix: { githubRepo: "leub/dotnet" } }],
		});
		const onApply = vi.fn();

		render(
			<ForgeBindingNotice
				projectId="p1"
				forge="github"
				current={{ githubRepo: "krovomi/WorkPilot-AI" }}
				onApply={onApply}
			/>,
		);

		const button = await screen.findByRole("button", { name: "Use leub/dotnet" });
		expect(
			screen.getByText("This project points at krovomi/WorkPilot-AI, which is not one of its remotes"),
		).toBeTruthy();
		expect(screen.getByTestId("forge-binding-mismatch-github")).toBeTruthy();
		expect(screen.getByText(/may come from another project/)).toBeTruthy();
		expect(getForgeBindings).toHaveBeenCalledWith("p1", { githubRepo: "krovomi/WorkPilot-AI" });

		await userEvent.click(button);
		expect(onApply).toHaveBeenCalledWith({ githubRepo: "leub/dotnet" });
	});

	it("says when no remote of the project is on that forge", async () => {
		answer({ status: "mismatch", saved: "krovomi/WorkPilot-AI", candidates: [] });

		render(<ForgeBindingNotice projectId="p1" forge="github" current={{}} onApply={vi.fn()} />);

		expect(await screen.findByText(/None of this project's remotes is on this forge/)).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("offers to save the detected repository when nothing is saved", async () => {
		answer({
			status: "detected",
			saved: null,
			candidates: [{ label: "leub/dotnet", fix: { githubRepo: "leub/dotnet" } }],
		});
		const onApply = vi.fn();

		render(<ForgeBindingNotice projectId="p1" forge="github" current={{}} onApply={onApply} />);

		await userEvent.click(await screen.findByRole("button", { name: "Save it in the settings" }));
		expect(onApply).toHaveBeenCalledWith({ githubRepo: "leub/dotnet" });
	});

	it("shows nothing when the repository matches, fails or there is no project", async () => {
		const getForgeBindings = answer({ status: "matched", saved: "a/b", candidates: [] });
		const { container, rerender } = render(
			<ForgeBindingNotice projectId="p1" forge="github" current={{}} onApply={vi.fn()} />,
		);
		await waitFor(() => expect(getForgeBindings).toHaveBeenCalled());
		expect(container.innerHTML).toBe("");

		getForgeBindings.mockResolvedValueOnce({ success: false, error: "Project not found" } as never);
		rerender(<ForgeBindingNotice projectId="p2" forge="github" current={{}} onApply={vi.fn()} />);
		await waitFor(() => expect(getForgeBindings).toHaveBeenCalledTimes(2));
		expect(container.innerHTML).toBe("");

		getForgeBindings.mockRejectedValueOnce(new Error("ipc down"));
		rerender(<ForgeBindingNotice projectId="p3" forge="github" current={{}} onApply={vi.fn()} />);
		await waitFor(() => expect(getForgeBindings).toHaveBeenCalledTimes(3));
		expect(container.innerHTML).toBe("");

		rerender(<ForgeBindingNotice projectId={undefined} forge="github" current={{}} onApply={vi.fn()} />);
		expect(container.innerHTML).toBe("");
		expect(getForgeBindings).toHaveBeenCalledTimes(3);
	});

	it("drops an answer that arrives after the project changed", async () => {
		let release: (value: unknown) => void = () => undefined;
		const getForgeBindings = vi.fn(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		api = installRendererApi({ getForgeBindings });
		const { container, rerender } = render(
			<ForgeBindingNotice projectId="p1" forge="github" current={{}} onApply={vi.fn()} />,
		);
		const first = release;
		rerender(<ForgeBindingNotice projectId={undefined} forge="github" current={{}} onApply={vi.fn()} />);
		first({
			success: true,
			data: {
				github: { status: "mismatch", saved: "x/y", candidates: [] },
				gitlab: none,
				azureDevOps: none,
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(container.innerHTML).toBe("");
	});
});
