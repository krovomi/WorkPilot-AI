import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dayBoundary, ServerDelegationsPanel } from "./ServerDelegationsPanel";

// A stable `t`, as react-i18next gives one.
const t = (key: string, values?: Record<string, unknown>) =>
	values ? `${key} ${JSON.stringify(values)}` : key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));
vi.mock("../../lib/date-format", () => ({ formatAppDate: (value: string) => `on ${value}` }));

const api = {
	listServerDelegations: vi.fn(),
	listServerDelegates: vi.fn(),
	createServerDelegation: vi.fn(),
	revokeServerDelegation: vi.fn(),
};

const ROW = {
	id: "d1",
	from: { id: "me", name: "Me" },
	to: { id: "u2", name: "Bo" },
	startsAt: "S",
	endsAt: "E",
	active: true,
};

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.listServerDelegations.mockResolvedValue({ success: true, data: [ROW, { ...ROW, id: "d2", active: false }] });
	api.listServerDelegates.mockResolvedValue({ success: true, data: [{ id: "u2", name: "Bo" }] });
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = api;
});

describe("ServerDelegationsPanel", () => {
	it("lists the lent approvals, running or planned", async () => {
		render(<ServerDelegationsPanel projectId="p1" />);
		expect(await screen.findAllByText(/delegations.item/)).toHaveLength(2);
		expect(screen.getByText("specApproval:delegations.active")).toBeInTheDocument();
		expect(screen.getByText("specApproval:delegations.planned")).toBeInTheDocument();
		expect(api.listServerDelegations).toHaveBeenCalledWith("p1");
		expect(api.listServerDelegates).toHaveBeenCalledWith("p1");
	});

	it("says when there is none, and when it cannot read them", async () => {
		api.listServerDelegations.mockResolvedValueOnce({ success: true });
		api.listServerDelegates.mockResolvedValueOnce({ success: false });
		render(<ServerDelegationsPanel projectId="p1" />);
		expect(await screen.findByText("specApproval:delegations.empty")).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("specApproval:delegations.loadFailed"),
		);
	});

	it("names the failing list", async () => {
		api.listServerDelegations.mockResolvedValueOnce({ success: false, error: "No access" });
		api.listServerDelegates.mockResolvedValueOnce({ success: true });
		render(<ServerDelegationsPanel projectId="p1" />);
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("No access"));
	});

	it("lends once a colleague and an end are chosen", async () => {
		api.createServerDelegation.mockResolvedValue({ success: true, data: ROW });
		render(<ServerDelegationsPanel projectId="p1" />);
		const lend = await screen.findByRole("button", { name: "specApproval:delegations.lend" });
		expect(lend).toBeDisabled();
		fireEvent.change(await screen.findByLabelText("specApproval:delegations.to"), {
			target: { value: "u2" },
		});
		fireEvent.change(screen.getByLabelText("specApproval:delegations.until"), {
			target: { value: "2026-12-01" },
		});
		expect(lend).toBeEnabled();
		await act(async () => {
			fireEvent.click(lend);
		});
		expect(api.createServerDelegation).toHaveBeenCalledWith("p1", {
			toUserId: "u2",
			endsAt: dayBoundary("2026-12-01", true),
		});
		expect(api.listServerDelegations).toHaveBeenCalledTimes(2);

		fireEvent.change(screen.getByLabelText("specApproval:delegations.to"), {
			target: { value: "u2" },
		});
		fireEvent.change(screen.getByLabelText("specApproval:delegations.from"), {
			target: { value: "2026-11-25" },
		});
		fireEvent.change(screen.getByLabelText("specApproval:delegations.until"), {
			target: { value: "2026-12-01" },
		});
		api.createServerDelegation.mockResolvedValueOnce({ success: false, error: "Too long" });
		await act(async () => {
			fireEvent.click(lend);
		});
		expect(api.createServerDelegation).toHaveBeenLastCalledWith("p1", {
			toUserId: "u2",
			endsAt: dayBoundary("2026-12-01", true),
			startsAt: dayBoundary("2026-11-25", false),
		});
		expect(screen.getByRole("alert")).toHaveTextContent("Too long");
		api.createServerDelegation.mockResolvedValueOnce({ success: false });
		await act(async () => {
			fireEvent.click(lend);
		});
		expect(screen.getByRole("alert")).toHaveTextContent("specApproval:delegations.saveFailed");
	});

	it("ends a lent approval, or says why it could not", async () => {
		api.revokeServerDelegation
			.mockResolvedValueOnce({ success: true })
			.mockResolvedValueOnce({ success: false, error: "Only its approver ends it" })
			.mockResolvedValueOnce({ success: false });
		render(<ServerDelegationsPanel projectId="p1" />);
		const [first] = await screen.findAllByRole("button", { name: /delegations.end/ });
		await act(async () => {
			fireEvent.click(first);
		});
		expect(api.revokeServerDelegation).toHaveBeenCalledWith("p1", "d1");
		expect(api.listServerDelegations).toHaveBeenCalledTimes(2);
		const [again] = screen.getAllByRole("button", { name: /delegations.end/ });
		await act(async () => {
			fireEvent.click(again);
		});
		expect(screen.getByRole("alert")).toHaveTextContent("Only its approver ends it");
		await act(async () => {
			fireEvent.click(screen.getAllByRole("button", { name: /delegations.end/ })[0]);
		});
		expect(screen.getByRole("alert")).toHaveTextContent("specApproval:delegations.saveFailed");
	});
});

describe("dayBoundary", () => {
	it("turns a picked day into its start or end", () => {
		expect(dayBoundary("2026-12-01", false)).toBe(new Date("2026-12-01T00:00:00").toISOString());
		expect(dayBoundary("2026-12-01", true)).toBe(new Date("2026-12-01T23:59:00").toISOString());
		expect(dayBoundary("", true)).toBeUndefined();
		expect(dayBoundary("2026-99-99", true)).toBeUndefined();
	});
});
