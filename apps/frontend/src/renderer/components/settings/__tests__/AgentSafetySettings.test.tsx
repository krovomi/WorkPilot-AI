/** Settings, Sandbox and Anomaly detection: every control saves a normalized `agentSafety`. */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@shared/types";
import { DEFAULT_AGENT_SAFETY } from "../../../../shared/utils/agent-safety";
import { AnomalyDetectionSettings } from "../AnomalyDetectionSettings";
import { SandboxSettings } from "../SandboxSettings";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const K = "sections.sandbox";
const base = { theme: "system" } as unknown as AppSettings;
const saved = (change: ReturnType<typeof vi.fn>) => change.mock.calls.at(-1)?.[0].agentSafety;

describe("SandboxSettings", () => {
	it("shows the defaults when nothing is saved", () => {
		render(<SandboxSettings settings={base} onSettingsChange={vi.fn()} />);
		expect(screen.getByLabelText(`${K}.snapshots.enable`)).toBeChecked();
		expect(screen.getByLabelText(`${K}.limits.maxSession`)).toHaveValue("0");
		expect(screen.getByText(`${K}.limits.none`)).toBeInTheDocument();
		expect(screen.getByText("200")).toBeInTheDocument();
	});

	it("saves the switches, the mode and the limits", () => {
		const change = vi.fn();
		render(<SandboxSettings settings={base} onSettingsChange={change} />);
		fireEvent.click(screen.getByLabelText(`${K}.snapshots.autoRollback`));
		expect(saved(change).snapshots.autoRollback).toBe(false);
		expect(change.mock.calls[0][0].theme).toBe("system");
		fireEvent.click(screen.getByText(`${K}.mode.restricted.label`));
		expect(saved(change).sandbox.mode).toBe("restricted");
		fireEvent.change(screen.getByLabelText(`${K}.limits.maxFileSize`), { target: { value: "25" } });
		expect(saved(change).sandbox.maxFileSizeMb).toBe(25);
		fireEvent.change(screen.getByLabelText(`${K}.snapshots.keep`), { target: { value: "3" } });
		expect(saved(change).snapshots.keep).toBe(3);
		fireEvent.click(screen.getByLabelText(`${K}.snapshots.enable`));
		expect(saved(change).snapshots.enabled).toBe(false);
		fireEvent.change(screen.getByLabelText(`${K}.limits.maxFiles`), { target: { value: "50" } });
		expect(saved(change).sandbox.maxFilesWritten).toBe(50);
		fireEvent.change(screen.getByLabelText(`${K}.limits.maxSession`), { target: { value: "30" } });
		expect(saved(change).sandbox.maxSessionMinutes).toBe(30);
	});

	it("adds a valid path, refuses one outside the project, removes one", () => {
		const change = vi.fn();
		const settings = {
			...base,
			agentSafety: { ...DEFAULT_AGENT_SAFETY, sandbox: { ...DEFAULT_AGENT_SAFETY.sandbox, mode: "restricted" } },
		} as AppSettings;
		const view = render(<SandboxSettings settings={settings} onSettingsChange={change} />);
		expect(screen.getByText(`${K}.paths.emptyRestricted`)).toBeInTheDocument();
		const input = screen.getByLabelText(`${K}.paths.placeholder`);
		fireEvent.change(input, { target: { value: "../outside" } });
		expect(screen.getByText(`${K}.paths.invalid`)).toBeInTheDocument();
		fireEvent.keyDown(input, { key: "Enter" });
		expect(change).not.toHaveBeenCalled();
		expect(screen.getByText(`${K}.paths.add`).closest("button")).toBeDisabled();
		fireEvent.change(input, { target: { value: "src\\app" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(saved(change).sandbox.allowedPaths).toEqual(["src/app"]);

		view.rerender(<SandboxSettings settings={change.mock.calls.at(-1)?.[0]} onSettingsChange={change} />);
		expect(screen.getByText("src/app")).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText(`${K}.paths.remove`));
		expect(saved(change).sandbox.allowedPaths).toEqual([]);
	});
});

describe("AnomalyDetectionSettings", () => {
	const A = "sections.anomaly-detection";

	it("saves the switch and keeps stop at or below pause", () => {
		const change = vi.fn();
		render(<AnomalyDetectionSettings settings={base} onSettingsChange={change} />);
		fireEvent.click(screen.getByLabelText(`${A}.enable.title`));
		expect(saved(change).anomaly.enabled).toBe(false);
		fireEvent.change(screen.getByLabelText(`${A}.trustScore.pauseThreshold`), { target: { value: "15" } });
		expect(saved(change).anomaly).toMatchObject({ pauseBelow: 15, stopBelow: 15 });
		fireEvent.change(screen.getByLabelText(`${A}.detectionLimits.massDeletionCount`), {
			target: { value: "9" },
		});
		expect(saved(change).anomaly.massDeletionCount).toBe(9);
		fireEvent.change(screen.getByLabelText(`${A}.trustScore.stopThreshold`), { target: { value: "10" } });
		expect(saved(change).anomaly.stopBelow).toBe(10);
		fireEvent.change(screen.getByLabelText(`${A}.detectionLimits.maxRepetitiveErrors`), {
			target: { value: "7" },
		});
		expect(saved(change).anomaly.maxErrorCount).toBe(7);
		fireEvent.change(screen.getByLabelText(`${A}.detectionLimits.rapidChangeWindow`), {
			target: { value: "20" },
		});
		expect(saved(change).anomaly.rapidChangeWindowS).toBe(20);
	});

	it("lists what lowers the score", () => {
		render(<AnomalyDetectionSettings settings={base} onSettingsChange={vi.fn()} />);
		expect(screen.getByText("tasks:safetyPause.types.path_traversal_attempt")).toBeInTheDocument();
		expect(screen.getByText("-30")).toBeInTheDocument();
		expect(screen.getByText(".ssh/")).toBeInTheDocument();
	});
});
