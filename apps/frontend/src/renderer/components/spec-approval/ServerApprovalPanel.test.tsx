import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServerApprovalPanel } from "./ServerApprovalPanel";

// A stable `t`, as react-i18next gives one.
const t = (key: string, values?: Record<string, unknown>) =>
	values ? `${key} ${JSON.stringify(values)}` : key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));
vi.mock("../../lib/date-format", () => ({ formatAppDateTime: (value: string) => `at ${value}` }));

const getServerCardApproval = vi.fn();
const setServerCardCriticality = vi.fn();

function approval(patch: Record<string, unknown> = {}) {
	return {
		criticality: "medium",
		criticalitySource: "default",
		needed: 2,
		count: 1,
		roles: ["security"],
		missingRoles: ["security"],
		approvals: [
			{ by: "Ann", for: null, at: "T1", roles: [] },
			{ by: "Bo", for: "Cy", at: "T2", roles: [] },
		],
		complete: false,
		approved: false,
		...patch,
	};
}

beforeEach(() => {
	getServerCardApproval.mockReset();
	setServerCardCriticality.mockReset();
	getServerCardApproval.mockResolvedValue({ success: true, data: approval() });
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
		getServerCardApproval,
		setServerCardCriticality,
	};
});

describe("ServerApprovalPanel", () => {
	it("shows the criticality, the count, who approved and the missing roles", async () => {
		render(<ServerApprovalPanel taskId="t1" />);
		expect(await screen.findByText(/specApproval:server.count/)).toHaveTextContent(
			'{"given":1,"needed":2}',
		);
		expect(getServerCardApproval).toHaveBeenCalledWith("t1");
		expect(screen.getByRole("button", { name: /levels.medium/ })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByText("specApproval:server.sources.default")).toBeInTheDocument();
		expect(screen.getByText(/missingRoles/)).toHaveTextContent("security");
		expect(screen.getByText(/server.by /)).toHaveTextContent('"by":"Ann"');
		expect(screen.getByText(/server.byFor/)).toHaveTextContent('"for":"Cy"');
		expect(screen.queryByText("specApproval:server.approved")).toBeNull();
	});

	it("changes the criticality and shows the approval as the server answers", async () => {
		setServerCardCriticality.mockResolvedValue({
			success: true,
			data: approval({
				criticality: "low",
				criticalitySource: "set",
				needed: 1,
				missingRoles: [],
				approvals: [],
				approved: true,
			}),
		});
		render(<ServerApprovalPanel taskId="t1" />);
		const medium = await screen.findByRole("button", { name: /levels.medium/ });
		// The current level asks nothing.
		fireEvent.click(medium);
		expect(setServerCardCriticality).not.toHaveBeenCalled();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /levels.low/ }));
		});
		expect(setServerCardCriticality).toHaveBeenCalledWith("t1", "low");
		expect(screen.getByText("specApproval:server.approved")).toBeInTheDocument();
		expect(screen.queryByText(/missingRoles/)).toBeNull();
	});

	it("shows the server's refusal, or its own words", async () => {
		setServerCardCriticality
			.mockResolvedValueOnce({ success: false, error: "Someone else lowers it" })
			.mockResolvedValueOnce({ success: false });
		render(<ServerApprovalPanel taskId="t1" />);
		const low = await screen.findByRole("button", { name: /levels.low/ });
		await act(async () => {
			fireEvent.click(low);
		});
		expect(screen.getByRole("alert")).toHaveTextContent("Someone else lowers it");
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /levels.high/ }));
		});
		expect(screen.getByRole("alert")).toHaveTextContent("specApproval:server.saveFailed");
	});

	it("says when the approvals cannot be read", async () => {
		getServerCardApproval.mockResolvedValueOnce({ success: false, error: "Not a card" });
		render(<ServerApprovalPanel taskId="t1" />);
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Not a card"));
		getServerCardApproval.mockResolvedValueOnce({ success: false });
		render(<ServerApprovalPanel taskId="t2" />);
		await waitFor(() =>
			expect(screen.getAllByRole("alert")[1]).toHaveTextContent("specApproval:server.loadFailed"),
		);
	});
});
