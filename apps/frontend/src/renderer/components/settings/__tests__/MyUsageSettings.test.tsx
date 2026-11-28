/** @vitest-environment jsdom */
/**
 * My usage: what administrators see of the person over 30 days, who reads
 * it, everything kept about them as a JSON file, and the notice to read again.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import { MyUsageSettings } from "../MyUsageSettings";

const ended = { total: 0, succeeded: 0, failed: 0, cancelled: 0, success_rate: null };
const MINE = {
	user: { user_id: "u1", name: "Ada", email: "ada@example.com" },
	summary: {
		start: "2026-10-29",
		end: "2026-11-27",
		tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0, total: 0 },
		cost_usd: 0,
		sessions: 0,
		estimated: false,
		budget: null,
		active: { day: 1, week: 1, month: 1 },
		runs: ended,
		jobs: ended,
	},
	daily: [],
	timeline: [],
	pages: { enabled: false, pages: [] },
	visible_to: ["Administrator", "Owner"],
};
const NOTICE = {
	due: false,
	measured: ["tokens", "runs"],
	page_activity: true,
	usage_retention_days: 365,
	page_activity_retention_days: 183,
	visible_to: ["Administrator"],
};
const serverUsage = { getMyUsage: vi.fn(), exportMyUsage: vi.fn(), getUsageNotice: vi.fn() };

beforeEach(() => {
	for (const fn of Object.values(serverUsage)) fn.mockReset();
	serverUsage.getMyUsage.mockResolvedValue({ ok: true, data: MINE });
	(globalThis as { electronAPI?: unknown }).electronAPI = { serverUsage };
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("MyUsageSettings", () => {
	it("shows what administrators see and who they are", async () => {
		render(<MyUsageSettings />);
		expect(
			await screen.findByText("Readable by: Administrator, Owner, and the server's platform administrators."),
		).toBeInTheDocument();
		const [query] = serverUsage.getMyUsage.mock.calls[0];
		expect(query.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("downloads everything kept, or says why not", async () => {
		Object.assign(URL, { createObjectURL: vi.fn(() => "blob:json"), revokeObjectURL: vi.fn() });
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
		serverUsage.exportMyUsage.mockResolvedValueOnce({ ok: true, data: "{}" });
		render(<MyUsageSettings />);
		const button = screen.getByRole("button", { name: "Download everything kept about me (JSON)" });
		fireEvent.click(button);
		await waitFor(() => expect(click).toHaveBeenCalled());
		serverUsage.exportMyUsage.mockResolvedValueOnce({ ok: false, error: "Account not found" });
		fireEvent.click(button);
		expect(await screen.findByText("The server refused: Account not found")).toBeInTheDocument();
	});

	it("shows the notice again, with page activity, and closes it", async () => {
		serverUsage.getUsageNotice.mockResolvedValueOnce({ ok: true, data: NOTICE });
		render(<MyUsageSettings />);
		fireEvent.click(screen.getByRole("button", { name: "Read again what is measured" }));
		expect(await screen.findByText("Page counts are kept 183 days.")).toBeInTheDocument();
		expect(screen.getByText("These figures are kept 365 days.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "I understand" }));
		await waitFor(() => expect(screen.queryByText("Page counts are kept 183 days.")).toBeNull());

		serverUsage.getUsageNotice.mockResolvedValueOnce({ ok: false, error: "No organization" });
		fireEvent.click(screen.getByRole("button", { name: "Read again what is measured" }));
		expect(await screen.findByText("The server refused: No organization")).toBeInTheDocument();
	});

	it("does nothing without a bridge", () => {
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
		render(<MyUsageSettings />);
		fireEvent.click(screen.getByRole("button", { name: "Download everything kept about me (JSON)" }));
		fireEvent.click(screen.getByRole("button", { name: "Read again what is measured" }));
		expect(screen.getByText("Loading…")).toBeInTheDocument();
	});

	it("drops an answer that arrives once the section is closed", async () => {
		let answer: (value: unknown) => void = () => undefined;
		serverUsage.getMyUsage.mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		const { unmount } = render(<MyUsageSettings />);
		unmount();
		answer({ ok: true, data: MINE });
		await Promise.resolve();
	});
});
