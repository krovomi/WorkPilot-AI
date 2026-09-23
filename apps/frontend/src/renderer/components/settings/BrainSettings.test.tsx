/**
 * The brain in Settings: plug a folder (an Obsidian vault) and/or a git
 * remote, and see what is plugged in.
 */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";

const mockFetchSettings = vi.fn();
const mockSaveSettings = vi.fn();

vi.mock("../../lib/agent-tools-api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/agent-tools-api")>()),
	fetchBrainSettings: (...args: unknown[]) => mockFetchSettings(...args),
	saveBrainSettings: (...args: unknown[]) => mockSaveSettings(...args),
}));

import { useBrainStore } from "../../stores/brain-store";
import { BrainSettings } from "./BrainSettings";

const base = {
	path: "/home/me/.workpilot/brain",
	defaultPath: "/home/me/.workpilot/brain",
	source: "default",
	envVariable: "WORKPILOT_BRAIN_DIR",
	configPath: "/home/me/.workpilot/brain.json",
	enabled: true,
	active: false,
	exists: false,
	folderExists: false,
	git: false,
	gitAvailable: true,
	remote: null,
	obsidianVault: false,
	notes: 0,
	proposals: 0,
};

beforeEach(async () => {
	await i18n.changeLanguage("en");
	mockFetchSettings.mockReset();
	mockSaveSettings.mockReset();
	useBrainStore.setState({
		settings: null,
		unavailable: false,
		error: null,
		saving: false,
		lastSync: null,
	});
	Object.assign(window.electronAPI, {
		selectDirectory: vi.fn().mockResolvedValue("/home/me/Documents/Vault"),
	});
});
afterEach(cleanup);

it("plugs an Obsidian vault and a GitHub repository", async () => {
	mockFetchSettings.mockResolvedValue({ ok: true, data: { settings: base } });
	mockSaveSettings.mockResolvedValue({
		ok: true,
		data: {
			settings: {
				...base,
				path: "/home/me/Documents/Vault",
				source: "config",
				active: true,
				exists: true,
				git: true,
				obsidianVault: true,
				remote: "https://github.com/me/brain.git",
				notes: 12,
			},
		},
	});
	render(<BrainSettings />);

	fireEvent.click(await screen.findByRole("button", { name: /Browse/ }));
	await waitFor(() =>
		expect(screen.getByLabelText("Brain folder (Obsidian vault)")).toHaveValue(
			"/home/me/Documents/Vault",
		),
	);
	fireEvent.change(screen.getByLabelText("Remote git repository (GitHub…)"), {
		target: { value: "me/brain" },
	});
	fireEvent.click(screen.getByRole("button", { name: /Save and connect/ }));

	await waitFor(() =>
		expect(mockSaveSettings).toHaveBeenCalledWith(
			{ path: "/home/me/Documents/Vault", remote: "me/brain", connect: true },
		),
	);
	expect(await screen.findByText("Obsidian vault detected")).toBeInTheDocument();
	expect(screen.getByText("Plugged in: 12 notes")).toBeInTheDocument();
	expect(screen.getByText("Remote: https://github.com/me/brain.git")).toBeInTheDocument();
});

it("shows the backend's refusal", async () => {
	mockFetchSettings.mockResolvedValue({ ok: true, data: { settings: base } });
	mockSaveSettings.mockResolvedValue({
		ok: false,
		error: "outside-home",
	});
	render(<BrainSettings />);
	fireEvent.change(await screen.findByLabelText("Brain folder (Obsidian vault)"), {
		target: { value: "/etc" },
	});
	fireEvent.click(screen.getByRole("button", { name: /Save and connect/ }));
	expect(await screen.findByRole("alert")).toHaveTextContent(/inside your home folder/);
});

it("does not pretend to choose the folder when the environment does", async () => {
	mockFetchSettings.mockResolvedValue({
		ok: true,
		data: { settings: { ...base, source: "env", path: "/srv/brain", exists: true } },
	});
	render(<BrainSettings />);
	expect(await screen.findByLabelText("Brain folder (Obsidian vault)")).toBeDisabled();
	expect(screen.getByText(/WORKPILOT_BRAIN_DIR environment variable/)).toBeInTheDocument();
});
