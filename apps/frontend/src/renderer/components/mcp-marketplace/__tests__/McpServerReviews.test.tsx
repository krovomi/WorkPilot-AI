/** @vitest-environment jsdom */
/**
 * The organization's reviews of a catalog server (#369, lots 5 and 6): shown
 * in a server project only, the caller's own review prefilled, written,
 * replaced and deleted through the main; whoever the server does not let
 * write (members, viewers) reads without a form; a failure is named.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpReviewList, McpServerReview } from "../../../../shared/types/mcp-reviews";
import { useProjectStore } from "../../../stores/project-store";
import { McpServerReviews } from "../McpServerReviews";
import { type MainApi, resetWorld, selectProject } from "./mcp-world";

let api: MainApi;

const OTHER: McpServerReview = {
	id: "0123abcd-0000-4000-8000-000000000001",
	serverId: "github",
	verdict: "unsafe",
	comment: "Calls an undocumented host.\nTwice.",
	author: "Bob",
	updatedAt: "2026-11-22T10:00:00+00:00",
	mine: false,
	canDelete: false,
};
const MINE: McpServerReview = {
	...OTHER,
	id: "0123abcd-0000-4000-8000-000000000002",
	verdict: "safe",
	comment: "Fine here.",
	author: "",
	updatedAt: null,
	mine: true,
	canDelete: true,
};

/** The list the main answers; writable unless said otherwise. */
const list = (reviews: McpServerReview[], canWrite = true): McpReviewList => ({
	reviews,
	canWrite,
});

function deferred() {
	let resolve!: (value: unknown) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise((ok, ko) => {
		resolve = ok;
		reject = ko;
	});
	return { promise, resolve, reject };
}

function serverProject(role: "viewer" | "member" | "owner" = "member") {
	act(() =>
		useProjectStore.setState({
			selectedProjectId: "p-1",
			projects: [
				{ id: "p-1", name: "Shop", remote: { repoUrl: "x", defaultBranch: "main", role } },
			] as never,
		}),
	);
}

beforeEach(async () => {
	api = await resetWorld();
});

afterEach(cleanup);

describe("McpServerReviews", () => {
	it("shows nothing for a local project or none", () => {
		selectProject("local");
		const { container } = render(<McpServerReviews serverId="github" />);
		expect(container).toBeEmptyDOMElement();
		selectProject(null);
		expect(container).toBeEmptyDOMElement();
		expect(api.listMcpReviews).not.toHaveBeenCalled();
	});

	it("lists the team's reviews and prefills the caller's own", async () => {
		api.listMcpReviews.mockResolvedValue({ success: true, data: list([MINE, OTHER]) });
		serverProject();
		render(<McpServerReviews serverId="github" />);
		expect(await screen.findByText("by Bob")).toBeInTheDocument();
		expect(api.listMcpReviews).toHaveBeenCalledWith({ projectId: "p-1", serverId: "github" });
		expect(screen.getByText("by a former member")).toBeInTheDocument();
		expect(screen.getByText(/Calls an undocumented host/)).toBeInTheDocument();
		expect(screen.getByLabelText("Comment")).toHaveValue("Fine here.");
		expect(screen.getByLabelText("Your review (saving replaces it)")).toHaveValue("safe");
		// Only the caller's own review offers a delete.
		expect(screen.getAllByRole("button", { name: "Delete this review" })).toHaveLength(1);
		expect(screen.getByRole("button", { name: "Update the review" })).toBeInTheDocument();
	});

	it("posts a review and reads the list again", async () => {
		serverProject();
		render(<McpServerReviews serverId="github" />);
		expect(await screen.findByText(/No one in the organization/)).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Your review"), { target: { value: "unsafe" } });
		fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Sends telemetry." } });
		api.listMcpReviews.mockResolvedValueOnce({
			success: true,
			data: list([{ ...MINE, verdict: "unsafe", comment: "Sends telemetry." }]),
		});
		fireEvent.click(screen.getByRole("button", { name: "Post the review" }));
		await waitFor(() =>
			expect(api.putMcpReview).toHaveBeenCalledWith({
				projectId: "p-1",
				serverId: "github",
				verdict: "unsafe",
				comment: "Sends telemetry.",
			}),
		);
		expect(await screen.findByRole("button", { name: "Update the review" })).toBeInTheDocument();
	});

	it("deletes the caller's review and empties the form", async () => {
		api.listMcpReviews.mockResolvedValueOnce({ success: true, data: list([MINE]) });
		serverProject();
		render(<McpServerReviews serverId="github" />);
		fireEvent.click(await screen.findByRole("button", { name: "Delete this review" }));
		await waitFor(() =>
			expect(api.deleteMcpReview).toHaveBeenCalledWith({ projectId: "p-1", reviewId: MINE.id }),
		);
		expect(await screen.findByText(/No one in the organization/)).toBeInTheDocument();
		expect(screen.getByLabelText("Comment")).toHaveValue("");
	});

	it("lets an administrator delete a colleague's review, and keeps the form", async () => {
		api.listMcpReviews.mockResolvedValueOnce({
			success: true,
			data: list([{ ...OTHER, canDelete: true }]),
		});
		serverProject("owner");
		render(<McpServerReviews serverId="github" />);
		fireEvent.change(await screen.findByLabelText("Comment"), { target: { value: "draft" } });
		fireEvent.click(screen.getByRole("button", { name: "Delete this review" }));
		await waitFor(() => expect(api.deleteMcpReview).toHaveBeenCalled());
		expect(screen.getByLabelText("Comment")).toHaveValue("draft");
	});

	it("gives whoever may not write the reviews without a form", async () => {
		// A member of the project: the server grants `marketplace.write` to
		// maintainers and administrators only, whatever the project role.
		api.listMcpReviews.mockResolvedValue({ success: true, data: list([OTHER], false) });
		serverProject("member");
		render(<McpServerReviews serverId="github" />);
		expect(await screen.findByText("by Bob")).toBeInTheDocument();
		expect(screen.queryByLabelText("Comment")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Post the review" })).not.toBeInTheDocument();
	});

	it("offers the form to a writer whatever the project role", async () => {
		api.listMcpReviews.mockResolvedValue({ success: true, data: list([OTHER]) });
		serverProject("viewer");
		render(<McpServerReviews serverId="github" />);
		expect(await screen.findByLabelText("Comment")).toBeInTheDocument();
	});

	it.each([
		["too_many_reviews", "This organization holds as many reviews as it can."],
		["Forbidden", "The server refused or could not be reached."],
		[undefined, "The server refused or could not be reached."],
	])("names a refused write (%s)", async (error, text) => {
		api.putMcpReview.mockResolvedValueOnce({ success: false, error });
		serverProject();
		render(<McpServerReviews serverId="github" />);
		fireEvent.click(await screen.findByRole("button", { name: "Post the review" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(text);
		expect(api.listMcpReviews).toHaveBeenCalledTimes(1);
	});

	it("names a write that throws, and a delete of a review gone", async () => {
		api.listMcpReviews.mockResolvedValueOnce({ success: true, data: list([MINE]) });
		api.putMcpReview.mockRejectedValueOnce(new Error("bridge"));
		api.deleteMcpReview.mockResolvedValueOnce({ success: false, error: "review_not_found" });
		serverProject();
		render(<McpServerReviews serverId="github" />);
		fireEvent.click(await screen.findByRole("button", { name: "Update the review" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("could not be reached");
		fireEvent.click(screen.getByRole("button", { name: "Delete this review" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("no longer exists");
		expect(screen.getByLabelText("Comment")).toHaveValue("Fine here.");
	});

	it("keeps the list when the reread fails", async () => {
		api.listMcpReviews
			.mockResolvedValueOnce({ success: true, data: list([OTHER]) })
			.mockResolvedValueOnce({ success: false });
		serverProject();
		render(<McpServerReviews serverId="github" />);
		fireEvent.click(await screen.findByRole("button", { name: "Post the review" }));
		await waitFor(() => expect(api.listMcpReviews).toHaveBeenCalledTimes(2));
		expect(screen.getByText("by Bob")).toBeInTheDocument();
	});

	it.each([
		[{ success: false, error: "not_a_server_project" }, "The server refused"],
		[{ success: false }, "The server refused"],
	])("names a failed read %j", async (answer, text) => {
		api.listMcpReviews.mockResolvedValueOnce(answer);
		serverProject();
		render(<McpServerReviews serverId="github" />);
		expect(await screen.findByRole("alert")).toHaveTextContent(text);
		expect(screen.getByText(/No one in the organization/)).toBeInTheDocument();
	});

	it("names a read that throws, and ignores an answer after unmount", async () => {
		api.listMcpReviews.mockRejectedValueOnce(new Error("bridge"));
		serverProject();
		const first = render(<McpServerReviews serverId="github" />);
		expect(await screen.findByRole("alert")).toBeInTheDocument();
		first.unmount();

		const answer = deferred();
		api.listMcpReviews.mockImplementationOnce(() => answer.promise);
		const late = render(<McpServerReviews serverId="github" />);
		late.unmount();
		await act(async () => answer.resolve({ success: true, data: list([OTHER]) }));
		const failure = deferred();
		api.listMcpReviews.mockImplementationOnce(() => failure.promise);
		const gone = render(<McpServerReviews serverId="github" />);
		gone.unmount();
		await act(async () => failure.reject(new Error("late")));
		expect(screen.queryByText("by Bob")).not.toBeInTheDocument();
	});
});
