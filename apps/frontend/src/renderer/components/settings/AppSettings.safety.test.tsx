import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../../shared/i18n";
import { AppSettingsDialog } from "./AppSettings";

/** Settings opens the Sandbox and Anomaly detection pages on the saved settings. */

function noop() {
	// The dialog stays open whatever happens.
}

describe("AppSettings, agent safety pages", () => {
	it("opens the Sandbox page", async () => {
		render(<AppSettingsDialog open onOpenChange={noop} initialSection="sandbox" />);
		expect(await screen.findByLabelText("Snapshot before each session")).toBeInTheDocument();
	});

	it("opens the Anomaly detection page", async () => {
		render(<AppSettingsDialog open onOpenChange={noop} initialSection="anomaly-detection" />);
		expect(await screen.findByLabelText("Enable anomaly detection")).toBeInTheDocument();
	});
});
