/**
 * @vitest-environment jsdom
 */
/**
 * The modal that shows a task's pull request: loading, the reasons it could
 * not be shown, the overview, the files (expand one to see its diff), the
 * whole diff, and the link out to the forge.
 */
import type { PRData } from "@shared/types";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { PRFilesModal } from "../PRFilesModal";

const api = {
	getPRDetails: vi.fn(),
	openExternal: vi.fn(),
};

const GITHUB_URL = "https://github.com/acme/shop/pull/42";
const AZURE_URL = "https://dev.azure.com/acme/shop/_git/web/pullrequest/7";

function pr(over: Partial<PRData> = {}): PRData {
	return {
		number: 42,
		title: "Add the cart",
		body: "Adds a cart page.",
		author: "ada",
		state: "open",
		source_branch: "feat/cart",
		target_branch: "develop",
		additions: 12,
		deletions: 3,
		changed_files: 4,
		files: [
			{ filename: "src/old.ts", status: "removed", additions: 0, deletions: 4, changes: 4, patch: "@@ -1 +0,0 @@\n-gone" },
			{ filename: "README.md", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-a\n+b" },
			{
				filename: "src/cart.ts",
				status: "added",
				additions: 10,
				deletions: 0,
				changes: 10,
				patch: "@@ -0,0 +1 @@\n+export const cartTotal = 1;",
			},
			{
				filename: "src/shop.ts",
				status: "renamed",
				additions: 2,
				deletions: 3,
				changes: 5,
				patch: "",
				previous_filename: "src/store.ts",
			},
		],
		diff: "diff --git a/src/cart.ts b/src/cart.ts\n@@ -0,0 +1 @@\n+export const wholeDiffLine = 1;",
		url: GITHUB_URL,
		created_at: "2026-11-01T10:00:00Z",
		updated_at: "2026-11-02T10:00:00Z",
		labels: [],
		reviewers: [],
		is_draft: false,
		mergeable: true,
		...over,
	};
}

function answer(data: PRData | undefined = pr()) {
	return { success: true, data: { success: true, data } };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function show(props: Partial<Parameters<typeof PRFilesModal>[0]> = {}) {
	const onOpenChange = vi.fn();
	const view = render(
		<PRFilesModal open prUrl={GITHUB_URL} taskId="task-1" onOpenChange={onOpenChange} {...props} />,
	);
	return { ...view, onOpenChange };
}

beforeEach(async () => {
	vi.resetAllMocks();
	await i18n.changeLanguage("en");
	api.getPRDetails.mockResolvedValue(answer());
	Object.assign(globalThis.electronAPI, api);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("PRFilesModal", () => {
	it("shows nothing and asks nothing while closed", () => {
		const { container } = show({ open: false });
		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(api.getPRDetails).not.toHaveBeenCalled();
	});

	it("asks nothing without a PR link", () => {
		show({ prUrl: "" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(api.getPRDetails).not.toHaveBeenCalled();
	});

	it("says it is loading, then shows the PR overview with its state in words", async () => {
		const pending = deferred<ReturnType<typeof answer>>();
		api.getPRDetails.mockReturnValueOnce(pending.promise);
		const user = userEvent.setup();
		show();
		expect(await screen.findByRole("dialog", { name: "Loading PR files" })).toBeInTheDocument();
		expect(api.getPRDetails).toHaveBeenCalledWith(42, "task-1");
		await act(async () => pending.resolve(answer()));

		const dialog = await screen.findByRole("dialog", { name: "Pull Request Files #42" });
		expect(within(dialog).getByText("Add the cart")).toBeInTheDocument();
		await user.click(within(dialog).getByRole("tab", { name: "Overview" }));
		expect(screen.getByText("+12")).toBeInTheDocument();
		expect(screen.getByText("-3")).toBeInTheDocument();
		expect(screen.getByText("15")).toBeInTheDocument();
		expect(screen.getByText("ada")).toBeInTheDocument();
		expect(screen.getByText("feat/cart")).toBeInTheDocument();
		expect(screen.getByText("develop")).toBeInTheDocument();
		expect(screen.getByText("Open")).toBeInTheDocument();
		expect(screen.queryByText("open")).toBeNull();
		expect(screen.getByText("Adds a cart page.")).toBeInTheDocument();
	});

	it("names a closed PR and leaves out an empty description", async () => {
		api.getPRDetails.mockResolvedValueOnce(answer(pr({ state: "closed", body: "" })));
		const user = userEvent.setup();
		show();
		await user.click(await screen.findByRole("tab", { name: "Overview" }));
		expect(screen.getByText("Closed")).toBeInTheDocument();
		expect(screen.queryByText("Description")).toBeNull();
	});

	it("reads the number of an Azure DevOps PR link", async () => {
		show({ prUrl: AZURE_URL, taskId: undefined });
		await screen.findByRole("dialog", { name: /Pull Request Files/ });
		expect(api.getPRDetails).toHaveBeenCalledWith(7, undefined);
	});

	it("lists the files and opens and closes the diff of one", async () => {
		const user = userEvent.setup();
		show();
		const dialog = await screen.findByRole("dialog", { name: /Pull Request Files/ });
		expect(within(dialog).getByRole("tab", { name: "Files (4)" })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("(was: src/store.ts)")).toBeInTheDocument();

		const cart = screen.getByRole("button", { name: /src\/cart\.ts/ });
		expect(cart).toHaveAttribute("aria-expanded", "false");
		await user.click(cart);
		expect(cart).toHaveAttribute("aria-expanded", "true");
		expect(await screen.findByText(/cartTotal/)).toBeInTheDocument();
		await user.click(cart);
		expect(cart).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText(/cartTotal/)).toBeNull();

		// A file the forge sent no patch for says so instead of borrowing another's.
		await user.click(screen.getByRole("button", { name: /src\/shop\.ts/ }));
		expect(await screen.findByText("No diff content available for this file")).toBeInTheDocument();
	});

	it("shows the whole diff on its tab", async () => {
		const user = userEvent.setup();
		show();
		await user.click(await screen.findByRole("tab", { name: "Diff" }));
		expect(await screen.findByText(/wholeDiffLine/)).toBeInTheDocument();
	});

	it("opens the PR in the browser, whatever forge it is on", async () => {
		const user = userEvent.setup();
		show({ prUrl: AZURE_URL });
		await screen.findByRole("dialog", { name: /Pull Request Files/ });
		expect(screen.queryByText("Open in GitHub")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Open in browser" }));
		expect(api.openExternal).toHaveBeenCalledWith(AZURE_URL);
	});

	it("says why a link that is not a PR cannot be shown, without asking", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = show({ prUrl: "https://example.com/acme/shop" });
		expect(await screen.findByText("This link is not a GitHub or Azure DevOps pull request.")).toBeInTheDocument();
		expect(screen.getByRole("dialog", { name: "Pull Request Files Error" })).toBeInTheDocument();
		expect(api.getPRDetails).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Open in browser" }));
		expect(api.openExternal).toHaveBeenCalledWith("https://example.com/acme/shop");
		await user.click(screen.getAllByRole("button", { name: "Close" })[0]);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it.each([
		["the forge's reason", { success: false, error: "GitHub is not configured." }, "GitHub is not configured."],
		["a refusal without reason", { success: false }, "The pull request could not be loaded."],
		["a success without a PR", { success: true, data: { success: false } }, "The pull request came back empty."],
	])("shows %s", async (_name, result, text) => {
		api.getPRDetails.mockResolvedValueOnce(result);
		show();
		expect(await screen.findByText(text)).toBeInTheDocument();
	});

	it.each([
		["the error message", new Error("IPC channel closed"), "IPC channel closed"],
		["a generic reason for a bare failure", "boom", "The pull request could not be loaded."],
	])("shows %s when the call fails", async (_name, failure, text) => {
		api.getPRDetails.mockRejectedValueOnce(failure);
		show();
		expect(await screen.findByText(text)).toBeInTheDocument();
	});

	it("drops the answer for a PR the user has already left", async () => {
		const first = deferred<ReturnType<typeof answer>>();
		api.getPRDetails
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce(answer(pr({ number: 43, title: "Second PR" })));
		const { rerender, onOpenChange } = show();
		await screen.findByRole("dialog", { name: "Loading PR files" });
		rerender(
			<PRFilesModal
				open
				prUrl="https://github.com/acme/shop/pull/43"
				taskId="task-2"
				onOpenChange={onOpenChange}
			/>,
		);
		expect(await screen.findByText("Second PR")).toBeInTheDocument();
		await act(async () => first.resolve(answer(pr({ title: "First PR" }))));
		expect(screen.queryByText("First PR")).toBeNull();
		expect(screen.getByText("Second PR")).toBeInTheDocument();
	});

	it("forgets the PR when closed and reloads it when opened again", async () => {
		const { rerender, onOpenChange } = show();
		await screen.findByText("Add the cart");
		rerender(<PRFilesModal open={false} prUrl={GITHUB_URL} onOpenChange={onOpenChange} />);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		rerender(<PRFilesModal open prUrl={GITHUB_URL} onOpenChange={onOpenChange} />);
		expect(await screen.findByText("Add the cart")).toBeInTheDocument();
		expect(api.getPRDetails).toHaveBeenCalledTimes(2);
	});
});
