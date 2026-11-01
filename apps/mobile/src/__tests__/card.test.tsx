import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { Api } from "../api/endpoints";
import type { CardDetails } from "../api/types";
import "../i18n";
import { ChangesSection } from "../card/ChangesSection";
import { canEditCard, EditCard } from "../card/EditCard";
import { MAX_PATCH_LINES, patchLines } from "../card/patch";

const mockApi = { updateCard: jest.fn(async () => ({})) } as unknown as Api & { updateCard: jest.Mock };
jest.mock("../auth/session", () => ({ useApi: () => mockApi }));

const details: CardDetails = {
	id: "004-add-login",
	title: "Add login",
	column: "backlog",
	kind: "feature",
	updatedAt: null,
	subtasks: { completed: 0, total: 0 },
	description: "Users sign in.",
	spec: null,
	qaReport: null,
	approval: { approved: false, approvedBy: null, approvedAt: null },
	requireReview: true,
};

describe("patchLines", () => {
	it("tells added, removed, hunk and header lines apart", () => {
		const { lines, truncated } = patchLines(
			"diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n",
		);
		expect(lines.map((l) => l.kind)).toEqual(["meta", "meta", "meta", "hunk", "removed", "added", "context"]);
		expect(truncated).toBe(false);
	});

	it("cuts a very long diff", () => {
		const { lines, truncated } = patchLines(Array.from({ length: MAX_PATCH_LINES + 5 }, () => "+x").join("\n"));
		expect(lines).toHaveLength(MAX_PATCH_LINES);
		expect(truncated).toBe(true);
	});
});

describe("canEditCard", () => {
	it("allows editing until a spec exists or an agent works on it", () => {
		expect(canEditCard(details, false)).toBe(true);
		expect(canEditCard({ ...details, spec: "# Spec" }, false)).toBe(false);
		expect(canEditCard(details, true)).toBe(false);
		expect(canEditCard({ ...details, column: "human_review" }, false)).toBe(false);
	});
});

describe("EditCard", () => {
	beforeEach(() => mockApi.updateCard.mockClear());

	it("sends only what changed, then hands back", async () => {
		const onSaved = jest.fn();
		await render(<EditCard projectId="p1" details={details} onCancel={jest.fn()} onSaved={onSaved} />);
		const save = screen.getByRole("button", { name: "Save" });
		expect(save).toBeDisabled();
		await fireEvent.changeText(screen.getByLabelText("Description"), "Users sign in with SSO.");
		await fireEvent.press(save);
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(mockApi.updateCard).toHaveBeenCalledWith("p1", "004-add-login", { description: "Users sign in with SSO." });
	});

	it("shows the server's refusal once work started", async () => {
		const { ApiError } = jest.requireActual("../api/client");
		mockApi.updateCard.mockRejectedValueOnce(new ApiError(409, "Work has started on this card; it cannot be edited"));
		const onSaved = jest.fn();
		await render(<EditCard projectId="p1" details={details} onCancel={jest.fn()} onSaved={onSaved} />);
		await fireEvent.changeText(screen.getByLabelText("Title"), "Add SSO login");
		await fireEvent.press(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText(/Work has started on this card/)).toBeTruthy();
		expect(onSaved).not.toHaveBeenCalled();
	});
});

describe("ChangesSection", () => {
	it("opens a file's diff on tap", async () => {
		await render(
			<ChangesSection
				changes={{
					exists: true,
					filesChanged: 1,
					additions: 1,
					deletions: 1,
					commitCount: 1,
					files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }],
				}}
			/>,
		);
		expect(screen.queryByText("+new")).toBeNull();
		await fireEvent.press(screen.getByRole("button", { name: /src\/a\.ts/ }));
		expect(screen.getByText("+new")).toBeTruthy();
		expect(screen.getByText("-old")).toBeTruthy();
	});

	it("says when a file has no diff to show", async () => {
		await render(
			<ChangesSection
				changes={{
					exists: true,
					files: [{ path: "logo.png", status: "added", additions: 0, deletions: 0, patch: null }],
				}}
			/>,
		);
		await fireEvent.press(screen.getByRole("button", { name: /logo\.png/ }));
		expect(screen.getByText(/No diff to show/)).toBeTruthy();
	});
});
