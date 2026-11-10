/**
 * @vitest-environment jsdom
 */

/**
 * RedTeamCard — what the red team broke, and a fresh attack on request.
 *
 * Pinned: no record, no card; crashes come first with their failure; the
 * static concurrency warnings are listed; "Attack" runs a fresh attack on the
 * task and shows its result, or the backend's error.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Task } from "../../../../shared/types";
import type { RedTeamRecord } from "../../../lib/agent-tools-api";

const api = vi.hoisted(() => ({
	fetchRedTeam: vi.fn(),
	runRedTeam: vi.fn(),
}));

vi.mock("../../../lib/agent-tools-api", () => api);
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
		i18n: { language: "fr" },
	}),
}));

import { RedTeamCard } from "../RedTeamCard";

const task = { id: "t1", specId: "001-cart" } as unknown as Task;

function record(overrides: Partial<RedTeamRecord> = {}): RedTeamRecord {
	return {
		status: "fail",
		reason: "1 attack(s) crashed the changed code",
		run: "attack",
		attacks: [
			{
				id: "a2",
				mode: "fuzz",
				test: "test_red_team_label",
				file: "tests/test_cart_red_team.py",
				target: "cart.label",
				input: '"api key"',
				expect: '"API Key"',
				outcome: "resistant",
				detail: "",
			},
			{
				id: "a1",
				mode: "edge",
				test: "test_red_team_zero",
				file: "tests/test_cart_red_team.py",
				target: "cart.unit_price",
				input: "quantity = 0",
				expect: "0",
				outcome: "crash",
				detail: "ZeroDivisionError: division by zero",
			},
		],
		warnings: [{ path: "store.py", line: 12, kind: "toctou", message: "" }],
		counts: { crash: 1, unexpected: 0, resistant: 1, warning: 1, not_run: 0 },
		attack_files: ["tests/test_cart_red_team.py"],
		finished_at: 1,
		...overrides,
	};
}

describe("RedTeamCard", () => {
	beforeEach(() => {
		api.fetchRedTeam.mockReset();
		api.runRedTeam.mockReset();
	});

	it("shows nothing until the red team has run", async () => {
		api.fetchRedTeam.mockResolvedValue({ ok: true, data: { record: null } });
		const { container } = render(<RedTeamCard task={task} projectPath="/p" />);
		await waitFor(() => expect(api.fetchRedTeam).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
		expect(api.fetchRedTeam.mock.calls[0][0]).toEqual({ projectDir: "/p", specId: "001-cart" });
	});

	it("lists the crash first with its failure, then what held, then the warnings", async () => {
		api.fetchRedTeam.mockResolvedValue({ ok: true, data: { record: record() } });
		render(<RedTeamCard task={task} projectPath="/p" />);
		const rows = await screen.findAllByTestId("red-team-attack");
		expect(rows[0]).toHaveTextContent("tasks:redTeam.outcome.crash");
		expect(rows[0]).toHaveTextContent("ZeroDivisionError");
		expect(rows[1]).toHaveTextContent("tasks:redTeam.outcome.resistant");
		expect(rows[1]).not.toHaveTextContent("ZeroDivisionError");
		expect(screen.getByText("store.py:12")).toBeInTheDocument();
		expect(screen.getByText("tasks:redTeam.status.fail")).toBeInTheDocument();
	});

	it("runs a fresh attack and shows its result", async () => {
		api.fetchRedTeam.mockResolvedValue({ ok: true, data: { record: record() } });
		api.runRedTeam.mockResolvedValue({
			ok: true,
			data: { record: record({ status: "pass", attacks: [], warnings: [] }) },
		});
		render(<RedTeamCard task={task} projectPath="/p" />);
		fireEvent.click(await screen.findByText("tasks:redTeam.attack"));
		expect(await screen.findByText("tasks:redTeam.status.pass")).toBeInTheDocument();
		expect(api.runRedTeam).toHaveBeenCalledWith({ projectDir: "/p", specId: "001-cart" });
	});

	it("says why an attack could not start", async () => {
		api.fetchRedTeam.mockResolvedValue({ ok: true, data: { record: record() } });
		api.runRedTeam.mockResolvedValue({ ok: false, error: "An internal error has occurred." });
		render(<RedTeamCard task={task} projectPath="/p" />);
		fireEvent.click(await screen.findByText("tasks:redTeam.attack"));
		expect(await screen.findByRole("alert")).toHaveTextContent("An internal error has occurred.");
	});
});
