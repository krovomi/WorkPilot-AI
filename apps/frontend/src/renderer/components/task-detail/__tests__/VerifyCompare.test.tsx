/**
 * @vitest-environment jsdom
 */

/**
 * VerifyCompare — the verification replayed on the base branch and on the task.
 *
 * Pinned: what the task broke is listed first, a changed status shows both
 * sides, the two end captures are shown here and not again among the
 * screenshots, a skipped comparison says why, nothing to replay offers no
 * button, and the button asks the store for a comparison.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Task } from "../../../../shared/types";
import type { VerifyRecord } from "../../../lib/agent-tools-api";

const compareVerify = vi.fn();

vi.mock("../../../lib/agent-tools-api", () => ({
	fetchVerify: vi.fn(),
	runVerify: vi.fn(),
	compareVerify: (...args: unknown[]) => compareVerify(...args),
	verifyScreenshotUrl: (_query: unknown, index: number) => `shot://${index}`,
	verifyTraceUrl: () => "trace://zip",
	verifyMediaUrl: (_query: unknown, kind: string) => `media://${kind}`,
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
	}),
}));

import { useVerifyStore } from "../../../stores/verify-store";
import { TaskVerify } from "../TaskVerify";
import { orderedDifferences } from "../VerifyCompare";

const task = { id: "t1", specId: "001-orders" } as unknown as Task;

function withRecord(extra: Partial<VerifyRecord>) {
	const record: VerifyRecord = {
		status: "pass",
		reason: "",
		score: null,
		targets: [],
		rounds: [],
		scenario: [{ action: "navigate", url: "/" }],
		confirmations: [],
		endpoints: [],
		perf: [],
		lighthouse: {},
		latency: {},
		mobile: [],
		screenshots: [
			{ index: 0, label: "home", platform: "web", url: "" },
			{ index: 1, label: "Base branch", platform: "web", url: "" },
			{ index: 2, label: "This task", platform: "web", url: "" },
		],
		findings: [],
		...extra,
	};
	useVerifyStore.setState({
		byTask: { t1: { data: { record, settings: undefined }, busy: null, error: null } },
	} as never);
}

describe("VerifyCompare", () => {
	beforeEach(() => {
		compareVerify.mockReset();
		useVerifyStore.setState({ byTask: {} } as never);
	});

	it("puts what the task broke first", () => {
		const ordered = orderedDifferences([
			{ kind: "console", change: "added", what: "[error] x" },
			{ kind: "network", change: "changed", what: "GET /a", base: "200", task: "500" },
			{ kind: "scenario", change: "broken", what: "Saved never appeared" },
		]);
		expect(ordered.map((d) => d.change)).toEqual(["broken", "changed", "added"]);
	});

	it("lists the differences and shows each side's capture once", () => {
		withRecord({
			compare: {
				status: "done",
				base: "0123456789abcdef",
				differences: [
					{ kind: "network", change: "changed", what: "GET /api/orders", base: "200", task: "500" },
					{ kind: "scenario", change: "broken", what: "Saved never appeared" },
				],
				screenshots: { base: 1, task: 2 },
			},
		});
		render(<TaskVerify task={task} projectPath="/p" />);
		const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
		const broken = items.findIndex((text) => text.includes("Saved never appeared"));
		const changed = items.findIndex((text) => text.includes("GET /api/orders"));
		expect(broken).toBeGreaterThanOrEqual(0);
		expect(broken).toBeLessThan(changed);
		expect(
			screen.getByText('tasks:verify.compare.status:{"base":"200","task":"500"}'),
		).toBeInTheDocument();
		expect(screen.getByText('tasks:verify.compare.against:{"base":"0123456789"}')).toBeInTheDocument();
		const sources = screen.getAllByRole("img").map((img) => img.getAttribute("src"));
		expect(sources.filter((src) => src === "shot://1")).toHaveLength(1);
		expect(sources.filter((src) => src === "shot://2")).toHaveLength(1);
		expect(sources).toContain("shot://0");
	});

	it("says why a comparison was skipped", () => {
		withRecord({ compare: { status: "skipped", reason: "no base branch found" } });
		render(<TaskVerify task={task} projectPath="/p" />);
		expect(
			screen.getByText('tasks:verify.compare.skipped:{"reason":"no base branch found"}'),
		).toBeInTheDocument();
	});

	it("offers nothing when there is nothing to replay", () => {
		withRecord({ scenario: [] });
		render(<TaskVerify task={task} projectPath="/p" />);
		expect(screen.queryByText("tasks:verify.compare.run")).not.toBeInTheDocument();
	});

	it("asks for a comparison and keeps the settings", async () => {
		withRecord({});
		const record = useVerifyStore.getState().byTask.t1.data?.record;
		compareVerify.mockResolvedValue({
			ok: true,
			data: { record: { ...record, compare: { status: "done", differences: [] } } },
		});
		render(<TaskVerify task={task} projectPath="/p" />);
		fireEvent.click(screen.getByText("tasks:verify.compare.run"));
		expect(compareVerify).toHaveBeenCalledWith(
			{ projectDir: "/p", specId: "001-orders" },
			expect.any(AbortSignal),
		);
		expect(await screen.findByText("tasks:verify.compare.same")).toBeInTheDocument();
	});
});
