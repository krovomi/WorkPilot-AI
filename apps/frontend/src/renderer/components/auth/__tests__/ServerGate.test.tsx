/** @vitest-environment jsdom */
/**
 * The gate: the sign-in screen until a session is open, then the notice of
 * what is measured, once per organization while the server says it is due;
 * reading it is recorded by the server.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import { usePermissionsStore } from "@/stores/permissions-store";
import { useServerSessionStore } from "@/stores/server-session-store";

vi.mock("../ServerLoginScreen", () => ({ ServerLoginScreen: () => <div data-testid="login" /> }));

import { ServerGate } from "../ServerGate";

const NOTICE = {
	due: true,
	measured: ["tokens", "runs", "jobs", "sign_ins", "presence"],
	page_activity: false,
	usage_retention_days: 365,
	page_activity_retention_days: 183,
	visible_to: ["Administrator", "Owner"],
};
const serverUsage = { getUsageNotice: vi.fn(), markUsageNoticeSeen: vi.fn(async () => ({ ok: true })) };

function signIn(orgId: string | null = "o1") {
	useServerSessionStore.setState({ mode: "server", isAuthenticated: true });
	usePermissionsStore.setState({ orgId });
}

beforeEach(() => {
	serverUsage.getUsageNotice.mockReset();
	serverUsage.markUsageNoticeSeen.mockClear();
	serverUsage.getUsageNotice.mockResolvedValue({ ok: true, data: NOTICE });
	(globalThis as { electronAPI?: unknown }).electronAPI = { serverUsage };
});

afterEach(() => {
	cleanup();
	useServerSessionStore.setState({ mode: "local", isAuthenticated: false });
	usePermissionsStore.setState({ orgId: null });
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("ServerGate", () => {
	it("shows the sign-in screen until a session is open", () => {
		render(<ServerGate showLogin />);
		expect(screen.getByTestId("login")).toBeInTheDocument();
		expect(serverUsage.getUsageNotice).not.toHaveBeenCalled();
	});

	it("shows the notice when due and records that it was read", async () => {
		signIn();
		render(<ServerGate showLogin={false} />);
		expect(await screen.findByText("What this server measures about you")).toBeInTheDocument();
		expect(screen.getByText("Never a prompt, code, typed text or file name.")).toBeInTheDocument();
		expect(screen.queryByText(/Page counts are kept/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "I understand" }));
		await waitFor(() => expect(screen.queryByText("What this server measures about you")).toBeNull());
		expect(serverUsage.markUsageNoticeSeen).toHaveBeenCalledOnce();
	});

	it("counts closing the notice with Escape as read", async () => {
		signIn();
		render(<ServerGate showLogin={false} />);
		const title = await screen.findByText("What this server measures about you");
		fireEvent.keyDown(title, { key: "Escape" });
		await waitFor(() => expect(screen.queryByText("What this server measures about you")).toBeNull());
		expect(serverUsage.markUsageNoticeSeen).toHaveBeenCalledOnce();
	});

	it("stays quiet when read already, refused, signed out or outside an organization", async () => {
		serverUsage.getUsageNotice.mockResolvedValueOnce({ ok: true, data: { ...NOTICE, due: false } });
		signIn();
		const { rerender } = render(<ServerGate showLogin={false} />);
		await waitFor(() => expect(serverUsage.getUsageNotice).toHaveBeenCalledOnce());
		serverUsage.getUsageNotice.mockResolvedValueOnce({ ok: false, error: "down" });
		usePermissionsStore.setState({ orgId: "o2" });
		rerender(<ServerGate showLogin={false} />);
		await waitFor(() => expect(serverUsage.getUsageNotice).toHaveBeenCalledTimes(2));
		usePermissionsStore.setState({ orgId: null });
		rerender(<ServerGate showLogin={false} />);
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
		usePermissionsStore.setState({ orgId: "o3" });
		rerender(<ServerGate showLogin={false} />);
		expect(serverUsage.getUsageNotice).toHaveBeenCalledTimes(2);
		expect(screen.queryByText("What this server measures about you")).toBeNull();
	});

	it("drops a notice that arrives once the gate is gone", async () => {
		let answer: (value: unknown) => void = () => undefined;
		serverUsage.getUsageNotice.mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		signIn();
		const { unmount } = render(<ServerGate showLogin={false} />);
		unmount();
		answer({ ok: true, data: NOTICE });
		await Promise.resolve();
	});
});
