/**
 * @vitest-environment jsdom
 */
/**
 * The dialog that sets git up for a project that has none (or no commit):
 * what it will do, the identity git may ask for, failures, skipping, and the
 * parent hearing of the outcome once the dialog has closed.
 */
import type { GitStatus, Project } from "@shared/types";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { GitSetupModal } from "../GitSetupModal";
import { Toaster } from "../ui/toaster";

const api = { initializeGit: vi.fn() };

const PROJECT = { id: "p1", name: "Shop", path: "/work/shop" } as Project;
const NO_REPO: GitStatus = { isGitRepo: false, hasCommits: false, currentBranch: null };
const NO_COMMIT: GitStatus = { isGitRepo: true, hasCommits: false, currentBranch: "main" };

type Props = Parameters<typeof GitSetupModal>[0];

function show(over: Partial<Props> = {}) {
	const props: Props = {
		open: true,
		onOpenChange: vi.fn(),
		project: PROJECT,
		gitStatus: NO_REPO,
		onGitInitialized: vi.fn(),
		...over,
	};
	const view = render(
		<>
			<GitSetupModal {...props} />
			<Toaster />
		</>,
	);
	return { ...view, props };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const initButton = () => screen.getByRole("button", { name: "Initialize Git" });

beforeEach(async () => {
	vi.resetAllMocks();
	await i18n.changeLanguage("en");
	api.initializeGit.mockResolvedValue({ success: true });
	Object.assign(globalThis.electronAPI, api);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("GitSetupModal", () => {
	it("explains that the folder needs git and what will be done", () => {
		show();
		expect(screen.getByRole("dialog", { name: "Git Repository Required" })).toBeInTheDocument();
		expect(screen.getByText("This folder is not a git repository")).toBeInTheDocument();
		expect(screen.getByText(/Git needs to be initialized/)).toBeInTheDocument();
		expect(screen.getByText("Initialize a new git repository")).toBeInTheDocument();
		expect(screen.getByText("Create an initial commit with your current files")).toBeInTheDocument();
		expect(screen.getByText("git init")).toBeInTheDocument();
		expect(screen.getByText('git commit -m "Initial commit"')).toBeInTheDocument();
		expect(screen.queryByText("Set up the remote")).toBeNull();
	});

	it("asks only for a first commit in a repository without one", () => {
		show({ gitStatus: NO_COMMIT });
		expect(screen.getByText("Git repository has no commits")).toBeInTheDocument();
		expect(screen.getByText(/At least one commit is required/)).toBeInTheDocument();
		expect(screen.queryByText("Initialize a new git repository")).toBeNull();
		expect(screen.queryByText("git init")).toBeNull();
	});

	it("speaks of a first commit when the git status is not known yet", () => {
		show({ gitStatus: null });
		expect(screen.getByText("Git repository has no commits")).toBeInTheDocument();
	});

	it("initializes git with the remote, then closes and tells the parent", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pending = deferred<{ success: boolean }>();
		api.initializeGit.mockReturnValueOnce(pending.promise);
		const remote = { url: "https://github.com/acme/shop.git", name: "origin" };
		const { props } = show({ remoteConfig: remote });
		expect(screen.getByText("Set up the remote")).toBeInTheDocument();
		act(() => initButton().click());
		expect(screen.getByRole("dialog", { name: "Setting up Git" })).toBeInTheDocument();
		expect(screen.getByText(/Initializing git repository/)).toBeInTheDocument();
		expect(api.initializeGit).toHaveBeenCalledWith("/work/shop", remote, undefined);
		await act(async () => pending.resolve({ success: true }));
		expect(screen.getByText("Git Initialized")).toBeInTheDocument();
		expect(screen.getByText(/ready to use with WorkPilot AI/)).toBeInTheDocument();
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
		expect(props.onGitInitialized).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(100));
		expect(props.onGitInitialized).toHaveBeenCalledTimes(1);
	});

	it("keeps the remote it was given when the parent drops it", () => {
		const remote = { url: "https://github.com/acme/shop.git" };
		const { rerender, props } = show({ remoteConfig: remote });
		rerender(<GitSetupModal {...props} remoteConfig={undefined} />);
		expect(screen.getByText("Set up the remote")).toBeInTheDocument();
	});

	it("does nothing without a project", async () => {
		const user = userEvent.setup();
		show({ project: null });
		await user.click(initButton());
		expect(api.initializeGit).not.toHaveBeenCalled();
	});

	it("asks for the git identity when the machine has none, then sends it", async () => {
		const user = userEvent.setup();
		api.initializeGit.mockResolvedValueOnce({
			success: false,
			data: { success: false, blocker: "git-identity-missing" },
		});
		show();
		await user.click(initButton());
		expect(await screen.findByText("Git needs your name and email")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(initButton()).toBeDisabled();
		await user.type(screen.getByLabelText("Name"), "Ada Lovelace");
		await user.type(screen.getByLabelText("Email"), "ada@example.com");
		expect(initButton()).toBeEnabled();
		await user.click(initButton());
		expect(api.initializeGit).toHaveBeenLastCalledWith("/work/shop", undefined, {
			name: "Ada Lovelace",
			email: "ada@example.com",
		});
	});

	it.each([
		["git's reason", { success: false, error: "permission denied" }, "permission denied"],
		["a translated reason when git gave none", { success: false }, "Could not initialize the Git repository."],
	])("shows %s when it fails, and can try again", async (_name, result, text) => {
		const user = userEvent.setup();
		api.initializeGit.mockResolvedValueOnce(result);
		const { props } = show();
		await user.click(initButton());
		expect(await screen.findAllByText(text)).toHaveLength(2);
		expect(screen.getByText("Initialization failed")).toBeInTheDocument();
		expect(screen.queryByText("Failed to initialize git")).toBeNull();
		expect(initButton()).toBeEnabled();
		expect(props.onOpenChange).not.toHaveBeenCalled();
	});

	it.each([
		["the error message", new Error("spawn git ENOENT"), "spawn git ENOENT"],
		["a translated reason for a bare failure", "boom", "Could not initialize the Git repository."],
	])("shows %s when the call fails", async (_name, failure, text) => {
		const user = userEvent.setup();
		api.initializeGit.mockRejectedValueOnce(failure);
		show();
		await user.click(initButton());
		expect(await screen.findAllByText(text)).toHaveLength(2);
		expect(screen.getByRole("dialog", { name: "Git Repository Required" })).toBeInTheDocument();
	});

	it("skips: says so, closes, then tells the parent", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const onSkip = vi.fn();
		const { props } = show({ onSkip });
		act(() => screen.getByRole("button", { name: "Skip for now" }).click());
		expect(screen.getByText("Git setup skipped")).toBeInTheDocument();
		expect(screen.getByText("You can initialize Git later.")).toBeInTheDocument();
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
		expect(onSkip).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(100));
		expect(onSkip).toHaveBeenCalledTimes(1);
	});

	it("skips without a skip callback", () => {
		const { props } = show();
		act(() => screen.getByRole("button", { name: "Skip for now" }).click());
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
	});

	it("does not call the parent back once unmounted", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const onSkip = vi.fn();
		const { unmount } = show({ onSkip });
		act(() => screen.getByRole("button", { name: "Skip for now" }).click());
		unmount();
		act(() => vi.advanceTimersByTime(100));
		expect(onSkip).not.toHaveBeenCalled();
	});
});
