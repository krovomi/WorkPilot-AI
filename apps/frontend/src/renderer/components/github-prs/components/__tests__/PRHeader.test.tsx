/**
 * The top of a PR's page: its state, title, author, branches and the list of
 * changed files, opened on demand.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { PRData } from "../../hooks/useGitHubPRs";
import { PRHeader } from "../PRHeader";

const PR = {
	number: 42,
	title: "Add retries",
	state: "open",
	author: { login: "ana" },
	headRefName: "feat/retries",
	baseRefName: "develop",
	additions: 30,
	deletions: 4,
	changedFiles: 3,
	createdAt: "2026-11-02T10:00:00Z",
	htmlUrl: "https://github.com/o/r/pull/42",
	files: [
		{ path: "src/a.ts", additions: 10, deletions: 1, status: "modified" },
		{ path: "src/b.ts", additions: 20, deletions: 0, status: "added" },
		{ path: "src/old.ts", additions: 0, deletions: 3, status: "removed" },
		{ path: "src/c.ts", additions: 0, deletions: 0, status: "renamed" },
		{ path: "src/d.ts", additions: 0, deletions: 0, status: "copied" },
	],
} as PRData;

describe("PRHeader", () => {
	afterEach(() => i18n.changeLanguage("en"));

	it("shows what the PR is and links to it on GitHub", () => {
		render(<PRHeader pr={PR} />);
		expect(screen.getByRole("heading", { name: "Add retries" })).toBeInTheDocument();
		expect(screen.getByText("Open")).toBeInTheDocument();
		expect(screen.getByText("#42")).toBeInTheDocument();
		expect(screen.getByText("ana")).toBeInTheDocument();
		expect(screen.getByText("feat/retries")).toBeInTheDocument();
		expect(screen.getByText("develop")).toBeInTheDocument();
		expect(screen.getByText("+30")).toBeInTheDocument();
		expect(screen.getByText("-4")).toBeInTheDocument();
		// An icon alone: the link still says where it goes.
		expect(
			screen.getByRole("link", { name: "Open on GitHub (opens in new window)" }),
		).toHaveAttribute("href", "https://github.com/o/r/pull/42");
	});

	it("names a closed PR, and a state it does not know as GitHub gives it", () => {
		const { rerender } = render(<PRHeader pr={{ ...PR, state: "CLOSED" }} />);
		expect(screen.getByText("Closed")).toBeInTheDocument();
		rerender(<PRHeader pr={{ ...PR, state: "draft" }} />);
		expect(screen.getByText("draft")).toBeInTheDocument();
	});

	it("opens the changed files, each with its change in the app's language", async () => {
		await i18n.changeLanguage("fr");
		render(<PRHeader pr={PR} />);
		expect(screen.queryByText("src/a.ts")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /3\s*fichiers/ }));
		expect(screen.getByText("src/a.ts")).toBeInTheDocument();
		for (const word of ["modifié", "ajouté", "supprimé", "renommé", "copié"]) {
			expect(screen.getByText(word)).toBeInTheDocument();
		}
		await userEvent.click(screen.getByRole("button", { name: /3\s*fichiers/ }));
		expect(screen.queryByText("src/a.ts")).toBeNull();
	});

	it("counts one file in the singular, and keeps an unknown change as is", async () => {
		render(
			<PRHeader
				pr={{
					...PR,
					changedFiles: 1,
					files: [{ path: "x.ts", additions: 1, deletions: 1, status: "merged-in" }],
				}}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: /1\s*file$/ }));
		expect(screen.getByText("merged-in")).toBeInTheDocument();
	});

	it("says the files are loading, or that GitHub gave none", async () => {
		const { rerender } = render(<PRHeader pr={PR} isLoadingFiles />);
		await userEvent.click(screen.getByRole("button", { name: /3\s*files/ }));
		expect(screen.getByText("Loading files...")).toBeInTheDocument();
		rerender(<PRHeader pr={{ ...PR, files: [] }} />);
		expect(screen.getByText("File list not available")).toBeInTheDocument();
	});
});
