import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@shared/types";
import { useSettingsStore } from "../../../stores/settings-store";
import { SwarmModeSettings } from "../SwarmModeSettings";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const saveSettings = vi.fn();

function withSaved(swarm?: AppSettings["swarm"]) {
	useSettingsStore.setState({
		settings: { ...useSettingsStore.getState().settings, swarm },
	});
}

async function flip(name: string) {
	const label = screen.getByText(name);
	const row = label.closest("div.flex.items-center.justify-between");
	const toggle = row?.querySelector('[role="switch"]');
	if (!toggle) throw new Error(`no switch next to ${name}`);
	await act(async () => {
		fireEvent.click(toggle);
	});
}

describe("SwarmModeSettings", () => {
	beforeEach(() => {
		saveSettings.mockReset().mockResolvedValue({ success: true });
		Object.assign(window.electronAPI, { saveSettings });
		withSaved(undefined);
	});

	it("is off until the person turns it on, and the choice is saved", async () => {
		render(<SwarmModeSettings />);
		expect(screen.queryByText("swarm:config.failFast")).not.toBeInTheDocument();

		await flip("swarm:enable");

		expect(saveSettings).toHaveBeenCalledWith({
			swarm: {
				enabled: true,
				maxParallelAgents: 4,
				failFast: false,
				maxRetriesPerSubtask: 2,
			},
		});
		// The saved setting is what the panel shows from now on.
		expect(screen.getByText("swarm:config.failFast")).toBeInTheDocument();
		expect(screen.getByText("swarm:infoBanner")).toBeInTheDocument();
	});

	it("saves each option with the rest of the setting", async () => {
		withSaved({
			enabled: true,
			maxParallelAgents: 3,
			failFast: false,
			maxRetriesPerSubtask: 1,
		});
		render(<SwarmModeSettings />);

		await flip("swarm:config.failFast");
		expect(saveSettings).toHaveBeenLastCalledWith({
			swarm: {
				enabled: true,
				maxParallelAgents: 3,
				failFast: true,
				maxRetriesPerSubtask: 1,
			},
		});

		const [parallel, retries] = screen.getAllByRole("slider");
		await act(async () => {
			fireEvent.change(parallel, { target: { value: "6" } });
		});
		expect(saveSettings).toHaveBeenLastCalledWith({
			swarm: expect.objectContaining({ maxParallelAgents: 6, failFast: true }),
		});
		await act(async () => {
			fireEvent.change(retries, { target: { value: "0" } });
		});
		expect(saveSettings).toHaveBeenLastCalledWith({
			swarm: expect.objectContaining({ maxRetriesPerSubtask: 0 }),
		});
	});

	it("offers no option the build does not honour", () => {
		withSaved({
			enabled: true,
			maxParallelAgents: 4,
			failFast: false,
			maxRetriesPerSubtask: 2,
		});
		render(<SwarmModeSettings />);

		for (const gone of [
			"swarm:config.mergeAfterWave",
			"swarm:config.aiMerge",
			"swarm:config.dryRun",
		]) {
			expect(screen.queryByText(gone)).not.toBeInTheDocument();
		}
		expect(screen.getAllByRole("switch")).toHaveLength(2);
	});

	it("says so when the setting cannot be saved, and keeps the old one", async () => {
		saveSettings.mockResolvedValue({ success: false, error: "disk full" });
		render(<SwarmModeSettings />);

		await flip("swarm:enable");

		expect(screen.getByText("swarm:saveFailed")).toBeInTheDocument();
		expect(useSettingsStore.getState().settings.swarm).toBeUndefined();
		expect(screen.queryByText("swarm:config.failFast")).not.toBeInTheDocument();
	});
});
