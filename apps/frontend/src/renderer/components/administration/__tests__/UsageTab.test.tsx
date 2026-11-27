/** @vitest-environment jsdom */
/**
 * Usage tab: page activity off until an administrator turns it on, a warning
 * that turning it off erases the counts, retentions within the server's
 * bounds or empty (the server's), and read-only without `usage.write`.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import { usePermissionsStore } from "@/stores/permissions-store";
import { UsageTab } from "../UsageTab";

const SETTINGS = {
	page_activity: false,
	page_activity_since: null,
	usage_retention_days: null,
	page_activity_retention_days: null,
	defaults: { usage_retention_days: 365, page_activity_retention_days: 183 },
};
const serverUsage = { getUsageSettings: vi.fn(), setUsageSettings: vi.fn(), notePageVisit: vi.fn() };

function grant(...permissions: string[]): void {
	usePermissionsStore.setState({
		loaded: true,
		unrestricted: false,
		isPlatformAdmin: false,
		orgId: "o1",
		organizations: [],
		permissions: new Set(permissions),
	});
}

beforeEach(() => {
	for (const fn of Object.values(serverUsage)) fn.mockReset();
	serverUsage.getUsageSettings.mockResolvedValue({ ok: true, data: SETTINGS });
	(globalThis as { electronAPI?: unknown }).electronAPI = { serverUsage };
	grant("usage.read", "usage.write");
});

afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("UsageTab", () => {
	it("turns page activity on with a retention, and says when", async () => {
		serverUsage.setUsageSettings.mockResolvedValue({
			ok: true,
			data: { ...SETTINGS, page_activity: true, page_activity_since: "2026-11-27T10:00:00Z", page_activity_retention_days: 90 },
		});
		render(<UsageTab />);
		const toggle = await screen.findByRole("checkbox");
		expect(toggle).not.toBeChecked();
		expect(screen.getByText(/Tell the members what is measured/)).toBeInTheDocument();
		expect(screen.getByPlaceholderText("Server default: 365 days")).toBeInTheDocument();
		fireEvent.click(toggle);
		fireEvent.change(screen.getByLabelText("Page activity (days)"), { target: { value: "90" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByText("Saved.");
		expect(serverUsage.setUsageSettings).toHaveBeenCalledWith({
			page_activity: true,
			usage_retention_days: null,
			page_activity_retention_days: 90,
		});
		expect(screen.getByText(/On since/)).toBeInTheDocument();
	});

	it("warns that turning it off erases the counts, and shows a refusal", async () => {
		serverUsage.getUsageSettings.mockResolvedValue({
			ok: true,
			data: { ...SETTINGS, page_activity: true, page_activity_since: "2026-11-27T10:00:00Z", usage_retention_days: 400 },
		});
		serverUsage.setUsageSettings.mockResolvedValue({ ok: false, error: "Missing permission: usage.write" });
		render(<UsageTab />);
		fireEvent.click(await screen.findByRole("checkbox"));
		expect(screen.getByText(/erases the page counts/)).toBeInTheDocument();
		expect(screen.getByLabelText("Token use and presence (days)")).toHaveValue(400);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("usage.write");
	});

	it("refuses a retention outside the bounds before saving", async () => {
		render(<UsageTab />);
		const field = await screen.findByLabelText("Token use and presence (days)");
		for (const value of ["7", "4000", "40.5"]) {
			fireEvent.change(field, { target: { value } });
			expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
			expect(screen.getByText(/Enter a whole number of days/)).toBeInTheDocument();
		}
		fireEvent.change(field, { target: { value: "" } });
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
	});

	it("is read-only without usage.write, and says why it could not load", async () => {
		grant("usage.read");
		serverUsage.getUsageSettings.mockResolvedValue({ ok: false, error: "offline" });
		render(<UsageTab />);
		expect(await screen.findByRole("alert")).toHaveTextContent("offline");
		expect(screen.getByRole("checkbox")).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
	});

	it("drops an answer that arrives after it closed, and needs the bridge", async () => {
		let reply: (value: unknown) => void = () => undefined;
		serverUsage.getUsageSettings.mockReturnValue(new Promise((resolve) => (reply = resolve)));
		const { unmount } = render(<UsageTab />);
		unmount();
		reply({ ok: true, data: SETTINGS });
		await waitFor(() => expect(serverUsage.getUsageSettings).toHaveBeenCalled());
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
		render(<UsageTab />);
		expect(screen.getByText("Loading…")).toBeInTheDocument();
	});
});
