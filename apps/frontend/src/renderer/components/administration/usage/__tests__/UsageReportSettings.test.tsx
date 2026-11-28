/** @vitest-environment jsdom */
/**
 * The usage report pane: when and to whom it goes, an address outside the
 * organization flagged, who it goes to while none is chosen, a send now and
 * its outcome, the last sends, values the server would refuse never sent,
 * read-only without `usage.write`; and the preview of the report the email
 * carries.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../../shared/i18n";
import type { UsageReport, UsageReportSettings as Settings } from "@shared/types/server-usage";
import { usePermissionsStore } from "@/stores/permissions-store";
import { formatFigure } from "../UsageReportPreview";
import { addressesOf, UsageReportSettings } from "../UsageReportSettings";

const SETTINGS: Settings = {
	enabled: true,
	time: "09:00",
	timezone: "Europe/Paris",
	days: [0, 1, 2, 3, 4],
	recipients: [
		{ address: "boss@example.com", member: true },
		{ address: "cfo@outside.example", member: false },
	],
	language: "fr",
	names: true,
	weekly: false,
	monthly: false,
	email_enabled: true,
	default_recipients: ["ada@example.com"],
	last_sends: [
		{ kind: "daily", period: "2026-11-27", status: "sent", recipients: 2, at: "2026-11-28T08:00:00+00:00" },
		{ kind: "weekly", period: "2026-11-17", status: "no_smtp", recipients: 0, at: "2026-11-24T08:00:00+00:00" },
		{ kind: "yearly", period: "2026-01-01", status: "odd", recipients: 1, at: "2026-11-01T08:00:00+00:00" },
	],
};

const REPORT: UsageReport = {
	kind: "daily",
	organization: "Acme",
	start: "2026-11-27",
	end: "2026-11-27",
	names: true,
	figures: {
		tokens: { value: 1_500_000, previous: 1_000_000, average: 1_200_000 },
		cost_usd: { value: 12.5, previous: 10, average: null },
		success_rate: { value: 0.75, previous: null, average: 0.5 },
		runs: { value: 4, previous: 3, average: 3 },
		mystery: { value: 1, previous: 1, average: 1 },
	},
	dormant: 2,
	top: [
		{ name: "Ada", tokens: 900_000, cost_usd: 7 },
		{ name: null, tokens: 600_000, cost_usd: 5.5 },
	],
	engines: [
		{ provider: "anthropic", model: "model-a", tokens: 1_000_000, cost_usd: 9, runs: 3 },
		{ provider: "", model: "local-b", tokens: 500_000, cost_usd: 0, runs: 1 },
	],
	failures: [{ cause: "timeout", runs: 1, jobs: 0 }],
	alerts: [
		{ kind: "budget", threshold: 80, percent: 85 },
		{ kind: "budget_scope", scope: "group", name: "Team A", threshold: 100, percent: 102 },
		{ kind: "budget_scope", scope: "person", name: null, threshold: 80, percent: 81 },
	],
};

const serverUsage = {
	getReportSettings: vi.fn(),
	setReportSettings: vi.fn(),
	sendReportNow: vi.fn(),
	getReport: vi.fn(),
};

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
	serverUsage.getReportSettings.mockResolvedValue({ ok: true, data: SETTINGS });
	serverUsage.getReport.mockResolvedValue({ ok: true, data: REPORT });
	(globalThis as { electronAPI?: unknown }).electronAPI = { serverUsage };
	grant("usage.read", "usage.write");
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("addressesOf", () => {
	it("reads one address per line, comma or semicolon, and refuses the rest", () => {
		expect(addressesOf(" a@b.co \n\nc@d.org; e@f.io,")).toEqual(["a@b.co", "c@d.org", "e@f.io"]);
		expect(addressesOf("")).toEqual([]);
		expect(addressesOf("not an address")).toBeNull();
		expect(addressesOf(Array.from({ length: 21 }, (_, i) => `p${i}@example.com`).join("\n"))).toBeNull();
		expect(addressesOf(`${"x".repeat(250)}@example.com`)).toBeNull();
	});
});

describe("UsageReportSettings", () => {
	it("shows the settings, flags an address outside the organization, and saves a change", async () => {
		serverUsage.setReportSettings.mockImplementation(async (body) => ({
			ok: true,
			data: { ...SETTINGS, ...body, recipients: body.recipients.map((a: string) => ({ address: a, member: true })) },
		}));
		render(<UsageReportSettings />);
		// English keeps the 12-hour clock the native field showed.
		expect(await screen.findByLabelText("Time")).toHaveValue("09:00 AM");
		expect(screen.getByLabelText("Time zone")).toHaveValue("Europe/Paris");
		expect(screen.getByLabelText("Recipients")).toHaveValue("boss@example.com\ncfo@outside.example");
		expect(screen.getByText(/cfo@outside.example is not a member/)).toBeInTheDocument();
		expect(screen.queryByText(/SMTP is not configured/)).not.toBeInTheDocument();

		fireEvent.click(screen.getByLabelText("Send the daily report"));
		fireEvent.change(screen.getByLabelText("Time"), { target: { value: "07:30" } });
		fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: " America/New_York " } });
		fireEvent.click(screen.getByLabelText("Sat"));
		fireEvent.click(screen.getByLabelText("Mon"));
		fireEvent.click(screen.getByLabelText("Also the past week's report, each Monday"));
		fireEvent.click(screen.getByLabelText("Also the past month's report, on the first of the month"));
		fireEvent.change(screen.getByLabelText("Language"), { target: { value: "en" } });
		fireEvent.click(screen.getByLabelText("Name people in the report"));
		fireEvent.change(screen.getByLabelText("Recipients"), {
			target: { value: "boss@example.com\n team@example.com " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByText("Saved.");
		expect(serverUsage.setReportSettings).toHaveBeenCalledWith({
			enabled: false,
			time: "07:30",
			timezone: "America/New_York",
			days: [1, 2, 3, 4, 5],
			recipients: ["boss@example.com", "team@example.com"],
			language: "en",
			names: false,
			weekly: true,
			monthly: true,
		});
		expect(screen.queryByText(/is not a member/)).not.toBeInTheDocument();
		// A change after saving takes the "Saved." away.
		fireEvent.change(screen.getByLabelText("Language"), { target: { value: "fr" } });
		expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
	});

	it("says who it goes to while no address is chosen, and that mail cannot leave", async () => {
		serverUsage.getReportSettings.mockResolvedValue({
			ok: true,
			data: { ...SETTINGS, recipients: [], email_enabled: false, default_recipients: [], last_sends: [] },
		});
		render(<UsageReportSettings />);
		expect(await screen.findByText(/SMTP is not configured/)).toBeInTheDocument();
		expect(screen.getByText(/members whose role reads usage: nobody yet/)).toBeInTheDocument();
		expect(screen.getByText("Nothing sent yet.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send now" })).toBeDisabled();
	});

	it("never sends a time, a day or an address the server would refuse", async () => {
		serverUsage.setReportSettings.mockResolvedValue({ ok: false, error: "Unknown time zone" });
		render(<UsageReportSettings />);
		const save = await screen.findByRole("button", { name: "Save" });
		fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "../etc" } });
		expect(screen.getByText(/A time as HH:MM/)).toBeInTheDocument();
		expect(save).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Mars/Olympus" } });
		for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) fireEvent.click(screen.getByLabelText(day));
		expect(screen.getByText("Choose at least one day.")).toBeInTheDocument();
		expect(save).toBeDisabled();
		fireEvent.click(screen.getByLabelText("Sun"));
		fireEvent.change(screen.getByLabelText("Recipients"), { target: { value: "boss@" } });
		expect(screen.getByText(/Check the addresses/)).toBeInTheDocument();
		expect(save).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Recipients"), { target: { value: "" } });
		expect(screen.getByText(/members whose role reads usage: ada@example.com/)).toBeInTheDocument();
		fireEvent.click(save);
		expect(await screen.findByText("The server refused: Unknown time zone")).toBeInTheDocument();
		expect(serverUsage.setReportSettings).toHaveBeenCalledWith(
			expect.objectContaining({ timezone: "Mars/Olympus", days: [6], recipients: [] }),
		);
	});

	it("sends the report now and says how it went", async () => {
		serverUsage.sendReportNow
			.mockResolvedValueOnce({ ok: true, data: { status: "sent", recipients: 2, period: "2026-11-27" } })
			.mockResolvedValueOnce({ ok: true, data: { status: "no_recipient", recipients: 0, period: "2026-11-27" } })
			.mockResolvedValueOnce({ ok: true, data: { status: "unheard_of", recipients: 0, period: "2026-11-27" } })
			.mockResolvedValueOnce({ ok: false, error: "SMTP is not configured" });
		render(<UsageReportSettings />);
		const send = await screen.findByRole("button", { name: "Send now" });
		fireEvent.click(send);
		expect(await screen.findByText("Sent to 2 addresses.")).toBeInTheDocument();
		expect(serverUsage.getReportSettings).toHaveBeenCalledTimes(2);
		fireEvent.click(send);
		expect(await screen.findByText("Not sent: No recipient.")).toBeInTheDocument();
		fireEvent.click(send);
		expect(await screen.findByText("Not sent: unheard_of.")).toBeInTheDocument();
		fireEvent.click(send);
		expect(await screen.findByText("The server refused: SMTP is not configured")).toBeInTheDocument();
	});

	it("lists the last sends", async () => {
		render(<UsageReportSettings />);
		const rows = (await screen.findByText("Last sends")).closest("section") as HTMLElement;
		expect(within(rows).getByText("Daily")).toBeInTheDocument();
		expect(within(rows).getByText("Sent")).toBeInTheDocument();
		expect(within(rows).getByText("No SMTP")).toBeInTheDocument();
		expect(within(rows).getByText("yearly")).toBeInTheDocument();
		expect(within(rows).getByText("odd")).toBeInTheDocument();
	});

	it("is read-only without usage.write", async () => {
		grant("usage.read");
		render(<UsageReportSettings />);
		expect(await screen.findByLabelText("Time")).toBeDisabled();
		expect(screen.getByLabelText("Recipients")).toBeDisabled();
		expect(screen.getByLabelText("Mon")).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Send now" })).not.toBeInTheDocument();
	});

	it("says when the server refuses to read them, and waits without a bridge", async () => {
		serverUsage.getReportSettings.mockResolvedValue({ ok: false, error: "Forbidden" });
		render(<UsageReportSettings />);
		expect(await screen.findByText("The server refused: Forbidden")).toBeInTheDocument();
		cleanup();
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
		render(<UsageReportSettings />);
		expect(screen.getByText("Loading…")).toBeInTheDocument();
	});

	it("does nothing once the bridge is gone", async () => {
		render(<UsageReportSettings />);
		const save = await screen.findByRole("button", { name: "Save" });
		await screen.findByText("Tokens");
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
		fireEvent.click(save);
		fireEvent.click(screen.getByRole("button", { name: "Send now" }));
		fireEvent.click(screen.getByRole("button", { name: "Show" }));
		expect(serverUsage.setReportSettings).not.toHaveBeenCalled();
		expect(serverUsage.sendReportNow).not.toHaveBeenCalled();
		expect(serverUsage.getReport).toHaveBeenCalledTimes(1);
	});

	it("offers the time zones the system knows, and none when it cannot list them", async () => {
		const { container } = render(<UsageReportSettings />);
		await screen.findByLabelText("Time zone");
		expect(container.querySelectorAll("#report-zones option").length).toBeGreaterThan(0);
		cleanup();
		vi.spyOn(Intl, "supportedValuesOf").mockImplementation(() => {
			throw new RangeError("unsupported");
		});
		const again = render(<UsageReportSettings />);
		await screen.findByLabelText("Time zone");
		expect(again.container.querySelectorAll("#report-zones option")).toHaveLength(0);
	});
});

describe("UsageReportPreview", () => {
	it("shows the last daily report as the email carries it", async () => {
		render(<UsageReportSettings />);
		expect(await screen.findByText("Tokens")).toBeInTheDocument();
		expect(serverUsage.getReport).toHaveBeenCalledWith("daily", undefined);
		expect(screen.getByText("7-day mean")).toBeInTheDocument();
		expect(screen.getByText("Success rate")).toBeInTheDocument();
		expect(screen.getByText("mystery")).toBeInTheDocument();
		expect(screen.getByText("2 members not seen for a while.")).toBeInTheDocument();
		expect(screen.getByText(/Organization budget: 85%/)).toBeInTheDocument();
		expect(screen.getByText(/Group Team A: 102%/)).toBeInTheDocument();
		expect(screen.getByText(/Person Not named: 81%/)).toBeInTheDocument();
		expect(screen.getByText("Ada")).toBeInTheDocument();
		expect(screen.getAllByText("Not named").length).toBeGreaterThan(0);
		expect(screen.getByText("Unknown provider")).toBeInTheDocument();
		expect(screen.getByText("Timed out")).toBeInTheDocument();
	});

	it("shows another period on demand, and a refusal", async () => {
		serverUsage.getReport.mockResolvedValueOnce({ ok: true, data: REPORT }).mockResolvedValueOnce({
			ok: true,
			data: {
				...REPORT,
				kind: "weekly",
				dormant: 0,
				top: [],
				engines: [],
				failures: [],
				alerts: [],
			},
		});
		render(<UsageReportSettings />);
		await screen.findByText("Tokens");
		fireEvent.change(screen.getByLabelText("Report"), { target: { value: "weekly" } });
		fireEvent.change(screen.getByLabelText("Period holding"), { target: { value: "2026-11-20" } });
		fireEvent.click(screen.getByRole("button", { name: "Show" }));
		await waitFor(() => expect(screen.queryByText("7-day mean")).not.toBeInTheDocument());
		expect(serverUsage.getReport).toHaveBeenLastCalledWith("weekly", "2026-11-20");
		expect(screen.queryByText("Who used most")).not.toBeInTheDocument();
		serverUsage.getReport.mockResolvedValueOnce({ ok: false, error: "day must be in the past" });
		fireEvent.click(screen.getByRole("button", { name: "Show" }));
		expect(await screen.findByText("The server refused: day must be in the past")).toBeInTheDocument();
		expect(screen.queryByText("Tokens")).not.toBeInTheDocument();
	});

	it("writes each figure in its unit", () => {
		expect(formatFigure("tokens", null)).toBe("–");
		expect(formatFigure("tokens", 1_500_000)).toBe("1.5M");
		expect(formatFigure("cost_per_task_usd", 2)).toBe("$2.00");
		expect(formatFigure("success_rate", 0.5)).toBe("50%");
		expect(formatFigure("runs", 1234)).toBe("1,234");
	});
});
