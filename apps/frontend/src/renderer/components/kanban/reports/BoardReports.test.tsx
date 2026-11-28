/**
 * The « Rapports » dialog: each report from the project's cards and sprints,
 * and what it says when there is nothing to measure yet.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sprint, Task, TaskStatusTransition } from "../../../../shared/types";
import { useSprintStore } from "../../../stores/sprint-store";
import { useTaskStore } from "../../../stores/task-store";
import { BoardReportsButton } from "./BoardReports";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const move = (to: TaskStatusTransition["to"], at: string): TaskStatusTransition => ({ from: null, to, at, actor: "user" });
const card = (id: string, extra: Record<string, unknown> = {}) =>
	({ id, specId: id, title: id, status: "backlog", createdAt: ago(20), updatedAt: ago(20), metadata: {}, ...extra }) as unknown as Task;
const today = () => new Date().toISOString().slice(0, 10);

async function openReports() {
	const user = userEvent.setup();
	render(<BoardReportsButton />);
	await user.click(screen.getByRole("button", { name: "Reports" }));
	const dialog = screen.getByRole("dialog");
	const tab = async (name: string) => {
		await user.click(within(dialog).getByRole("tab", { name }));
		return within(dialog).getByRole("tabpanel");
	};
	return { user, dialog, tab };
}

beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.releasePointerCapture ??= () => undefined;
	Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
	useTaskStore.setState({ tasks: [] });
	useSprintStore.setState({ sprints: [] });
});

describe("BoardReports", () => {
	it("says what each report needs when there is nothing to measure", async () => {
		const { tab } = await openReports();
		expect(await tab("Burndown")).toHaveTextContent("No sprint in progress");
		expect(await tab("Velocity")).toHaveTextContent("No sprint closed yet");
		expect(await tab("Cumulative flow")).toHaveTextContent("Cards per stage at the end of each day");
		expect(await tab("Cycle time")).toHaveTextContent("No card finished in the last 90 days");
		expect(await tab("Throughput")).toHaveTextContent("0 cards finished in the last 8 weeks.");
		expect(await tab("Unsuccessful ends")).toHaveTextContent("No card ended without success.");
	});

	it("draws each report from the cards and the sprints", async () => {
		const points = (score: number) => ({ smartEstimate: { complexityScore: score }, sprintId: "sp-0000000a" });
		useSprintStore.setState({
			sprints: [
				{ id: "sp-0000000a", name: "Sprint 12", state: "active", createdAt: "t", startDate: today(), committed: { cards: 2, points: 8 } },
				{
					id: "sp-00000009",
					name: "Sprint 11",
					state: "closed",
					createdAt: "t",
					closedAt: ago(1),
					report: { done: 2, donePoints: 6, carried: 0, carriedPoints: 0, carriedTo: null },
				},
			] as Sprint[],
		});
		useTaskStore.setState({
			tasks: [
				card("done", { status: "done", metadata: points(5), statusHistory: [move("in_progress", ago(3)), move("done", ago(0))] }),
				card("open", { status: "in_progress", metadata: points(3) }),
				card("failed", { status: "human_review", reviewReason: "qa_rejected" }),
				card("dropped", { metadata: { abandoned: true, abandonedResolution: "duplicate", abandonedAt: ago(2) } }),
			],
		});
		const { dialog, tab } = await openReports();
		const burndown = await tab("Burndown");
		expect(burndown).toHaveTextContent("Sprint 12: 3 of 8 points left.");
		expect(within(burndown).getByRole("img", { name: "Burndown of Sprint 12" })).toBeInTheDocument();
		expect(within(burndown).getByRole("table", { hidden: true })).toHaveTextContent("8");

		const velocity = await tab("Velocity");
		expect(velocity).toHaveTextContent("Average of the last 3 sprints: 6 points.");
		expect(within(velocity).getByRole("table", { hidden: true })).toHaveTextContent("Sprint 11—6");

		const flow = await tab("Cumulative flow");
		expect(within(flow).getByRole("img", { name: "Cards per stage, last 30 days" })).toBeInTheDocument();

		expect(await tab("Cycle time")).toHaveTextContent("1 card finished: 3 days from start to done.");
		expect(await tab("Throughput")).toHaveTextContent("1 card finished in the last 8 weeks.");

		const ends = await tab("Unsuccessful ends");
		expect(within(ends).getByText("Rejected by QA")).toBeInTheDocument();
		expect(within(ends).getByText("Duplicate")).toBeInTheDocument();

		await userEvent.keyboard("{Escape}");
		expect(dialog).not.toBeInTheDocument();
	});

	it("shows a sprint that starts later with all its points left", async () => {
		const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10);
		useSprintStore.setState({
			sprints: [{ id: "sp-0000000a", name: "Sprint 13", state: "active", createdAt: "t", startDate: tomorrow }] as Sprint[],
		});
		useTaskStore.setState({ tasks: [card("open", { metadata: { smartEstimate: { complexityScore: 2 }, sprintId: "sp-0000000a" } })] });
		const { tab } = await openReports();
		expect(await tab("Burndown")).toHaveTextContent("Sprint 13: 2 of 2 points left.");
	});

	it("shows only the kind of end that happened", async () => {
		useTaskStore.setState({ tasks: [card("failed", { status: "human_review", reviewReason: "errors" })] });
		const { tab } = await openReports();
		const ends = await tab("Unsuccessful ends");
		expect(within(ends).getByText("Build errors")).toBeInTheDocument();
		expect(within(ends).queryByText("Abandoned")).toBeNull();
	});
});
