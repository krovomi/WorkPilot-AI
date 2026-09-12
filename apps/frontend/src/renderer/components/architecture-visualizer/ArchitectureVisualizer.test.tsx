/**
 * @vitest-environment jsdom
 */
/**
 * Tests the Architecture page, and above all that it subscribes.
 *
 * The original defect was not a wrong subscription, it was no subscription:
 * `setupArchitectureVisualizerListeners` existed and was called by nothing, so
 * the renderer never received a status, a result or an error and the UI sat on
 * its spinner for ever. Nothing in the suite could have caught that, because
 * there was no suite. The first test here is that one.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";

import { useArchitectureVisualizerStore } from "../../stores/architecture-visualizer-store";
import { useProjectStore } from "../../stores/project-store";
import { ArchitectureVisualizer } from "./ArchitectureVisualizer";

const unsubscribes = {
	status: vi.fn(),
	chunk: vi.fn(),
	error: vi.fn(),
	complete: vi.fn(),
};

function stubApi(overrides: Record<string, unknown> = {}) {
	const api = {
		onArchitectureVisualizerStatus: vi.fn(() => unsubscribes.status),
		onArchitectureVisualizerStreamChunk: vi.fn(() => unsubscribes.chunk),
		onArchitectureVisualizerError: vi.fn(() => unsubscribes.error),
		onArchitectureVisualizerComplete: vi.fn(() => unsubscribes.complete),
		checkArchifyReadiness: vi.fn(async () => ({
			success: true,
			data: {
				status: "success",
				action: "doctor",
				readiness: {
					ok: true,
					node: "/usr/bin/node",
					archifyRoot: "/vendor/archify",
					conditions: [],
				},
				baseline: null,
			},
		})),
		resolveArchitectureArtifact: vi.fn(async () => ({
			success: true,
			data: { url: "file:///baseline.html" },
		})),
		generateArchitectureMap: vi.fn(async () => ({ success: true })),
		cancelArchitectureVisualization: vi.fn(async () => ({ success: true })),
		...overrides,
	};
	Object.defineProperty(window, "electronAPI", {
		value: api,
		writable: true,
		configurable: true,
	});
	return api;
}

beforeEach(() => {
	vi.clearAllMocks();
	useArchitectureVisualizerStore.getState().reset();
	useProjectStore.setState({
		projects: [{ id: "p1", name: "P", path: "/p" }],
		activeProjectId: "p1",
	} as never);
});

describe("ArchitectureVisualizer", () => {
	it("subscribes on mount and unsubscribes on unmount", async () => {
		const api = stubApi();
		const { unmount } = render(<ArchitectureVisualizer />);

		expect(api.onArchitectureVisualizerStatus).toHaveBeenCalledTimes(1);
		expect(api.onArchitectureVisualizerStreamChunk).toHaveBeenCalledTimes(1);
		expect(api.onArchitectureVisualizerError).toHaveBeenCalledTimes(1);
		expect(api.onArchitectureVisualizerComplete).toHaveBeenCalledTimes(1);

		unmount();
		expect(unsubscribes.status).toHaveBeenCalledTimes(1);
		expect(unsubscribes.complete).toHaveBeenCalledTimes(1);
	});

	it("reads what is already on disk rather than starting empty", async () => {
		// The page used to clear its result on close and never read the files
		// back, so a model generated minutes earlier was invisible.
		const api = stubApi({
			checkArchifyReadiness: vi.fn(async () => ({
				success: true,
				data: {
					status: "success",
					action: "doctor",
					readiness: { ok: true, node: "n", archifyRoot: "r", conditions: [] },
					baseline: {
						path: "/p/.workpilot/architecture/baseline.arch.json",
						artifact: "/p/.workpilot/architecture/baseline.html",
						components: 9,
						connections: 12,
						revision: "0123456789abcdef0123456789abcdef01234567",
					},
				},
			})),
		});

		const { container } = render(<ArchitectureVisualizer />);

		await waitFor(() =>
			expect(api.resolveArchitectureArtifact).toHaveBeenCalledWith(
				"/p/.workpilot/architecture/baseline.html",
			),
		);
		await waitFor(() =>
			expect(container.querySelector("webview")).not.toBeNull(),
		);
		expect(container.textContent).toMatch(/9 components/);
		expect(container.textContent).toMatch(/12 connections/);
		expect(container.textContent).toMatch(/0123456789ab/);
	});

	it("offers to generate when there is no model yet", async () => {
		stubApi();
		render(<ArchitectureVisualizer />);
		await waitFor(() =>
			expect(screen.getByText(/No architecture map yet/i)).toBeInTheDocument(),
		);
		expect(screen.getByRole("button", { name: /Generate map/i })).toBeEnabled();
	});

	it("states the blockers and refuses to run when archify cannot", async () => {
		// The failure this prevents is the silent one: a spinner, then nothing,
		// and a user concluding the feature is broken rather than that Node is
		// missing.
		stubApi({
			checkArchifyReadiness: vi.fn(async () => ({
				success: true,
				data: {
					status: "success",
					action: "doctor",
					readiness: {
						ok: false,
						node: null,
						archifyRoot: null,
						conditions: [
							{
								name: "node",
								ok: false,
								detail: "Node.js is not on PATH",
								remedy: "install Node.js 18+ and reopen the app",
								blocking: true,
							},
						],
					},
					baseline: null,
				},
			})),
		});

		render(<ArchitectureVisualizer />);
		await waitFor(() =>
			expect(screen.getByText(/install Node\.js 18\+/)).toBeInTheDocument(),
		);
		expect(screen.getByRole("button", { name: /Generate map/i })).toBeDisabled();
	});
});
