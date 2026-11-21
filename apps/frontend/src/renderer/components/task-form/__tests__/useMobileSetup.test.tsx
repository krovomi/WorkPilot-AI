/**
 * @vitest-environment jsdom
 */

/**
 * useMobileSetup, seen through the "Mobile platforms" box it feeds: the
 * project's mobile profile read once per project, the framework a setup would
 * install, and the setup tasks the checked platforms add (or join).
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { Task } from "../../../../shared/types";
import type { MobilePlatform, MobileProfile } from "../../../../shared/types/mobile";
import { useTaskStore } from "../../../stores/task-store";
import { MobileTargetsFields } from "../MobileTargetsFields";
import { clearMobileProfileCache, useMobileSetup } from "../useMobileSetup";

const flutter = {
	id: "flutter",
	label: "Flutter",
	platforms: ["android", "ios"] as MobilePlatform[],
	install: [],
	scaffold: [],
	platformSetup: {},
	docs: "",
	notes: "",
};
const kotlin = { ...flutter, id: "kotlin", label: "Kotlin", platforms: ["android"] as MobilePlatform[] };

const NO_APP: MobileProfile = {
	success: true,
	isMobile: false,
	frameworks: [flutter, kotlin],
};

const getMobileProfile = vi.fn();
const originalApi = window.electronAPI;

function answer(profile: MobileProfile | undefined, success = true) {
	return { success, data: profile };
}

function Box({ projectId, initial = [] }: { projectId?: string; initial?: MobilePlatform[] }) {
	const [targets, setTargets] = useState<MobilePlatform[]>(initial);
	const setup = useMobileSetup(projectId, targets);
	return (
		<>
			<output data-testid="profile-state">
				{setup.profile === undefined ? "loading" : setup.profile === null ? "none" : "read"}
			</output>
			<MobileTargetsFields targets={targets} onTargetsChange={setTargets} setup={setup} idPrefix="" />
		</>
	);
}

function setupTask(framework: string, overrides: Partial<Task> = {}): Task {
	return {
		id: `setup-${framework}`,
		projectId: "p1",
		title: "Setup",
		status: "backlog",
		metadata: { mobileBootstrap: { framework, step: "install" } },
		...overrides,
	} as Task;
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	clearMobileProfileCache();
	getMobileProfile.mockReset();
	(window as unknown as { electronAPI: unknown }).electronAPI = { getMobileProfile };
	useTaskStore.setState({ tasks: [] });
});
afterEach(cleanup);
afterAll(() => {
	(window as unknown as { electronAPI: unknown }).electronAPI = originalApi;
});

const platform = (name: string) => screen.getByRole("checkbox", { name });

describe("useMobileSetup", () => {
	it("reads the profile once per project and plans the setup a platform needs", async () => {
		getMobileProfile.mockResolvedValue(answer({ ...NO_APP, mobileDir: "apps/phone" }));
		render(<Box projectId="p1" />);
		expect(screen.getByTestId("profile-state")).toHaveTextContent("loading");
		expect(await screen.findByText("This project has no mobile app yet")).toBeInTheDocument();
		expect(screen.getByText(/in the apps\/phone\/ folder/)).toBeInTheDocument();
		expect(screen.queryByText(/Stacks found in the project/)).not.toBeInTheDocument();
		expect(screen.queryByTestId("mobile-setup-plan")).not.toBeInTheDocument();

		fireEvent.click(platform("Android"));
		const plan = screen.getByTestId("mobile-setup-plan");
		expect(plan).toHaveTextContent("Install Flutter and create the mobile app");
		expect(plan).toHaveTextContent("Prepare the Flutter app for Android");
		expect(plan).toHaveTextContent("This task, which starts once the ones above are done");
		const select = screen.getByRole("combobox", { name: "Mobile framework" });
		expect(select).toHaveValue("flutter");
		expect(screen.getByRole("option", { name: "Flutter (recommended)" })).toBeInTheDocument();
		fireEvent.change(select, { target: { value: "kotlin" } });
		expect(plan).toHaveTextContent("Install Kotlin and create the mobile app");

		// Both platforms: only Flutter builds both.
		fireEvent.click(platform("Apple (iOS)"));
		expect(screen.getByRole("combobox", { name: "Mobile framework" })).toHaveValue("flutter");

		fireEvent.click(platform("Android"));
		fireEvent.click(platform("Apple (iOS)"));
		expect(screen.queryByTestId("mobile-setup-plan")).not.toBeInTheDocument();
		cleanup();

		render(<Box projectId="p1" />);
		expect(screen.getByTestId("profile-state")).toHaveTextContent("read");
		expect(getMobileProfile).toHaveBeenCalledTimes(1);
	});

	it("joins the setup already on the board instead of offering a choice", async () => {
		getMobileProfile.mockResolvedValue(answer(NO_APP));
		useTaskStore.setState({
			tasks: [setupTask("kotlin"), setupTask("flutter", { id: "other", projectId: "p2" })],
		});
		render(<Box projectId="p1" initial={["android"]} />);
		expect(
			await screen.findByText("A Kotlin setup is already on the board: this task joins it."),
		).toBeInTheDocument();
		expect(screen.queryByRole("combobox", { name: "Mobile framework" })).not.toBeInTheDocument();
		expect(screen.getByTestId("mobile-setup-plan")).toHaveTextContent(
			"Install Kotlin and create the mobile app (already on the board, reused)",
		);
	});

	it("uses the app the project has", async () => {
		getMobileProfile.mockResolvedValue(
			answer({ success: true, isMobile: true, stack: { framework: "flutter", platforms: ["ios"] } }),
		);
		render(<Box projectId="p1" />);
		expect(await screen.findByText(/^App detected: /)).toHaveTextContent("(Apple (iOS))");
		expect(platform("Android")).toBeDisabled();
		expect(screen.getByText("Android")).toHaveAttribute(
			"title",
			"This platform is not part of the project's app.",
		);
		fireEvent.click(platform("Apple (iOS)"));
		expect(platform("Apple (iOS)")).toBeChecked();
		expect(screen.queryByTestId("mobile-setup-plan")).not.toBeInTheDocument();
	});

	it("shows the plain box when the profile cannot be read", async () => {
		getMobileProfile.mockResolvedValueOnce(answer({ success: false, isMobile: false, error: "no project" }));
		render(<Box projectId="p1" />);
		await waitFor(() => expect(screen.getByTestId("profile-state")).toHaveTextContent("none"));
		cleanup();

		getMobileProfile.mockResolvedValueOnce(answer(undefined, false));
		render(<Box projectId="p1" />);
		await waitFor(() => expect(screen.getByTestId("profile-state")).toHaveTextContent("none"));
		cleanup();

		getMobileProfile.mockRejectedValueOnce(new Error("ipc closed"));
		render(<Box projectId="p1" />);
		await waitFor(() => expect(screen.getByTestId("profile-state")).toHaveTextContent("none"));
		expect(screen.getByText(/Which platforms this task targets/)).toBeInTheDocument();
		expect(getMobileProfile).toHaveBeenCalledTimes(3);
	});

	it("reads nothing without a project, or without the call", async () => {
		render(<Box />);
		expect(screen.getByTestId("profile-state")).toHaveTextContent("none");
		cleanup();

		(window as unknown as { electronAPI: unknown }).electronAPI = {};
		render(<Box projectId="p1" />);
		await waitFor(() => expect(screen.getByTestId("profile-state")).toHaveTextContent("none"));
		cleanup();

		(window as unknown as { electronAPI: unknown }).electronAPI = undefined;
		render(<Box projectId="p1" />);
		await waitFor(() => expect(screen.getByTestId("profile-state")).toHaveTextContent("none"));
		expect(getMobileProfile).not.toHaveBeenCalled();
	});

	it("drops the answer for a project the form has left", async () => {
		let first!: (value: unknown) => void;
		let failFirst!: (reason: unknown) => void;
		getMobileProfile
			.mockImplementationOnce(() => new Promise((resolve) => (first = resolve)))
			.mockResolvedValueOnce(answer({ success: true, isMobile: true, stack: { framework: "flutter", platforms: ["android"] } }));
		const { rerender } = render(<Box projectId="p1" />);
		rerender(<Box projectId="p2" />);
		expect(await screen.findByText(/^App detected: /)).toBeInTheDocument();
		await act(async () => first(answer(NO_APP)));
		expect(screen.queryByText("This project has no mobile app yet")).not.toBeInTheDocument();

		getMobileProfile.mockImplementationOnce(() => new Promise((_, reject) => (failFirst = reject)));
		rerender(<Box projectId="p3" />);
		rerender(<Box projectId="p2" />);
		await act(async () => failFirst(new Error("late")));
		expect(screen.getByTestId("profile-state")).toHaveTextContent("read");
	});
});
