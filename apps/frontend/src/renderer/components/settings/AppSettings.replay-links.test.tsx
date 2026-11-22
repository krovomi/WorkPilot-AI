import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import { useReplayUsageStore } from "../../stores/replay-usage-store";
import { useServerSessionStore } from "../../stores/server-session-store";
import { AppSettingsDialog } from "./AppSettings";

/** Settings lists the person's replay team links, in server mode only (#347). */

function noop() {
	// The dialog stays open whatever happens.
}

afterEach(() => {
	cleanup();
	useServerSessionStore.setState({ mode: "local" });
});

describe("AppSettings, replay links", () => {
	it("opens the page of the person's links on a server", async () => {
		const listMyReplayTeamShares = vi.fn().mockResolvedValue({ success: true, shares: [] });
		Object.assign(window, { electronAPI: { ...window.electronAPI, listMyReplayTeamShares } });
		useReplayUsageStore.setState({ mine: null, mineError: null });
		useServerSessionStore.setState({ mode: "server" });
		render(<AppSettingsDialog open onOpenChange={noop} initialSection="server-replay-links" />);
		expect(await screen.findByText("You have not made any team link yet.")).toBeInTheDocument();
		expect(listMyReplayTeamShares).toHaveBeenCalled();
	});

	it("shows nothing of it on the local app", () => {
		useServerSessionStore.setState({ mode: "local" });
		render(<AppSettingsDialog open onOpenChange={noop} initialSection="server-replay-links" />);
		expect(screen.queryByText("My replay team links")).not.toBeInTheDocument();
	});
});
