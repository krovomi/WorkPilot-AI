/**
 * @vitest-environment jsdom
 */
/** A task the session watch paused says why, and lists its snapshots to restore one. */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";
import type { AnomalyPauseDetail, SandboxPauseDetail, Task } from "../../../shared/types";
import { countByType, safetyPause, TaskSafetyPause } from "./TaskSafetyPause";

function task(reason: string | undefined, extra: Record<string, unknown> = {}): Task {
	return {
		id: "t1",
		metadata: {
			paused: { enabled: true, paused_at: null, paused_subtask_id: null, reason, ...extra },
		},
	} as unknown as Task;
}

const anomaly = (patch: Partial<AnomalyPauseDetail> = {}): AnomalyPauseDetail =>
	({
		trustScore: 35.4,
		pauseBelow: 40,
		stopBelow: 20,
		stopped: false,
		anomalies: [
			{ type: "sensitive_file_access", severity: "high", description: "", timestamp: "" },
			{ type: "sensitive_file_access", severity: "high", description: "", timestamp: "" },
			{ type: "rapid_file_changes", severity: "medium", description: "", timestamp: "" },
		],
		...patch,
	}) as AnomalyPauseDetail;

const SNAP = {
	snapshot_id: "20261115T142000000000Z-coding",
	commit: "abc",
	head: "def",
	created_at: "2026-11-15T14:20:00Z",
	label: "coding",
};

const api = {
	listTaskSnapshots: vi.fn(),
	restoreTaskSnapshot: vi.fn(),
};

beforeEach(() => {
	api.listTaskSnapshots.mockResolvedValue({ success: true, data: [SNAP] });
	api.restoreTaskSnapshot.mockResolvedValue({ success: true, data: { restored: SNAP.snapshot_id, safety: "s" } });
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
});
afterEach(() => vi.clearAllMocks());

describe("safetyPause", () => {
	it("claims only a pause it can describe", () => {
		expect(safetyPause(task(undefined))).toBeNull();
		expect(safetyPause(task("anomaly"))).toBeNull();
		expect(safetyPause(task("anomaly", { anomaly: { trustScore: "x", anomalies: [] } }))).toBeNull();
		expect(safetyPause(task("sandbox", { sandbox: { kind: "docker" } }))).toBeNull();
		expect(safetyPause(task("tool_loop"))).toBeNull();
		expect(safetyPause({ id: "t", metadata: {} } as unknown as Task)).toBeNull();
		expect(safetyPause(task("anomaly", { anomaly: anomaly() }))?.reason).toBe("anomaly");
	});

	it("groups anomalies by type in order", () => {
		expect(countByType(anomaly().anomalies)).toEqual([
			["sensitive_file_access", 2],
			["rapid_file_changes", 1],
		]);
	});
});

describe("TaskSafetyPause", () => {
	it("shows nothing for another pause", () => {
		const { container } = render(<TaskSafetyPause task={task("budget")} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the trust score and what lowered it", async () => {
		render(<TaskSafetyPause task={task("anomaly", { anomaly: anomaly() })} />);
		fireEvent.click(screen.getByTestId("task-safety-pause"));
		expect(screen.getByText("Trust score: 35/100")).toBeInTheDocument();
		expect(await screen.findByText(/fell to 35\/100 \(pause at 40\)/)).toBeInTheDocument();
		expect(screen.getByText("Access to a secret or the git history (×2)")).toBeInTheDocument();
		expect(screen.getByText("Rapid file changes")).toBeInTheDocument();
	});

	it("says the session was stopped and its files restored", async () => {
		const detail = anomaly({ stopped: true, trustScore: 10, rolledBack: true, anomalies: [] });
		render(<TaskSafetyPause task={task("anomaly", { anomaly: detail })} />);
		fireEvent.click(screen.getByTestId("task-safety-pause"));
		expect(await screen.findByText(/at or below the stop threshold \(20\)/)).toBeInTheDocument();
		expect(screen.getByTestId("task-safety-rolled-back")).toBeInTheDocument();
	});

	it("names a sandbox limit and a failed restore", async () => {
		const detail: SandboxPauseDetail = {
			kind: "file_size",
			path: "big.bin",
			value: 2048,
			limit: 1024,
			rollback: true,
			rollbackError: "git failed",
		} as SandboxPauseDetail;
		render(<TaskSafetyPause task={task("sandbox", { sandbox: detail })} />);
		expect(screen.getByText("Sandbox: file too large")).toBeInTheDocument();
		fireEvent.click(screen.getByTestId("task-safety-pause"));
		expect(await screen.findByText(/wrote big\.bin \(2048 bytes\)/)).toBeInTheDocument();
		expect(screen.getByText(/Restoring the snapshot failed/)).toBeInTheDocument();
	});

	it("lists the snapshots and restores one after a confirmation", async () => {
		render(<TaskSafetyPause task={task("sandbox", { sandbox: { kind: "session_time", value: 9, limit: 5 } })} />);
		fireEvent.click(screen.getByTestId("task-safety-pause"));
		fireEvent.click(await screen.findByTestId("task-snapshots-open"));
		expect(await screen.findByText(/before coding/)).toBeInTheDocument();
		expect(api.listTaskSnapshots).toHaveBeenCalledWith("t1");
		fireEvent.click(screen.getByTestId("task-snapshot-restore"));
		expect(api.restoreTaskSnapshot).not.toHaveBeenCalled();
		fireEvent.click(screen.getByTestId("task-snapshot-confirm"));
		await waitFor(() => expect(api.restoreTaskSnapshot).toHaveBeenCalledWith("t1", SNAP.snapshot_id));
		expect(await screen.findByText("Snapshot restored.")).toBeInTheDocument();
	});

	it("says when there is none, an unknown label, and a refused restore", async () => {
		api.listTaskSnapshots.mockResolvedValueOnce({ success: true, data: [] });
		const view = render(
			<TaskSafetyPause task={task("sandbox", { sandbox: { kind: "files_written", value: 9, limit: 5 } })} />,
		);
		fireEvent.click(screen.getByTestId("task-safety-pause"));
		fireEvent.click(await screen.findByTestId("task-snapshots-open"));
		expect(await screen.findByText("No snapshot for this task yet.")).toBeInTheDocument();
		view.unmount();

		api.listTaskSnapshots.mockResolvedValueOnce({ success: true, data: [{ ...SNAP, label: "session" }] });
		api.restoreTaskSnapshot.mockResolvedValueOnce({ success: false, error: "Stop the task first" });
		render(<TaskSafetyPause task={task("sandbox", { sandbox: { kind: "restricted_path", path: "x" } })} />);
		fireEvent.click(screen.getByTestId("task-safety-pause"));
		fireEvent.click(await screen.findByTestId("task-snapshots-open"));
		expect(await screen.findByText(/session/)).toBeInTheDocument();
		fireEvent.click(screen.getByTestId("task-snapshot-restore"));
		fireEvent.click(screen.getByTestId("task-snapshot-confirm"));
		expect(await screen.findByText("Could not restore: Stop the task first")).toBeInTheDocument();
	});

	it("says when the list cannot be read", async () => {
		api.listTaskSnapshots.mockResolvedValueOnce({ success: false, error: "No Python" });
		render(<TaskSafetyPause task={task("sandbox", { sandbox: { kind: "restricted_path", path: "x" } })} />);
		fireEvent.click(screen.getByTestId("task-safety-pause"));
		fireEvent.click(await screen.findByTestId("task-snapshots-open"));
		expect(await screen.findByText("Could not read the snapshots: No Python")).toBeInTheDocument();
		expect(screen.getByTestId("task-snapshots-open")).toBeInTheDocument();
	});

	it("reads a reply without data or error as empty", async () => {
		api.listTaskSnapshots.mockResolvedValueOnce({ success: true });
		api.listTaskSnapshots.mockResolvedValueOnce({ success: false });
		const view = render(
			<TaskSafetyPause task={task("sandbox", { sandbox: { kind: "restricted_path", path: "x" } })} />,
		);
		fireEvent.click(screen.getByTestId("task-safety-pause"));
		fireEvent.click(await screen.findByTestId("task-snapshots-open"));
		expect(await screen.findByText("No snapshot for this task yet.")).toBeInTheDocument();
		view.unmount();

		render(<TaskSafetyPause task={task("sandbox", { sandbox: { kind: "restricted_path", path: "x" } })} />);
		fireEvent.click(screen.getByTestId("task-safety-pause"));
		fireEvent.click(await screen.findByTestId("task-snapshots-open"));
		expect(await screen.findByText("Could not read the snapshots:", { exact: false })).toBeInTheDocument();
		api.listTaskSnapshots.mockResolvedValueOnce({ success: true, data: [SNAP] });
		fireEvent.click(screen.getByTestId("task-snapshots-open"));
		api.restoreTaskSnapshot.mockResolvedValueOnce({ success: false });
		fireEvent.click(await screen.findByTestId("task-snapshot-restore"));
		fireEvent.click(screen.getByTestId("task-snapshot-confirm"));
		expect(await screen.findByText("Could not restore:", { exact: false })).toBeInTheDocument();
	});
});
