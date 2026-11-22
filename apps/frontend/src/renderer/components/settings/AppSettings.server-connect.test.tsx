import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import { useServerSessionStore } from "../../stores/server-session-store";
import { AppSettingsDialog } from "./AppSettings";

/**
 * A person who chose "Mode local" at first launch can still sign in to a team
 * server. Before, the gate never reopened for a configured local install and
 * the session page only existed once signed in: no way back to a server.
 */

afterEach(() => {
	cleanup();
	useServerSessionStore.setState({ mode: "local", isLoginScreenOpen: false });
});

describe("AppSettings, team server", () => {
	it("offers the sign-in in local mode, and opens it over a closed Settings", () => {
		useServerSessionStore.setState({ mode: "local", isLoginScreenOpen: false });
		const onOpenChange = vi.fn();
		render(<AppSettingsDialog open onOpenChange={onOpenChange} initialSection="server-session" />);
		expect(screen.getByText("Sign in to a team server")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Sign in to a server" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(useServerSessionStore.getState().isLoginScreenOpen).toBe(true);
	});

	it("shows the session itself once signed in to a server", async () => {
		const getSession = vi.fn().mockResolvedValue({ success: false, error: "offline" });
		Object.assign(window, {
			electronAPI: { ...window.electronAPI, serverAuth: { ...window.electronAPI?.serverAuth, getSession } },
		});
		useServerSessionStore.setState({ mode: "server" });
		render(<AppSettingsDialog open onOpenChange={vi.fn()} initialSection="server-session" />);
		expect(await screen.findByText("offline")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Sign in to a server" })).not.toBeInTheDocument();
	});
});
