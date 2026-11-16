/**
 * The dialog that opens a GitLab MR: what it sends, what it refuses, and
 * what it says when GitLab refuses.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import { CreateMergeRequestDialog } from "../CreateMergeRequestDialog";

const t = (key: string) => i18n.t(`gitlab:mergeRequests.create.${key}`);

type Create = (
	projectId: string,
	data: Record<string, unknown>,
) => Promise<{ success: boolean; data?: { iid: number }; error?: string }>;

function setup(create: Create, defaults: { source?: string } = {}) {
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		createGitLabMergeRequest: vi.fn(create),
	};
	const props = {
		open: true,
		onOpenChange: vi.fn(),
		projectId: "p1",
		defaultSourceBranch: defaults.source,
		onSuccess: vi.fn(),
	};
	const view = render(<CreateMergeRequestDialog {...props} />);
	return { props, ...view, user: userEvent.setup() };
}

const api = () =>
	(
		window as unknown as {
			electronAPI: { createGitLabMergeRequest: ReturnType<typeof vi.fn> };
		}
	).electronAPI.createGitLabMergeRequest;
const field = (key: string) => screen.getByLabelText(t(key));
const submit = () => screen.getByRole("button", { name: t("title") });

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("CreateMergeRequestDialog", () => {
	it("sends the trimmed fields and hands back the new MR", async () => {
		const { props, user } = setup(async () => ({
			success: true,
			data: { iid: 42 },
		}));

		await user.type(field("titleLabel"), "  Add the export ");
		await user.type(field("sourceBranch"), " feat/export ");
		await user.type(field("descriptionLabel"), " Exports CSV. ");
		await user.click(submit());

		expect(api()).toHaveBeenCalledWith("p1", {
			title: "Add the export",
			sourceBranch: "feat/export",
			targetBranch: "main",
			description: "Exports CSV.",
		});
		expect(props.onSuccess).toHaveBeenCalledWith(42);
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
		expect(field("titleLabel")).toHaveValue("");
	});

	it("leaves out a blank description and keeps the default branches", async () => {
		const { user } = setup(
			async () => ({ success: true, data: { iid: 1 } }),
			{ source: "feat/x" },
		);

		expect(field("sourceBranch")).toHaveValue("feat/x");
		await user.type(field("titleLabel"), "T");
		await user.type(field("descriptionLabel"), "   ");
		await user.click(submit());

		expect(api()).toHaveBeenCalledWith("p1", {
			title: "T",
			sourceBranch: "feat/x",
			targetBranch: "main",
			description: undefined,
		});
		expect(field("sourceBranch")).toHaveValue("feat/x");
	});

	it("refuses a form without its title and branches", async () => {
		const { user } = setup(async () => ({ success: true }));

		await user.type(field("titleLabel"), "T");
		await user.clear(field("targetBranch"));
		await user.type(field("sourceBranch"), "feat/x");
		await user.click(submit());

		expect(screen.getByText(t("required"))).toBeInTheDocument();
		expect(api()).not.toHaveBeenCalled();
	});

	it("shows GitLab's refusal, or a word of its own when there is none", async () => {
		const answers = [
			{ success: false, error: "Branch already has an open MR" },
			{ success: true },
		];
		const { props, user } = setup(async () => answers.shift() ?? { success: false });

		await user.type(field("titleLabel"), "T");
		await user.type(field("sourceBranch"), "feat/x");
		await user.click(submit());
		expect(
			screen.getByText("Branch already has an open MR"),
		).toBeInTheDocument();

		await user.click(submit());
		expect(screen.getByText(t("failed"))).toBeInTheDocument();
		expect(props.onSuccess).not.toHaveBeenCalled();
	});

	it("shows a thrown error, and a word of its own for anything else", async () => {
		const throws: unknown[] = [new Error("Network down"), "boom"];
		const { user } = setup(async () => {
			throw throws.shift();
		});

		await user.type(field("titleLabel"), "T");
		await user.type(field("sourceBranch"), "feat/x");
		await user.click(submit());
		expect(screen.getByText("Network down")).toBeInTheDocument();

		await user.click(submit());
		expect(screen.getByText(t("failed"))).toBeInTheDocument();
	});

	it("shows the request as running until GitLab answers", async () => {
		let answer: (value: { success: boolean }) => void = () => undefined;
		const { user } = setup(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);

		await user.type(field("titleLabel"), "T");
		await user.type(field("sourceBranch"), "feat/x");
		await user.click(submit());

		expect(
			screen.getByRole("button", { name: i18n.t("common:buttons.creating") }),
		).toBeDisabled();
		answer({ success: false });
		expect(await screen.findByText(t("failed"))).toBeInTheDocument();
	});

	it("closes on cancel", async () => {
		const { props, user } = setup(async () => ({ success: true }));
		await user.click(
			screen.getByRole("button", { name: i18n.t("common:buttons.cancel") }),
		);
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
	});

	it("gives each dialog fields of its own", () => {
		setup(async () => ({ success: true }));
		render(
			<CreateMergeRequestDialog open onOpenChange={vi.fn()} projectId="p2" />,
		);
		const ids = screen
			.getAllByLabelText(t("titleLabel"))
			.map((input) => input.id);
		expect(new Set(ids).size).toBe(2);
	});
});
