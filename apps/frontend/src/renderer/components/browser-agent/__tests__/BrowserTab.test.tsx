/** @vitest-environment jsdom */
/**
 * A screenshot name typed in the capture bar reaches the main process in the
 * charset it accepts.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { useBrowserAgentStore } from "../../../stores/browser-agent-store";
import { BrowserTab } from "../BrowserTab";

const capture = vi.fn();

beforeEach(async () => {
	await i18n.changeLanguage("en");
	capture.mockReset();
	useBrowserAgentStore.setState({
		currentUrl: "http://localhost:3000",
		isCapturing: false,
		captureScreenshot: capture,
	});
});

afterEach(cleanup);

function captureAs(typed: string) {
	render(<BrowserTab projectPath="/projects/demo" />);
	fireEvent.click(screen.getByRole("button", { name: i18n.t("browserAgent:browser.captureScreenshot") }));
	fireEvent.change(screen.getByLabelText(i18n.t("browserAgent:browser.screenshotNamePlaceholder")), {
		target: { value: typed },
	});
	fireEvent.keyDown(screen.getByLabelText(i18n.t("browserAgent:browser.screenshotNamePlaceholder")), {
		key: "Enter",
	});
}

describe("BrowserTab capture name", () => {
	it("sends a typed name reduced to letters, digits, '.', '_' and '-'", () => {
		captureAs("  login page / v2 ");
		expect(capture).toHaveBeenCalledWith("/projects/demo", "login_page___v2", "http://localhost:3000");
	});

	it("names the capture itself when nothing usable was typed", () => {
		captureAs(" -- ");
		expect(capture).toHaveBeenCalledWith(
			"/projects/demo",
			expect.stringMatching(/^capture_\d+$/),
			"http://localhost:3000",
		);
	});
});
