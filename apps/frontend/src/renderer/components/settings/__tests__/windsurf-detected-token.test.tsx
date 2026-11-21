/**
 * Detecting the Windsurf key of the local IDE: the dialog learns that a key
 * was found and for which account, shows the mask, and asks the main process
 * to save the key. The key never reaches the renderer, and the settings saved
 * from here carry the mask, which the main process reads as "keep the key".
 */
import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MASKED_SECRET } from "../../../../shared/constants";
import i18n from "../../../../shared/i18n";
import { ProviderConfigDialog } from "../ProviderConfigDialog";

vi.mock("../AuthTerminal", () => ({ AuthTerminal: () => null }));
vi.mock("../../ui/dialog", () => {
	const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
	return {
		Dialog: Part,
		DialogContent: Part,
		DialogTitle: Part,
		DialogDescription: Part,
		DialogHeader: Part,
		DialogFooter: Part,
	};
});

const FAKE_KEY = "sk-ws-FAKE-TEST-0000";
const api = globalThis.electronAPI as unknown as Record<string, unknown>;
const detectWindsurfToken = vi.fn();
const saveDetectedWindsurfToken = vi.fn();
const onSettingsChange = vi.fn();
const onProviderActivated = vi.fn();
const onOpenChange = vi.fn();

const settings = { language: "en", globalWindsurfApiKey: "" };

function renderDialog() {
	render(
		<ProviderConfigDialog
			isOpen
			useSheet
			provider={{ id: "windsurf", name: "Windsurf", isConfigured: false }}
			settings={settings}
			onOpenChange={onOpenChange}
			onSettingsChange={onSettingsChange}
			onProviderActivated={onProviderActivated}
		/>,
	);
	fireEvent.mouseDown(screen.getByRole("tab", { name: /SSO/ }), {
		button: 0,
	});
}

async function detect() {
	await act(async () => {
		fireEvent.click(
			screen.getByRole("button", { name: "Detect from Windsurf IDE" }),
		);
	});
}

async function save() {
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Save & Connect" }));
	});
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	vi.clearAllMocks();
	detectWindsurfToken.mockResolvedValue({
		success: true,
		userName: "Fake User",
		planName: "Pro",
	});
	saveDetectedWindsurfToken.mockResolvedValue({ success: true });
	api.detectWindsurfToken = detectWindsurfToken;
	api.saveDetectedWindsurfToken = saveDetectedWindsurfToken;
});

describe("Windsurf token detected from the local IDE", () => {
	it("shows the mask and the account, never a key", async () => {
		renderDialog();
		await detect();

		expect(screen.getByText("Windsurf token received")).toBeTruthy();
		expect(screen.getByText(MASKED_SECRET)).toBeTruthy();
		expect(screen.getByText("Token detected for Fake User")).toBeTruthy();
		expect(screen.getByText("Pro")).toBeTruthy();
		expect(document.body.textContent).not.toContain(FAKE_KEY);
	});

	it("has the main process save the key, the settings keep the mask", async () => {
		renderDialog();
		await detect();
		await save();

		expect(saveDetectedWindsurfToken).toHaveBeenCalledWith();
		expect(onSettingsChange).toHaveBeenCalledWith({
			...settings,
			globalWindsurfApiKey: MASKED_SECRET,
			globalWindsurfApiKeyEnabled: true,
		});
		expect(onProviderActivated).toHaveBeenCalledWith("windsurf");
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it.each([
		["refuses", () => saveDetectedWindsurfToken.mockResolvedValue({ success: false })],
		["fails", () => saveDetectedWindsurfToken.mockRejectedValue(new Error("ipc"))],
	])("says so and changes nothing when the main process %s", async (_, setUp) => {
		setUp();
		renderDialog();
		await detect();
		await save();

		expect(
			screen.getByText(
				"Could not save the detected Windsurf token. Detect it again, or paste a key in the API Key tab.",
			),
		).toBeTruthy();
		expect(onSettingsChange).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("keeps the form empty when no key is installed", async () => {
		detectWindsurfToken.mockResolvedValue({
			success: false,
			error: "Windsurf IDE not found",
		});
		renderDialog();
		await detect();

		expect(screen.getByText("Windsurf IDE not found")).toBeTruthy();
		expect(screen.queryByText("Windsurf token received")).toBeNull();
	});
});
