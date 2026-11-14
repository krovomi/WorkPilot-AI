/** @vitest-environment jsdom */
/**
 * REA in the « Outils CLI » panel: the pinned release or nothing. Another
 * installed version is offered the pinned one, never an `@latest` update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { REA_PIN } from "../../shared/types/rea";
import { TooltipProvider } from "./ui/tooltip";

// Keys come back as-is so the assertions do not depend on translations.
vi.mock("react-i18next", () => ({
	useTranslation: vi.fn(() => ({ t: (key: string) => key })),
}));

import { ReaStatusBadge } from "./ReaStatusBadge";

const checkRea = vi.fn();
const installRea = vi.fn();
const pinned = REA_PIN.version;

function renderBadge(onPresenceChange = vi.fn()) {
	render(
		<TooltipProvider>
			<ReaStatusBadge onPresenceChange={onPresenceChange} />
		</TooltipProvider>,
	);
	return onPresenceChange;
}

beforeEach(() => {
	checkRea.mockReset();
	installRea.mockReset();
	(globalThis as { electronAPI?: unknown }).electronAPI = { checkRea, installRea };
});
afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("ReaStatusBadge", () => {
	it("shows the pinned release when it is installed, with nothing to install", async () => {
		checkRea.mockResolvedValue({ state: "ready", pinned, installedVersion: pinned });
		const presence = renderBadge();
		expect(await screen.findByText(`REA (${pinned})`)).toBeInTheDocument();
		expect(screen.queryByText("common:install")).not.toBeInTheDocument();
		await waitFor(() => expect(presence).toHaveBeenLastCalledWith("installed"));
	});

	it("installs the pinned release when rea is absent", async () => {
		checkRea.mockResolvedValue({ state: "absent", pinned });
		installRea.mockResolvedValue({ success: true, status: { state: "ready", pinned } });
		const presence = renderBadge();
		await screen.findByText("common:install");
		await waitFor(() => expect(presence).toHaveBeenLastCalledWith("missing"));
		fireEvent.click(screen.getByRole("button", { name: /REA/ }));
		expect(screen.getByText(`npm install -g --ignore-scripts rea-agents@${pinned}`)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "navigation:rea.installButton" }));
		await waitFor(() => expect(installRea).toHaveBeenCalledWith());
		expect(await screen.findByText(`REA (${pinned})`)).toBeInTheDocument();
	});

	it("offers the pinned release in place of another version", async () => {
		checkRea.mockResolvedValue({ state: "other_version", pinned, installedVersion: "7.0.0" });
		const presence = renderBadge();
		await screen.findByText("common:install");
		await waitFor(() => expect(presence).toHaveBeenLastCalledWith("installed"));
		fireEvent.click(screen.getByRole("button", { name: /REA/ }));
		expect(screen.getByText("navigation:rea.otherVersion")).toBeInTheDocument();
	});

	it("offers no install without a Node.js the release accepts", async () => {
		checkRea.mockResolvedValue({ state: "node_too_old", pinned, nodeVersion: "20.0.0" });
		renderBadge();
		fireEvent.click(await screen.findByRole("button", { name: /REA/ }));
		expect(await screen.findByText("navigation:rea.nodeTooOld")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "navigation:rea.installButton" })).toBeNull();
	});

	it("shows why an install failed, with npm's output", async () => {
		checkRea.mockResolvedValue({ state: "absent", pinned });
		installRea.mockResolvedValue({ success: false, error: "failed", detail: "network down" });
		renderBadge();
		await screen.findByText("common:install");
		fireEvent.click(screen.getByRole("button", { name: /REA/ }));
		fireEvent.click(screen.getByRole("button", { name: "navigation:rea.installButton" }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("navigation:rea.error.failed");
		expect(alert).toHaveTextContent("network down");
	});

	it("reads as absent when the check throws", async () => {
		checkRea.mockRejectedValue(new Error("ipc down"));
		const presence = renderBadge();
		await waitFor(() => expect(presence).toHaveBeenLastCalledWith("missing"));
	});
});
