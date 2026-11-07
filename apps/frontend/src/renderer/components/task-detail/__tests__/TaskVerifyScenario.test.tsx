/**
 * @vitest-environment jsdom
 */

/**
 * TaskVerify — the scenario written on the card.
 *
 * Pinned: each step the card asked for is listed with what the verifier saw,
 * a step never reported says so, a step's capture is served by index, and
 * the Playwright trace is offered only when there is one.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Task } from "../../../../shared/types";
import type { VerifyRecord } from "../../../lib/agent-tools-api";

vi.mock("../../../lib/agent-tools-api", () => ({
	fetchVerify: vi.fn(),
	runVerify: vi.fn(),
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

const task = { id: "t1", specId: "001-orders" } as unknown as Task;

function withRecord(extra: Partial<VerifyRecord>) {
	const record: VerifyRecord = {
		status: "unknown",
		reason: "",
		score: null,
		targets: [],
		rounds: [],
		scenario: [],
		confirmations: [],
		endpoints: [],
		perf: [],
		lighthouse: {},
		latency: {},
		mobile: [],
		screenshots: [{ index: 0, label: "step 1", platform: "web", url: "" }],
		findings: [],
		...extra,
	};
	useVerifyStore.setState({
		byTask: { t1: { data: { record, settings: null }, busy: null } },
	} as never);
}

describe("TaskVerify — card scenario", () => {
	beforeEach(() => useVerifyStore.setState({ byTask: {} } as never));

	it("lists each step with its outcome, capture and the trace", () => {
		withRecord({
			scenario_requested: ["Open the orders page", "Click Save", "The toast says Saved"],
			scenario_steps: [
				{ step: 1, outcome: "pass", note: "list shown", screenshotIndex: 0 },
				{ step: 2, outcome: "fail", note: "no toast" },
			],
			trace: true,
		});
		render(<TaskVerify task={task} projectPath="/p" />);
		expect(screen.getByText("tasks:verify.sections.cardScenario")).toBeInTheDocument();
		expect(screen.getByText("Click Save")).toBeInTheDocument();
		expect(screen.getByText("tasks:verify.step.pass")).toBeInTheDocument();
		expect(screen.getByText("tasks:verify.step.fail")).toBeInTheDocument();
		expect(screen.getByText("tasks:verify.step.missing")).toBeInTheDocument();
		expect(screen.getByText("no toast")).toBeInTheDocument();
		expect(screen.getByAltText('tasks:verify.stepCapture:{"number":1}')).toHaveAttribute("src", "shot://0");
		const link = screen.getByRole("link", { name: "tasks:verify.trace.download" });
		expect(link).toHaveAttribute("href", "trace://zip");
		expect(link).toHaveAttribute("target", "_blank");
	});

	it("says when there is no trace, and shows nothing without a scenario", () => {
		withRecord({ scenario_requested: ["Open"], scenario_steps: [], trace: false });
		const { unmount } = render(<TaskVerify task={task} projectPath="/p" />);
		expect(screen.getByText("tasks:verify.trace.none")).toBeInTheDocument();
		expect(screen.queryByRole("link")).toBeNull();
		unmount();
		withRecord({});
		render(<TaskVerify task={task} projectPath="/p" />);
		expect(screen.queryByText("tasks:verify.sections.cardScenario")).toBeNull();
	});

	it("plays the scenario's video and shows its GIF, served by the record", () => {
		withRecord({ scenario_requested: ["Open"], video: true, walkthrough: true });
		const { container } = render(<TaskVerify task={task} projectPath="/p" />);
		const video = container.querySelector("video");
		expect(video).toHaveAttribute("src", "media://video");
		expect(video).toHaveAttribute("controls");
		expect(screen.getByAltText("tasks:verify.walkthrough.gif")).toHaveAttribute("src", "media://walkthrough");
	});

	it("says why there is no video rather than show an empty player", () => {
		withRecord({
			scenario_requested: ["Open"],
			video_note: "no video when attached to a running app over CDP",
		});
		const { container } = render(<TaskVerify task={task} projectPath="/p" />);
		expect(container.querySelector("video")).toBeNull();
		expect(screen.getByText(/tasks:verify.walkthrough.noVideo.*over CDP/)).toBeInTheDocument();
		expect(screen.queryByAltText("tasks:verify.walkthrough.gif")).toBeNull();
	});
});
