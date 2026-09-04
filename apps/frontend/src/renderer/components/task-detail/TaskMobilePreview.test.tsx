/**
 * @vitest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import type { MobilePlan } from "../../../shared/types/mobile";
import type { Project } from "../../../shared/types";
import { useMobileStore } from "../../stores/mobile-store";
import { TaskMobilePreview } from "./TaskMobilePreview";

const project: Project = {
	id: "project-1",
	name: "Demo app",
	path: "/repos/demo",
	autoBuildPath: ".workpilot",
	settings: {
		model: "claude",
		memoryBackend: "file",
		linearSync: false,
		notifications: {
			onTaskComplete: false,
			onTaskFailed: false,
			onReviewNeeded: false,
			sound: false,
		},
		graphitiMcpEnabled: false,
	},
	createdAt: new Date("2026-06-05T08:00:00.000Z"),
	updatedAt: new Date("2026-06-05T08:00:00.000Z"),
};

const noopUnsubscribe = () => {
	/* noop */
};

const mockDetect = vi.fn();
const mockGetWorktreeStatus = vi.fn();

Object.defineProperty(window, "electronAPI", {
	value: {
		getWorktreeStatus: mockGetWorktreeStatus,
		detectMobileProject: mockDetect,
		launchMobileApp: vi.fn(),
		captureMobileScreenshot: vi.fn(),
		stopMobileSession: vi.fn(),
		getMobileStatus: vi.fn(),
		onMobilePlan: vi.fn(() => noopUnsubscribe),
		onMobilePhase: vi.fn(() => noopUnsubscribe),
		onMobileStatus: vi.fn(() => noopUnsubscribe),
		onMobileOutput: vi.fn(() => noopUnsubscribe),
		onMobileScreenshot: vi.fn(() => noopUnsubscribe),
		onMobileError: vi.fn(() => noopUnsubscribe),
		onMobileStopped: vi.fn(() => noopUnsubscribe),
	},
	writable: true,
});

function flutterPlan(overrides: Partial<MobilePlan> = {}): MobilePlan {
	return {
		success: true,
		isMobile: true,
		stack: {
			framework: "flutter",
			platforms: ["android", "ios"],
			projectDir: "/repos/demo",
			packageId: "com.acme.demo",
			evidence: ["pubspec.yaml"],
			notes: "",
			isCrossPlatform: true,
			commands: {
				android: {
					run: "flutter run -d android",
					build: "flutter build apk --debug",
					test: "flutter test",
					lint: "flutter analyze",
					artifact: "",
					notes: "",
				},
			},
		},
		platforms: {
			android: { platform: "android", ok: true, blocker: "", checks: [] },
			ios: {
				platform: "ios",
				ok: false,
				blocker: "iOS cannot be built on this machine: Apple's toolchain is macOS-only",
				checks: [
					{
						tool: "xcodebuild",
						ok: false,
						detail: "this machine is not macOS",
						remedy: "iOS builds require macOS with Xcode. Use a Mac runner.",
						required: true,
					},
				],
			},
		},
		devices: [
			{
				id: "emulator-5554",
				name: "Pixel 8",
				platform: "android",
				kind: "emulator",
				state: "device",
				runtime: "",
				isBooted: true,
			},
		],
		unavailable: {
			ios: "xcrun not found. iOS simulators exist only on macOS with Xcode installed.",
		},
		...overrides,
	};
}

describe("TaskMobilePreview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useMobileStore.getState().reset();
		mockGetWorktreeStatus.mockResolvedValue({ success: true, data: {} });
		mockDetect.mockImplementation(async () => {
			useMobileStore.getState().setPlan(flutterPlan());
			return { success: true, data: flutterPlan() };
		});
	});

	it("detects the project on mount and lists its platforms", async () => {
		render(<TaskMobilePreview taskId="task-1" project={project} />);
		await waitFor(() => expect(mockDetect).toHaveBeenCalledWith("/repos/demo"));
		expect(await screen.findByText("flutter")).toBeInTheDocument();
		expect(screen.getByText("com.acme.demo")).toBeInTheDocument();
	});

	it("offers the booted device by name", async () => {
		render(<TaskMobilePreview taskId="task-1" project={project} />);
		expect(await screen.findByRole("option", { name: /Pixel 8/ })).toBeInTheDocument();
	});

	it("says a platform cannot be built here rather than offering a Run that fails", async () => {
		render(<TaskMobilePreview taskId="task-1" project={project} />);
		await screen.findByText("flutter");
		useMobileStore.getState().selectPlatform("ios");
		// The blocker is a fact about the machine, not a defect to retry, so it is
		// stated up front — with the remedy that actually exists.
		expect(
			await screen.findByText(/Apple's toolchain is macOS-only/),
		).toBeInTheDocument();
		expect(screen.getByText(/Use a Mac runner/)).toBeInTheDocument();
	});

	it("cannot start a run on a platform this machine cannot build", async () => {
		render(<TaskMobilePreview taskId="task-1" project={project} />);
		await screen.findByText("flutter");
		useMobileStore.getState().selectPlatform("ios");
		const run = await screen.findByRole("button", { name: /Lancer|Run/i });
		await waitFor(() => expect(run).toBeDisabled());
	});

	it("explains an empty device list instead of showing nothing", async () => {
		mockDetect.mockImplementation(async () => {
			const plan = flutterPlan({ devices: [] });
			useMobileStore.getState().setPlan(plan);
			return { success: true, data: plan };
		});
		render(<TaskMobilePreview taskId="task-1" project={project} />);
		await screen.findByText("flutter");
		useMobileStore.getState().selectPlatform("ios");
		expect(await screen.findByText(/xcrun not found/)).toBeInTheDocument();
	});

	it("says so when the project is not a mobile one", async () => {
		const plan: MobilePlan = {
			success: true,
			isMobile: false,
			reason: "No Android or Apple project was found under this directory.",
		};
		mockDetect.mockImplementation(async () => {
			useMobileStore.getState().setPlan(plan);
			return { success: true, data: plan };
		});
		render(<TaskMobilePreview taskId="task-1" project={project} />);
		expect(
			await screen.findByText(/No Android or Apple project was found/),
		).toBeInTheDocument();
	});

	it("does not try to detect anything without a project directory", () => {
		render(<TaskMobilePreview taskId="task-1" />);
		expect(mockDetect).not.toHaveBeenCalled();
	});
});
