/**
 * @vitest-environment jsdom
 */

/**
 * VerifyLoopCard — the verification loop, in one card.
 *
 * Pinned: no record, no card; a record shows its verdict, the fix rounds,
 * the endpoints and the score; a measure that was not taken is not a zero;
 * the re-run button calls the API with the task's address.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Task } from "../../../../shared/types";
import type { VerifyRecord } from "../../../lib/agent-tools-api";

const mockFetch = vi.fn();
const mockRun = vi.fn();

vi.mock("../../../lib/agent-tools-api", () => ({
	fetchVerify: (...args: unknown[]) => mockFetch(...args),
	runVerify: (...args: unknown[]) => mockRun(...args),
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
	}),
}));

import { useVerifyStore } from "../../../stores/verify-store";
import { VerifyLoopCard } from "../VerifyLoopCard";
import { endpointSummary, measured, remainingErrors, roundsSummary } from "../verify-view";

const task = { id: "t1", specId: "001-orders" } as unknown as Task;

const record: VerifyRecord = {
	status: "pass",
	reason: "",
	score: 91,
	targets: [{ name: "api", kind: "backend-api", errors: [], launch: { status: "ready" } }],
	rounds: [{ round: 1, target: "api", errors_before: 2, errors_after: 0, fixed: true }],
	scenario: [],
	confirmations: [{ state: "order created" }],
	endpoints: [
		{ method: "POST", path: "/api/orders", status: 201, expected: [201], ok: true, latency_ms: 12, schema_ok: true, problems: [], outcome: "called" },
		{ method: "GET", path: "/api/admin", status: 401, expected: [200], ok: false, latency_ms: 3, schema_ok: null, problems: [], outcome: "auth" },
	],
	perf: [],
	lighthouse: {},
	latency: {},
	mobile: [],
	screenshots: [],
	findings: [],
};

beforeEach(() => {
	mockFetch.mockReset();
	mockRun.mockReset();
	useVerifyStore.setState({ byTask: {} });
});

describe("verify-view", () => {
	it("summarises without inventing zeros", () => {
		expect(roundsSummary(record)).toEqual({ rounds: 1, fixed: 1 });
		expect(endpointSummary(record)).toEqual({ ok: 1, called: 1, auth: 1 });
		expect(remainingErrors(record)).toBe(0);
		expect(measured(null)).toBeNull();
		expect(measured(undefined)).toBeNull();
		expect(measured(0)).toBe("0");
		expect(measured(0.0123, 3)).toBe("0.012");
	});
});

describe("VerifyLoopCard", () => {
	it("renders nothing without a record", async () => {
		mockFetch.mockResolvedValue({ ok: true, data: { record: null } });
		const { container } = render(<VerifyLoopCard task={task} projectPath="/p" />);
		await waitFor(() => expect(mockFetch).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the verdict, rounds, endpoints and score, and re-runs", async () => {
		mockFetch.mockResolvedValue({ ok: true, data: { record } });
		mockRun.mockResolvedValue({ ok: true, data: { record } });
		render(<VerifyLoopCard task={task} projectPath="/p" />);
		expect(await screen.findByText("tasks:verify.status.pass")).toBeInTheDocument();
		expect(screen.getByText(/tasks:verify.badge.score/)).toBeInTheDocument();
		expect(screen.getByText(/tasks:verify.badge.rounds/)).toBeInTheDocument();
		expect(screen.getByText(/tasks:verify.badge.endpoints/)).toBeInTheDocument();
		fireEvent.click(screen.getByText("tasks:verify.rerun"));
		await waitFor(() =>
			expect(mockRun).toHaveBeenCalledWith(
				{ projectDir: "/p", specId: "001-orders" },
				{ effort: undefined },
				expect.anything(),
			),
		);
	});
});
