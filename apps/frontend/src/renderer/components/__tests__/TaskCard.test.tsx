/**
 * TaskCard — the Kanban card. Rendered with the real stores; only the IPC
 * bridge is a stand-in, so each test asserts what the person sees and which
 * main-process call a click makes.
 */

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../__tests__/helpers/renderer-api";
import {
	JSON_ERROR_PREFIX,
	JSON_ERROR_TITLE_SUFFIX,
} from "../../../shared/constants";
import type { Task, TaskStatus } from "../../../shared/types";
import i18n from "../../../shared/i18n";
import { consumePendingTaskDetailTab } from "../../lib/task-detail-nav";
import { useAbandonRequestStore } from "../../stores/abandon-request-store";
import { useFlagRequestStore } from "../../stores/flag-request-store";
import { useKanbanBlockerStore } from "../../stores/kanban-blocker-store";
import { useKanbanConflictStore } from "../../stores/kanban-conflict-store";
import { useProjectStore } from "../../stores/project-store";
import { useSmartEstimationStore } from "../../stores/smart-estimation-store";
import { resetHoverPreviewWarmthForTests } from "../../hooks/useHoverPreview";
import { recordTaskActivity, useTaskStore } from "../../stores/task-store";
import { TaskCard } from "../TaskCard";
import { Toaster } from "../ui/toaster";
import { TooltipProvider } from "../ui/tooltip";
import { pickSubmenuItem } from "../../../__tests__/helpers/menus";
import { useSprintStore } from "../../stores/sprint-store";

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "task-1",
		specId: "001-card",
		projectId: "project-1",
		title: "Add login page",
		description: "Build the **login** form",
		status: "backlog" as TaskStatus,
		subtasks: [],
		logs: [],
		createdAt: new Date("2026-11-01T10:00:00Z"),
		updatedAt: new Date("2026-11-01T10:00:00Z"),
		...overrides,
	} as Task;
}

type CardProps = Parameters<typeof TaskCard>[0];

function renderCard(props: Partial<CardProps> & { task: Task }) {
	const onClick = props.onClick ?? vi.fn();
	const utils = render(
		<TooltipProvider>
			<TaskCard onClick={onClick} {...props} />
		</TooltipProvider>,
	);
	return { ...utils, onClick };
}

/** A card that follows the task store, as the Kanban column does. */
function StoreCard({ id, ...rest }: Omit<CardProps, "task"> & { id: string }) {
	const task = useTaskStore((s) => s.tasks.find((t) => t.id === id));
	if (!task) return null;
	return <TaskCard task={task} {...rest} />;
}

let api: RendererApi;

beforeAll(() => {
	// jsdom has no IntersectionObserver; the progress bar only uses it to
	// pause its animation off screen.
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe = vi.fn();
			disconnect = vi.fn();
			unobserve = vi.fn();
		},
	);
});

beforeEach(() => {
	api = installRendererApi();
	useTaskStore.setState({ tasks: [], pipelineStatuses: {}, jumpToTaskId: null });
	useProjectStore.setState({
		projects: [
			{
				id: "project-1",
				name: "Demo",
				path: "/work/demo",
				autoBuildPath: "",
				settings: {},
				createdAt: new Date(),
				updatedAt: new Date(),
			} as never,
		],
	});
	useKanbanConflictStore.setState({ conflicts: {} });
	useKanbanBlockerStore.setState({ blockers: {} });
});

afterEach(() => {
	vi.useRealTimers();
	api.restore();
});

describe("TaskCard — content", () => {
	it("shows the title, a plain-text description and the pending badge", () => {
		renderCard({ task: makeTask() });
		expect(
			screen.getByRole("heading", { name: "Add login page" }),
		).toBeInTheDocument();
		expect(screen.getByText("Build the login form")).toBeInTheDocument();
	});

	it("strips HTML from imported titles", () => {
		renderCard({
			task: makeTask({ title: "<div><b>Imported</b> story</div>" }),
		});
		expect(
			screen.getByRole("heading", { name: "Imported story" }),
		).toBeInTheDocument();
	});

	it("translates the JSON error markers of a broken plan", () => {
		renderCard({
			task: makeTask({
				title: `Broken${JSON_ERROR_TITLE_SUFFIX}`,
				description: `${JSON_ERROR_PREFIX}Unexpected token`,
				status: "human_review",
				reviewReason: "errors",
			}),
		});
		expect(
			screen.getByRole("heading", { name: "Broken (JSON Error)" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(/JSON Parse Error: Unexpected token/),
		).toBeInTheDocument();
		expect(screen.getByText("Has Errors")).toBeInTheDocument();
	});

	it("names the category and priority in the app language", async () => {
		await i18n.changeLanguage("fr");
		try {
			renderCard({
				task: makeTask({
					metadata: { category: "testing", priority: "high" } as never,
				}),
			});
			expect(screen.getByText("Tests")).toBeInTheDocument();
			expect(screen.getByText("Haute")).toBeInTheDocument();
		} finally {
			await i18n.changeLanguage("en");
		}
	});

	it("shows the metadata badges the card carries", () => {
		renderCard({
			task: makeTask({
				status: "queue",
				metadata: {
					category: "bug_fix",
					impact: "critical",
					complexity: "complex",
					priority: "urgent",
					securitySeverity: "high",
					tddMode: true,
					archivedAt: "2026-11-02T00:00:00Z",
					mobileTargets: ["android"],
				} as never,
				verification: { status: "pass", score: 92 } as never,
				crossReview: {
					verdict: "disagree",
					provider: "openai",
					model: "gpt",
					summary: "Missing test",
				} as never,
			}),
		});
		expect(screen.getByText("TDD")).toBeInTheDocument();
		expect(screen.getByText("Archived")).toBeInTheDocument();
		expect(screen.getByText("Verified · 92")).toBeInTheDocument();
		expect(screen.getByText("Cross review: disagrees")).toHaveAttribute(
			"title",
			"openai / gpt — Missing test",
		);
		expect(screen.getByText("High severity")).toBeInTheDocument();
		expect(screen.getByText("Android")).toBeInTheDocument();
	});

	it("shows a failed verification even on a card without metadata", () => {
		renderCard({
			task: makeTask({
				verification: { status: "fail", reason: "Blank page" } as never,
			}),
		});
		expect(screen.getByText("Verify failed")).toHaveAttribute(
			"title",
			"Blank page",
		);
	});

	it("opens the tracker work item from its badge", () => {
		renderCard({
			task: makeTask({
				metadata: {
					azureDevOpsIdentifier: "4242",
					azureDevOpsUrl: "https://dev.azure.com/org/_workitems/4242",
				} as never,
			}),
		});
		const badge = screen.getByTitle("Open in Azure DevOps");
		expect(within(badge).getByText("#4242")).toBeInTheDocument();
		fireEvent.click(badge);
		expect(api.fn("openExternal")).toHaveBeenCalledWith(
			"https://dev.azure.com/org/_workitems/4242",
		);
	});

	it("shows a Jira key without a link when the issue has no URL", () => {
		renderCard({
			task: makeTask({ metadata: { jiraIdentifier: "PROJ-7" } as never }),
		});
		fireEvent.click(screen.getByText("PROJ-7"));
		expect(api.fn("openExternal")).not.toHaveBeenCalled();
	});

	it("explains a plan conflict in its tooltip", async () => {
		const user = userEvent.setup();
		useKanbanConflictStore.setState({
			conflicts: { "task-1": { files: 3, titles: ["Other task"] } as never },
		});
		renderCard({ task: makeTask() });
		await user.hover(screen.getByText("Conflict 1"));
		expect(
			(await screen.findAllByText("Conflicts with: Other task")).length,
		).toBeGreaterThan(0);
		expect(screen.getAllByText("3 file(s) in common").length).toBeGreaterThan(0);
	});

	it("explains the prerequisites that hold a queued card back", async () => {
		const user = userEvent.setup();
		useKanbanBlockerStore.setState({
			blockers: {
				"task-1": {
					pending: [{ id: "b1", title: "Set up DB" }],
					missing: ["gone"],
					resolvedCount: 2,
				} as never,
			},
		});
		renderCard({ task: makeTask({ status: "queue" }) });
		await user.hover(screen.getByText("1 blocker"));
		expect(
			(
				await screen.findAllByText(
					"The queue will not start it until these prerequisites are done.",
				)
			).length,
		).toBeGreaterThan(0);
		expect(screen.getAllByText("• Set up DB").length).toBeGreaterThan(0);
		expect(
			screen.getAllByText("2 prerequisites already done.").length,
		).toBeGreaterThan(0);
		expect(
			screen.getAllByText(/1 prerequisite not found/).length,
		).toBeGreaterThan(0);
	});

	it("shows deleted prerequisites even on a card without metadata", async () => {
		const user = userEvent.setup();
		useKanbanBlockerStore.setState({
			blockers: {
				"task-1": { pending: [], missing: ["gone"], resolvedCount: 0 } as never,
			},
		});
		renderCard({ task: makeTask({ status: "backlog" }) });
		await user.hover(screen.getByText("Blockers"));
		expect(
			(await screen.findAllByText(/1 prerequisite not found/)).length,
		).toBeGreaterThan(0);
	});

	it("shows no blocker badge when nothing is pending or missing", () => {
		useKanbanBlockerStore.setState({
			blockers: {
				"task-1": { pending: [], missing: [], resolvedCount: 3 } as never,
			},
		});
		renderCard({ task: makeTask({ status: "backlog" }) });
		expect(screen.queryByText("Blockers")).toBeNull();
	});

	it("describes blockers as context outside the queue", async () => {
		const user = userEvent.setup();
		useKanbanBlockerStore.setState({
			blockers: {
				"task-1": { pending: [{ id: "b1", title: "Set up DB" }], missing: [], resolvedCount: 0 } as never,
			},
		});
		renderCard({ task: makeTask({ status: "backlog" }) });
		await user.hover(screen.getByText("1 blocker"));
		expect(
			(
				await screen.findAllByText(
					"This task declares prerequisites that are not finished.",
				)
			).length,
		).toBeGreaterThan(0);
	});

	it("explains the complexity estimate in its tooltip", async () => {
		const user = userEvent.setup();
		renderCard({
			task: makeTask({
				metadata: {
					smartEstimate: {
						complexityScore: 7,
						confidenceLevel: 0.84,
						qaIterations: 1.2,
						riskFactors: ["auth", "migration"],
					},
				} as never,
			}),
		});
		await user.hover(screen.getByText("Complexity 7"));
		expect(
			(await screen.findAllByText("Confidence: 84%")).length,
		).toBeGreaterThan(0);
		expect(
			screen.getAllByText("2 QA passes expected.").length,
		).toBeGreaterThan(0);
		expect(screen.getAllByText("• migration").length).toBeGreaterThan(0);
	});

	it("shows the live pipeline and relaunches the fix loop on a red build", async () => {
		let release: () => void = () => undefined;
		api = installRendererApi({
			fixRedBuild: vi.fn(
				() => new Promise<void>((resolve) => (release = resolve)),
			),
		});
		useTaskStore.setState({
			pipelineStatuses: {
				"task-1": {
					taskId: "task-1",
					state: "failed",
					buildNumber: "20261114.3",
					definitionName: "CI",
					webUrl: "https://ci/build/3",
				} as never,
			},
		});
		renderCard({ task: makeTask() });

		fireEvent.click(screen.getByText(/Pipeline 20261114\.3/));
		expect(api.fn("openExternal")).toHaveBeenCalledWith("https://ci/build/3");

		const repair = screen.getByRole("button", { name: /Repair build/ });
		fireEvent.click(repair);
		expect(api.fn("fixRedBuild")).toHaveBeenCalledWith("task-1");
		await waitFor(() => expect(repair).toBeDisabled());
		await act(async () => release());
		await waitFor(() => expect(repair).toBeEnabled());
	});

	it.each([
		["succeeded"],
		["partiallySucceeded"],
		["canceled"],
		["running"],
	])("shows a %s pipeline without a repair button", (state) => {
		useTaskStore.setState({
			pipelineStatuses: {
				"task-1": { taskId: "task-1", state, definitionName: "Nightly" } as never,
			},
		});
		renderCard({ task: makeTask() });
		fireEvent.click(screen.getByText(/Pipeline Nightly/));
		expect(api.fn("openExternal")).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("button", { name: /Repair build/ }),
		).not.toBeInTheDocument();
	});
});

describe("TaskCard — status badges", () => {
	it.each([
		["build_failed", "Red build"],
		["pr_created", "Open PR"],
		["done", "Complete"],
		["queue", "Pending"],
	] as const)("labels a %s card %s", (status, label) => {
		renderCard({ task: makeTask({ status, metadata: {} as never }) });
		expect(screen.getByText(label)).toBeInTheDocument();
	});

	it.each([
		["completed", "Completed"],
		["qa_rejected", "QA Issues"],
		["qa_unverified", "QA not verified"],
		["plan_review", "Approve Plan"],
		["stopped", "Stopped"],
	] as const)("explains a %s human review", (reviewReason, label) => {
		renderCard({
			task: makeTask({
				status: "human_review",
				reviewReason,
				subtasks: [{ id: "s1", title: "s", description: "", status: "completed" } as never],
			}),
		});
		expect(screen.getByText("Needs Review")).toBeInTheDocument();
		expect(screen.getAllByText(label).length).toBeGreaterThan(0);
	});

	it("reads Completed once the run reached its complete phase", () => {
		renderCard({
			task: makeTask({
				status: "human_review",
				reviewReason: "qa_rejected",
				executionProgress: { phase: "complete" } as never,
				subtasks: [{ id: "s1", title: "s", description: "", status: "completed" } as never],
			}),
		});
		expect(screen.getByText("Completed")).toBeInTheDocument();
		expect(screen.queryByText("QA Issues")).not.toBeInTheDocument();
	});

	it("shows the running phase instead of the status while the agent codes", () => {
		renderCard({
			task: makeTask({
				status: "in_progress",
				executionProgress: { phase: "coding", phaseProgress: 40 } as never,
			}),
		});
		expect(screen.queryByText("Running")).not.toBeInTheDocument();
		expect(screen.getByText("Coding")).toBeInTheDocument();
	});

	it("names the running phase in the app's language", async () => {
		const { rerender } = renderCard({
			task: makeTask({
				status: "ai_review",
				executionProgress: { phase: "qa_review", phaseProgress: 10 } as never,
			}),
		});
		expect(screen.getByText("Reviewing")).toBeInTheDocument();

		await act(async () => {
			await i18n.changeLanguage("fr");
		});
		try {
			rerender(
				<TooltipProvider>
					<TaskCard
						task={makeTask({
							status: "in_progress",
							executionProgress: { phase: "coding", phaseProgress: 40 } as never,
						})}
						onClick={vi.fn()}
					/>
				</TooltipProvider>,
			);
			expect(screen.getByText("Codage")).toBeInTheDocument();
			expect(screen.queryByText("Coding")).not.toBeInTheDocument();
		} finally {
			await i18n.changeLanguage("en");
		}
	});
});

describe("TaskCard — actions", () => {
	it("opens the task on click and on Enter", () => {
		const { onClick } = renderCard({ task: makeTask() });
		fireEvent.click(screen.getByRole("option"));
		fireEvent.keyDown(screen.getByRole("option"), { key: "Enter" });
		fireEvent.keyDown(screen.getByRole("option"), { key: " " });
		fireEvent.keyDown(screen.getByRole("option"), { key: "a" });
		expect(onClick).toHaveBeenCalledTimes(3);
	});

	it("starts a backlog task without opening it", () => {
		const { onClick } = renderCard({ task: makeTask() });
		fireEvent.click(screen.getByRole("button", { name: /Start/ }));
		expect(api.fn("startTask")).toHaveBeenCalledWith("task-1", undefined);
		expect(onClick).not.toHaveBeenCalled();
	});

	it("stops, pauses and watches a running task", async () => {
		renderCard({
			task: makeTask({ status: "in_progress" }),
		});
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(api.fn("stopTask")).toHaveBeenCalledWith("task-1");

		fireEvent.click(screen.getByRole("button", { name: "Pause" }));
		await waitFor(() =>
			expect(api.fn("invoke")).toHaveBeenCalledWith(
				"TASK_PAUSE",
				"task-1",
				undefined,
			),
		);
	});

	it("resumes a paused task from the card and from its menu", async () => {
		const user = userEvent.setup();
		renderCard({
			task: makeTask({
				status: "in_progress",
				metadata: { paused: { enabled: true } } as never,
			}),
		});
		await user.click(screen.getByRole("button", { name: "Resume" }));
		await waitFor(() =>
			expect(api.fn("invoke")).toHaveBeenCalledWith("TASK_RESUME", "task-1"),
		);

		await user.click(screen.getByRole("button", { name: "Task actions" }));
		await user.click(await screen.findByRole("menuitem", { name: "Resume" }));
		expect(api.fn("invoke")).toHaveBeenCalledTimes(2);
	});

	it("turns Pause into Resume once the task is paused (store update)", async () => {
		const task = makeTask({ status: "in_progress" });
		useTaskStore.setState({ tasks: [task] });
		render(
			<TooltipProvider>
				<StoreCard id="task-1" onClick={vi.fn()} />
			</TooltipProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Pause" }));
		expect(
			await screen.findByRole("button", { name: "Resume" }),
		).toBeInTheDocument();
	});

	it("pauses and stops the AI review from the card", async () => {
		renderCard({ task: makeTask({ status: "ai_review" }) });
		fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
		expect(api.fn("stopTask")).toHaveBeenCalledWith("task-1");
		fireEvent.click(screen.getByRole("button", { name: "Pause" }));
		await waitFor(() => expect(api.fn("invoke")).toHaveBeenCalled());
	});

	it("previews the app of a task under review", () => {
		const onPreviewApp = vi.fn();
		const { onClick } = renderCard({
			task: makeTask({
				status: "human_review",
				reviewReason: "completed",
				subtasks: [{ id: "s1", title: "s", description: "", status: "completed" } as never],
			}),
			onPreviewApp,
		});
		fireEvent.click(screen.getByTitle("Preview application"));
		expect(onPreviewApp).toHaveBeenCalled();
		expect(onClick).not.toHaveBeenCalled();
	});

	it("previews and archives a done task, and reloads the board", async () => {
		const onPreviewApp = vi.fn();
		renderCard({ task: makeTask({ status: "done" }), onPreviewApp });
		fireEvent.click(screen.getByTitle("Preview application"));
		expect(onPreviewApp).toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Archive" }));
		await waitFor(() =>
			expect(api.fn("archiveTasks")).toHaveBeenCalledWith(
				"project-1",
				["task-1"],
				undefined,
			),
		);
		await waitFor(() => expect(api.fn("getTasks")).toHaveBeenCalled());
	});

	it("logs an archive the main process refused", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		api = installRendererApi({
			archiveTasks: vi.fn(async () => ({ success: false, error: "locked" })),
		});
		renderCard({ task: makeTask({ status: "done" }) });
		fireEvent.click(screen.getByRole("button", { name: "Archive" }));
		await waitFor(() =>
			expect(error).toHaveBeenCalledWith(
				"[TaskCard] Failed to archive task:",
				"task-1",
				"locked",
			),
		);
		error.mockRestore();
	});

	it("opens the PR, its files and archives a task whose PR is open", async () => {
		const onViewPRFiles = vi.fn();
		const onPreviewApp = vi.fn();
		renderCard({
			task: makeTask({
				status: "pr_created",
				metadata: { prUrl: "https://github.com/o/r/pull/9" } as never,
			}),
			onViewPRFiles,
			onPreviewApp,
		});
		fireEvent.click(screen.getByTitle("Open pull request in browser"));
		expect(api.fn("openExternal")).toHaveBeenCalledWith(
			"https://github.com/o/r/pull/9",
		);
		fireEvent.click(screen.getByRole("button", { name: "View modified files" }));
		expect(onViewPRFiles).toHaveBeenCalledWith(
			"https://github.com/o/r/pull/9",
			"task-1",
		);
		fireEvent.click(screen.getByTitle("Preview application"));
		expect(onPreviewApp).toHaveBeenCalled();
		fireEvent.click(screen.getByTitle("Archive task"));
		await waitFor(() => expect(api.fn("archiveTasks")).toHaveBeenCalled());
	});

	it("does not offer to archive an archived done task", () => {
		renderCard({
			task: makeTask({
				status: "done",
				metadata: { prUrl: "https://x/pull/1", archivedAt: "2026-11-02" } as never,
			}),
		});
		expect(screen.queryByTitle("Archive task")).not.toBeInTheDocument();
	});

	it("resumes a human-review task that crashed before coding", () => {
		renderCard({ task: makeTask({ status: "human_review" }) });
		expect(screen.getByText("Needs Resume")).toBeInTheDocument();
		expect(screen.getByText("Incomplete")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Resume" }));
		expect(api.fn("startTask")).toHaveBeenCalledWith("task-1", undefined);
	});

	it("brings an abandoned task back from its banner", async () => {
		const { onClick } = renderCard({
			task: makeTask({ metadata: { abandoned: true } as never }),
		});
		expect(screen.getByText("Abandoned")).toBeInTheDocument();
		fireEvent.click(screen.getByTitle("Resume"));
		await waitFor(() =>
			expect(api.fn("updateTask")).toHaveBeenCalledWith(
				"task-1",
				expect.objectContaining({ metadata: expect.any(Object) }),
			),
		);
		expect(onClick).not.toHaveBeenCalled();
	});

	it("deletes from the corner button without opening the task", () => {
		const onDelete = vi.fn();
		const { onClick } = renderCard({ task: makeTask(), onDelete });
		fireEvent.click(screen.getByTitle("Delete"));
		expect(onDelete).toHaveBeenCalled();
		expect(onClick).not.toHaveBeenCalled();
	});

	it("ignores clicks and presses in the delete corner of the card", () => {
		const onDelete = vi.fn();
		const { onClick } = renderCard({ task: makeTask(), onDelete });
		const card = screen.getByRole("option");
		card.getBoundingClientRect = () =>
			({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect;
		const press = new MouseEvent("mousedown", {
			bubbles: true,
			cancelable: true,
			clientX: 190,
			clientY: 10,
		});
		card.dispatchEvent(press);
		expect(press.defaultPrevented).toBe(true);
		fireEvent.click(card, { clientX: 190, clientY: 10 });
		expect(onClick).not.toHaveBeenCalled();
		fireEvent.mouseDown(card, { clientX: 20, clientY: 80 });
		fireEvent.click(card, { clientX: 20, clientY: 80 });
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("selects the card from its checkbox without opening it", () => {
		const onToggleSelect = vi.fn();
		const { onClick } = renderCard({
			task: makeTask(),
			isSelectable: true,
			isSelected: false,
			onToggleSelect,
		});
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Select task: Add login page" }),
		);
		expect(onToggleSelect).toHaveBeenCalled();
		expect(onClick).not.toHaveBeenCalled();
		expect(screen.getByRole("option")).toHaveAttribute("aria-selected", "false");
	});

	it("opens the plan tab from the progress indicator", () => {
		const { onClick } = renderCard({
			task: makeTask({
				status: "in_progress",
				executionProgress: { phase: "coding" } as never,
				subtasks: [
					{ id: "s1", title: "one", description: "", status: "completed" },
					{ id: "s2", title: "two", description: "", status: "pending" },
				] as never,
			}),
		});
		fireEvent.click(screen.getByTitle("View implementation plan"));
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(consumePendingTaskDetailTab()).toBe("subtasks");
	});
});

describe("TaskCard — options menu", () => {
	it("estimates, duplicates, syncs and moves the task", async () => {
		const user = userEvent.setup();
		const onDuplicate = vi.fn();
		const onStatusChange = vi.fn();
		useSmartEstimationStore.getState().reset();
		renderCard({
			task: makeTask(),
			onDuplicate,
			onStatusChange,
		});

		const openMenu = async () =>
			user.click(screen.getByRole("button", { name: "Task actions" }));

		await openMenu();
		await user.click(
			await screen.findByRole("menuitem", { name: "Estimate complexity" }),
		);
		expect(useSmartEstimationStore.getState()).toMatchObject({
			isOpen: true,
			initialTaskDescription: "Build the **login** form",
			sourceTaskId: "task-1",
		});

		await openMenu();
		await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
		expect(onDuplicate).toHaveBeenCalled();

		await openMenu();
		await pickSubmenuItem(user, "Move to", "Queue");
		expect(onStatusChange).toHaveBeenCalledWith("queue");

		await openMenu();
		await user.click(
			await screen.findByRole("menuitem", { name: "Sync from branch" }),
		);
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
	});

	it("flags, lifts, abandons and resumes from its menu", async () => {
		const user = userEvent.setup();
		const openMenu = async () =>
			user.click(screen.getByRole("button", { name: "Task actions" }));
		const { unmount } = renderCard({ task: makeTask({ status: "in_progress" }) });
		await openMenu();
		await user.click(await screen.findByRole("menuitem", { name: "Flag as blocked…" }));
		expect(useFlagRequestStore.getState().ids).toEqual(["task-1"]);
		await openMenu();
		await user.click(await screen.findByRole("menuitem", { name: "Abandon…" }));
		expect(useAbandonRequestStore.getState().ids).toEqual(["task-1"]);
		unmount();
		useFlagRequestStore.getState().close();
		useAbandonRequestStore.getState().close();

		renderCard({
			task: makeTask({
				metadata: { flagged: true, flaggedReason: "waiting for QA", abandoned: true } as never,
			}),
		});
		expect(screen.getByText("waiting for QA")).toBeInTheDocument();
		await openMenu();
		expect(screen.queryByRole("menuitem", { name: "Flag as blocked…" })).toBeNull();
		await user.click(await screen.findByRole("menuitem", { name: "Remove flag" }));
		await waitFor(() =>
			expect(api.fn("updateTask")).toHaveBeenCalledWith("task-1", {
				metadata: expect.objectContaining({ flagged: false }),
			}),
		);
		await openMenu();
		await user.click(await screen.findByRole("menuitem", { name: "Resume" }));
		await waitFor(() =>
			expect(api.fn("updateTask")).toHaveBeenCalledWith("task-1", {
				metadata: expect.objectContaining({ abandoned: false }),
			}),
		);
	});

	it("pauses a running task from its menu", async () => {
		const user = userEvent.setup();
		renderCard({ task: makeTask({ status: "in_progress" }) });
		await user.click(screen.getByRole("button", { name: "Task actions" }));
		await user.click(await screen.findByRole("menuitem", { name: "Pause" }));
		await waitFor(() =>
			expect(api.fn("invoke")).toHaveBeenCalledWith(
				"TASK_PAUSE",
				"task-1",
				undefined,
			),
		);
	});

	it("still offers edit and estimate on a done card, not sync nor pause", async () => {
		const user = userEvent.setup();
		renderCard({ task: makeTask({ status: "done" }) });
		await user.click(screen.getByRole("button", { name: "Task actions" }));
		expect(await screen.findByRole("menuitem", { name: "Edit…" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Estimate complexity" })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Sync from branch" })).toBeNull();
		expect(screen.queryByRole("menuitem", { name: "Pause" })).toBeNull();
		expect(screen.queryByRole("menuitem", { name: "Move to" })).toBeNull();
	});
});

describe("TaskCard — stuck detection and spotlight", () => {
	it("flags a running task whose process died, then recovers it", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		api = installRendererApi({
			checkTaskRunning: vi.fn(async () => ({ success: true, data: false })),
			recoverStuckTask: vi.fn(async () => ({
				success: true,
				data: { message: "ok", autoRestarted: true },
			})),
		});
		renderCard({ task: makeTask({ id: "task-stuck", status: "in_progress" }) });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(61_000);
		});
		expect(await screen.findByText("Stuck")).toBeInTheDocument();
		expect(screen.getByText("Needs Recovery")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /Recover/ }));
		expect(api.fn("recoverStuckTask")).toHaveBeenCalledWith("task-stuck", {
			autoRestart: true,
		});
		await waitFor(() =>
			expect(screen.queryByText("Stuck")).not.toBeInTheDocument(),
		);
	});

	it("keeps a running task with recent activity out of the stuck state", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		renderCard({ task: makeTask({ id: "task-alive", status: "in_progress" }) });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(59_000);
			recordTaskActivity("task-alive");
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(api.fn("checkTaskRunning")).not.toHaveBeenCalled();
		expect(screen.queryByText("Stuck")).not.toBeInTheDocument();
	});

	it("scrolls to and lights up the card the office jumped to", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const scroll = vi.fn();
		HTMLElement.prototype.scrollIntoView = scroll;
		useTaskStore.setState({ jumpToTaskId: "task-1" });
		renderCard({ task: makeTask() });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(150);
		});
		expect(scroll).toHaveBeenCalled();
		expect(screen.getByRole("option").className).toContain("task-spotlight");
		expect(useTaskStore.getState().jumpToTaskId).toBeNull();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2300);
		});
		expect(screen.getByRole("option").className).not.toContain(
			"task-spotlight",
		);
	});
});

describe("TaskCard — re-render rules", () => {
	it("skips a render when only unrelated fields change, renders on the ones it shows", () => {
		const onClick = vi.fn();
		const base = makeTask({
			status: "queue",
			metadata: { model: "opus" } as never,
			subtasks: [{ id: "s1", title: "a", description: "", status: "pending" }] as never,
		});
		const { rerender } = render(
			<TooltipProvider>
				<TaskCard task={base} onClick={onClick} />
			</TooltipProvider>,
		);
		const again = (task: Task, extra: Partial<CardProps> = {}) =>
			rerender(
				<TooltipProvider>
					<TaskCard task={task} onClick={onClick} {...extra} />
				</TooltipProvider>,
			);

		// The parent re-renders with the very same props.
		const heading = screen.getByRole("heading", { name: "Add login page" });
		again(base);
		expect(screen.getByRole("heading", { name: "Add login page" })).toBe(heading);

		// A new object with the same visible fields: the card keeps its DOM.
		again({ ...base, logs: ["noise"] });
		expect(screen.getByRole("heading", { name: "Add login page" })).toBeInTheDocument();

		// A visible field changes: the card follows.
		again({ ...base, logs: ["noise"], title: "Renamed" });
		expect(screen.getByRole("heading", { name: "Renamed" })).toBeInTheDocument();

		// A subtask finishing changes the progress shown.
		again({
			...base,
			title: "Renamed",
			subtasks: [{ id: "s1", title: "a", description: "", status: "completed" }] as never,
		});
		expect(screen.getByText(/1\/1/)).toBeInTheDocument();

		// Becoming selectable shows the checkbox.
		again({ ...base, title: "Renamed" }, { isSelectable: true, isSelected: true });
		expect(screen.getByRole("checkbox")).toBeChecked();
	});

	it("calls the handlers of the latest render when the task did not change", () => {
		const task = makeTask({ status: "backlog" });
		const first = vi.fn();
		const { rerender } = render(
			<TooltipProvider>
				<TaskCard task={task} onClick={first} />
			</TooltipProvider>,
		);
		const latest = vi.fn();
		rerender(
			<TooltipProvider>
				<TaskCard task={task} onClick={latest} />
			</TooltipProvider>,
		);
		fireEvent.click(screen.getByRole("option"));

		// A new task object with the same visible fields, and a new handler.
		const newest = vi.fn();
		rerender(
			<TooltipProvider>
				<TaskCard task={{ ...task, logs: ["noise"] }} onClick={newest} />
			</TooltipProvider>,
		);
		fireEvent.click(screen.getByRole("option"));

		expect(first).not.toHaveBeenCalled();
		expect(latest).toHaveBeenCalledTimes(1);
		expect(newest).toHaveBeenCalledTimes(1);
	});

	it("drops the stuck watch once the task stops running", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const task = makeTask({ id: "task-stop", status: "in_progress" });
		const { rerender } = renderCard({ task });
		rerender(
			<TooltipProvider>
				<TaskCard task={{ ...task, status: "backlog" }} onClick={vi.fn()} />
			</TooltipProvider>,
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(61_000);
		});
		expect(api.fn("checkTaskRunning")).not.toHaveBeenCalled();
	});

	it("is not stuck when activity arrives while the process check is in flight", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		api = installRendererApi({
			checkTaskRunning: vi.fn(async () => {
				recordTaskActivity("task-race");
				return { success: true, data: false };
			}),
		});
		renderCard({ task: makeTask({ id: "task-race", status: "in_progress" }) });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(61_000);
		});
		expect(api.fn("checkTaskRunning")).toHaveBeenCalledWith("task-race");
		expect(screen.queryByText("Stuck")).not.toBeInTheDocument();
	});

	it("keeps the task closed while its sync dialog is open", async () => {
		const user = userEvent.setup();
		const { onClick } = renderCard({ task: makeTask(), onDuplicate: vi.fn() });
		await user.click(screen.getByRole("button", { name: "Task actions" }));
		await user.click(
			await screen.findByRole("menuitem", { name: "Sync from branch" }),
		);
		await screen.findByRole("dialog");
		fireEvent.click(
			screen.getByRole("option", { name: "Add login page", hidden: true }),
		);
		expect(onClick).not.toHaveBeenCalled();
	});

	it("shows no description paragraph and no reason badge it cannot name", () => {
		renderCard({
			task: makeTask({
				description: "",
				metadata: {} as never,
				status: "human_review",
				reviewReason: "unknown_reason" as never,
				subtasks: [{ id: "s1", title: "s", description: "", status: "completed" } as never],
			}),
		});
		expect(screen.getByText("Needs Review")).toBeInTheDocument();
		expect(screen.queryByText("Build the login form")).not.toBeInTheDocument();
	});

	it("previews the app during the AI review", () => {
		const onPreviewApp = vi.fn();
		renderCard({ task: makeTask({ status: "ai_review" }), onPreviewApp });
		fireEvent.click(screen.getByTitle("Preview application"));
		expect(onPreviewApp).toHaveBeenCalled();
	});
});

describe("TaskCard — fallbacks", () => {
	it("names a pipeline that reported neither build number nor definition", () => {
		useTaskStore.setState({
			pipelineStatuses: {
				"task-1": { taskId: "task-1", state: "running" } as never,
			},
		});
		renderCard({ task: makeTask() });
		expect(screen.getByText(/Pipeline CI/)).toHaveAttribute(
			"title",
			"Pipeline —  CI",
		);
	});

	it("names the CI provider in the pipeline tip when it is known", () => {
		useTaskStore.setState({
			pipelineStatuses: {
				"task-1": {
					taskId: "task-1",
					state: "succeeded",
					buildNumber: "42",
					definitionName: "Nightly",
					providerLabel: "Azure Pipelines",
				} as never,
			},
		});
		renderCard({ task: makeTask() });
		expect(screen.getByText(/Pipeline 42/)).toHaveAttribute(
			"title",
			"Azure Pipelines — Nightly 42",
		);
	});

	it.each([
		["agree", "Cross review OK"],
		["inconclusive", "Cross review: no verdict"],
	])("shows a %s cross review without a summary", (verdict, label) => {
		renderCard({
			task: makeTask({
				crossReview: { verdict, provider: "openai", model: "gpt" } as never,
			}),
		});
		expect(screen.getByText(label)).toHaveAttribute("title", "openai / gpt");
	});

	it("keeps a markup-only title rather than an empty heading", () => {
		renderCard({ task: makeTask({ title: "<br>" }) });
		expect(screen.getByRole("heading", { name: "<br>" })).toBeInTheDocument();
	});

	it("marks a card that came from the visual canvas", () => {
		renderCard({
			task: makeTask({ metadata: { sourceType: "visual-canvas" } as never }),
		});
		expect(screen.getByRole("option")).toHaveClass("visual-canvas-task");
	});

	it("shows the applied formula instead of the estimate call", () => {
		renderCard({
			task: makeTask({
				metadata: {
					appliedFormula: {
						provider: "anthropic",
						model: "claude-opus",
						effort: "high",
						expectedCostUsd: 0.4,
						successProbability: 0.8,
						perTokenBilled: true,
						appliedAt: "2026-11-01T10:00:00Z",
					},
				} as never,
			}),
		});
		expect(
			screen.getByTitle("Applied formula — click to change"),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Estimate" })).not.toBeInTheDocument();
	});

	it("estimates from the title when the description has no text", async () => {
		const user = userEvent.setup();
		renderCard({
			task: makeTask({ description: "<p></p>" }),
			onDuplicate: vi.fn(),
		});
		await user.click(screen.getByRole("button", { name: "Task actions" }));
		await user.click(
			await screen.findByRole("menuitem", { name: "Estimate complexity" }),
		);
		expect(useSmartEstimationStore.getState()).toMatchObject({
			initialTaskDescription: "Add login page",
		});
	});

	it("says why a stuck task could not be recovered and keeps it stuck", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		api = installRendererApi({
			checkTaskRunning: vi.fn(async () => ({ success: true, data: false })),
			recoverStuckTask: vi.fn(async () => ({
				success: false,
				error: "The worktree is locked",
			})),
		});
		render(
			<TooltipProvider>
				<TaskCard
					task={makeTask({ id: "task-locked", status: "in_progress" })}
					onClick={vi.fn()}
				/>
				<Toaster />
			</TooltipProvider>,
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(61_000);
		});
		fireEvent.click(await screen.findByRole("button", { name: /Recover/ }));

		expect(
			await screen.findByText("Could not recover the task"),
		).toBeInTheDocument();
		expect(screen.getByText("The worktree is locked")).toBeInTheDocument();
		expect(screen.getByText("Stuck")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Recover/ })).toBeEnabled();
	});
});

describe("TaskCard — type colour and hover preview", () => {
	beforeEach(() => resetHoverPreviewWarmthForTests());

	const cardOf = (title: string) =>
		screen.getByRole("option", { name: title });

	it("shows one type chip, resolved from the kind and the category", () => {
		renderCard({
			task: makeTask({
				metadata: {
					kind: "bug_fix",
					kindSource: "keywords",
					kindConfidence: 0.9,
					category: "bug_fix",
					securitySeverity: undefined,
				} as never,
			}),
		});
		const card = cardOf("Add login page");
		expect(card).toHaveAttribute("data-card-type", "bug");
		expect(card).not.toHaveAttribute("data-card-faded");
		expect(within(card).getAllByText("Bug")).toHaveLength(1);
		// The old category badge is gone: the type says it once.
		expect(within(card).queryByText("Bug Fix")).not.toBeInTheDocument();
	});

	it("draws a proposed type dashed and paler", () => {
		renderCard({
			task: makeTask({
				metadata: {
					kind: "spike",
					kindSource: "keywords",
					kindConfidence: 0.4,
				} as never,
			}),
		});
		const card = cardOf("Add login page");
		expect(card).toHaveAttribute("data-card-type", "spike");
		expect(card).toHaveAttribute("data-card-faded", "");
		const chip = card.querySelector("[data-card-type-chip]");
		expect(chip).toHaveClass("card-type-chip--proposed");
		expect(chip).toHaveAttribute(
			"title",
			"Spike / POC (proposed, confirm it in the task detail)",
		);
	});

	it("leaves a card with only a defaulted kind neutral", () => {
		renderCard({
			task: makeTask({
				metadata: {
					kind: "feature",
					kindSource: "default",
					kindConfidence: 0.3,
				} as never,
			}),
		});
		const card = cardOf("Add login page");
		expect(card).not.toHaveAttribute("data-card-type");
		expect(card.querySelector("[data-card-type-chip]")).toBeNull();
	});

	it("hatches a card blocked by an unfinished dependency", () => {
		useKanbanBlockerStore.setState({
			blockers: {
				"task-1": {
					pending: [{ id: "t0", title: "Schema first", status: "queue" }],
					resolvedCount: 0,
					missing: [],
				},
			},
		});
		renderCard({ task: makeTask({ metadata: { category: "feature" } as never }) });
		expect(cardOf("Add login page")).toHaveAttribute("data-card-blocked", "");
	});

	it("opens the preview after the pointer rests 700 ms on the card", () => {
		vi.useFakeTimers();
		useKanbanBlockerStore.setState({
			blockers: {
				"task-1": {
					pending: [{ id: "t0", title: "Schema first", status: "queue" }],
					resolvedCount: 0,
					missing: [],
				},
			},
		});
		renderCard({
			task: makeTask({
				description: "Build the login form with a remember-me box",
				metadata: {
					kind: "bug_fix",
					kindSource: "keywords",
					kindConfidence: 0.9,
					priority: "high",
					model: "opus",
				} as never,
			}),
		});
		const card = cardOf("Add login page");
		fireEvent.pointerMove(card);
		act(() => {
			vi.advanceTimersByTime(699);
		});
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
		act(() => {
			vi.advanceTimersByTime(1);
		});
		const tip = screen.getByRole("tooltip");
		expect(tip).toHaveTextContent("from the title");
		expect(tip).toHaveTextContent("Priority: High");
		expect(tip).toHaveTextContent("Waiting for: Schema first");
		expect(tip).toHaveTextContent("opus");

		// A press (a drag starts with one) closes it.
		fireEvent.pointerDown(card);
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("does not open over a button of the card", () => {
		vi.useFakeTimers();
		renderCard({ task: makeTask({ metadata: { category: "feature" } as never }) });
		const card = cardOf("Add login page");
		const button = within(card).getAllByRole("button")[0];
		fireEvent.pointerMove(button);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("closes shortly after the pointer leaves", () => {
		vi.useFakeTimers();
		renderCard({ task: makeTask({ metadata: { category: "docs" } as never }) });
		const card = cardOf("Add login page");
		fireEvent.pointerMove(card);
		act(() => {
			vi.advanceTimersByTime(700);
		});
		expect(screen.getByRole("tooltip")).toBeInTheDocument();
		fireEvent.pointerLeave(card);
		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});
});

describe("TaskCard — right-click menu and quick edits", () => {
	const cardOf = (title = "Add login page") =>
		screen.getByRole("option", { name: title });
	const menu = () => screen.getByRole("menu", { name: "Task menu" });

	function saving() {
		api.restore();
		api = installRendererApi({
			updateTask: vi.fn(async (_id: string, updates: { metadata?: object }) => ({
				success: true,
				data: { ...makeTask(), metadata: updates.metadata },
			})),
		});
	}

	it("opens at the pointer and opens the card", async () => {
		const user = userEvent.setup();
		const { onClick } = renderCard({ task: makeTask() });
		fireEvent.contextMenu(cardOf(), { clientX: 40, clientY: 60 });
		expect(menu()).toBeInTheDocument();
		const anchor = document.querySelector<HTMLElement>("[data-pointer-menu-anchor]");
		expect(anchor?.style.left).toBe("40px");
		expect(anchor?.style.top).toBe("60px");
		// A click in the menu does not reach the card under it…
		fireEvent.click(menu());
		expect(onClick).not.toHaveBeenCalled();
		// …and a right-click in it opens no second menu.
		fireEvent.contextMenu(screen.getByRole("menuitem", { name: "Open" }));
		expect(screen.getAllByRole("menu")).toHaveLength(1);
		await user.click(screen.getByRole("menuitem", { name: "Open" }));
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("opens near the card's corner from the keyboard", () => {
		renderCard({ task: makeTask() });
		fireEvent.contextMenu(cardOf());
		const anchor = document.querySelector<HTMLElement>("[data-pointer-menu-anchor]");
		expect(anchor?.style.left).toBe("8px");
		expect(anchor?.style.top).toBe("24px");
	});

	it("sets the type and the priority from their submenus", async () => {
		saving();
		const user = userEvent.setup();
		renderCard({ task: makeTask() });
		fireEvent.contextMenu(cardOf(), { clientX: 10, clientY: 10 });
		await pickSubmenuItem(user, "Type", "Bug");
		await waitFor(() =>
			expect(api.fn("updateTask")).toHaveBeenCalledWith("task-1", {
				metadata: { kind: "bug_fix", kindSource: "user" },
			}),
		);
		fireEvent.contextMenu(cardOf(), { clientX: 10, clientY: 10 });
		await pickSubmenuItem(user, "Priority", "High");
		await waitFor(() =>
			expect(api.fn("updateTask")).toHaveBeenCalledWith("task-1", {
				metadata: { priority: "high" },
			}),
		);
	});

	it("puts the card in a sprint, or back in the backlog, from its submenu", async () => {
		saving();
		useSprintStore.setState({
			projectId: "p",
			sprints: [{ id: "sp-0000000b", name: "Sprint 13", state: "planned", createdAt: "t" }],
		});
		const user = userEvent.setup();
		const { unmount } = renderCard({ task: makeTask() });
		fireEvent.contextMenu(cardOf(), { clientX: 10, clientY: 10 });
		await pickSubmenuItem(user, "Sprint", "Sprint 13");
		await waitFor(() =>
			expect(api.fn("updateTask")).toHaveBeenCalledWith("task-1", { metadata: { sprintId: "sp-0000000b" } }),
		);
		unmount();
		renderCard({ task: makeTask({ metadata: { sprintId: "sp-0000000b" } as never }) });
		fireEvent.contextMenu(cardOf(), { clientX: 10, clientY: 10 });
		await pickSubmenuItem(user, "Sprint", "Backlog (no sprint)");
		await waitFor(() => expect(api.fn("updateTask")).toHaveBeenCalledWith("task-1", { metadata: { sprintId: undefined } }));
	});

	it("saves nothing when the type or priority picked is the card's own", async () => {
		saving();
		const user = userEvent.setup();
		renderCard({
			task: makeTask({
				metadata: { kind: "bug_fix", kindSource: "user", priority: "high" } as never,
			}),
		});
		await user.click(screen.getByRole("button", { name: "Task actions" }));
		await pickSubmenuItem(user, "Type", "Bug");
		await user.click(screen.getByRole("button", { name: "Task actions" }));
		await pickSubmenuItem(user, "Priority", "High");
		expect(api.fn("updateTask")).not.toHaveBeenCalled();
	});

	it("says so when a change is not saved", async () => {
		const user = userEvent.setup();
		render(
			<TooltipProvider>
				<TaskCard task={makeTask()} onClick={vi.fn()} />
				<Toaster />
			</TooltipProvider>,
		);
		fireEvent.contextMenu(cardOf(), { clientX: 10, clientY: 10 });
		await pickSubmenuItem(user, "Priority", "Urgent");
		expect(
			await screen.findByText("The change could not be saved"),
		).toBeInTheDocument();
	});

	it("edits in a dialog whose clicks and keys stay in it", async () => {
		const user = userEvent.setup();
		const onDelete = vi.fn();
		const { onClick } = renderCard({ task: makeTask(), onDelete });
		fireEvent.contextMenu(cardOf(), { clientX: 10, clientY: 10 });
		await user.click(screen.getByRole("menuitem", { name: "Edit…" }));
		const dialog = await screen.findByRole("dialog");
		const field = within(dialog).getAllByRole("textbox")[0];
		fireEvent.keyDown(field, { key: " " });
		fireEvent.keyDown(field, { key: "Enter" });
		fireEvent.mouseDown(field);
		fireEvent.click(field);
		fireEvent.contextMenu(field);
		expect(onClick).not.toHaveBeenCalled();
		expect(onDelete).not.toHaveBeenCalled();
		expect(screen.queryByRole("menu")).toBeNull();
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("keeps the text, type and priority while an agent works on the card", async () => {
		renderCard({ task: makeTask({ status: "in_progress" }) });
		fireEvent.contextMenu(cardOf(), { clientX: 10, clientY: 10 });
		for (const name of ["Edit…", "Type", "Priority"]) {
			expect(screen.getByRole("menuitem", { name })).toHaveAttribute(
				"data-disabled",
			);
		}
		expect(screen.getByRole("menuitem", { name: "Pause" })).toBeInTheDocument();
	});

	it("resumes a paused card, deletes one and estimates from the title", async () => {
		const user = userEvent.setup();
		const onDelete = vi.fn();
		useSmartEstimationStore.getState().reset();
		renderCard({
			task: makeTask({
				status: "in_progress",
				description: "",
				metadata: { paused: { enabled: true } } as never,
			}),
			onDelete,
		});
		fireEvent.contextMenu(cardOf(), { clientX: 10, clientY: 10 });
		expect(screen.queryByRole("menuitem", { name: "Pause" })).toBeNull();
		await user.click(screen.getByRole("menuitem", { name: "Resume" }));
		await waitFor(() =>
			expect(api.fn("invoke")).toHaveBeenCalledWith("TASK_RESUME", "task-1"),
		);

		fireEvent.contextMenu(cardOf(), { clientX: 10, clientY: 10 });
		await user.click(screen.getByRole("menuitem", { name: "Estimate complexity" }));
		expect(useSmartEstimationStore.getState().initialTaskDescription).toBe(
			"Add login page",
		);

		fireEvent.contextMenu(cardOf(), { clientX: 10, clientY: 10 });
		await user.click(screen.getByRole("menuitem", { name: "Delete" }));
		expect(onDelete).toHaveBeenCalledTimes(1);
	});

	it("offers no sync for a card outside a known project", async () => {
		useProjectStore.setState({ projects: [] });
		renderCard({ task: makeTask() });
		fireEvent.contextMenu(cardOf(), { clientX: 10, clientY: 10 });
		expect(screen.getByRole("menuitem", { name: "Estimate complexity" })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Sync from branch" })).toBeNull();
	});

	it("keeps clicks in the sync dialog and in the ⋮ menu off the card", async () => {
		const user = userEvent.setup();
		const { onClick } = renderCard({ task: makeTask() });
		await user.click(screen.getByRole("button", { name: "Task actions" }));
		const actions = await screen.findByRole("menu");
		fireEvent.click(actions);
		fireEvent.contextMenu(actions);
		expect(screen.queryByRole("menu", { name: "Task menu" })).toBeNull();
		await user.click(screen.getByRole("menuitem", { name: "Sync from branch" }));
		fireEvent.click(await screen.findByRole("dialog"));
		expect(onClick).not.toHaveBeenCalled();
	});

	it("leaves Enter on one of its buttons to that button", () => {
		const { onClick } = renderCard({ task: makeTask() });
		const button = within(cardOf())
			.getAllByRole("button")
			.find((b) => b.getAttribute("aria-label") !== "Task actions");
		if (!button) throw new Error("the card has no button");
		fireEvent.keyDown(button, { key: "Enter" });
		expect(onClick).not.toHaveBeenCalled();
		fireEvent.keyDown(cardOf(), { key: "Enter" });
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});

describe("TaskCard — renaming in place", () => {
	const cardOf = (title = "Add login page") =>
		screen.getByRole("option", { name: title });
	const titleOf = () => screen.getByRole("heading", { name: "Add login page" });
	const box = () => screen.getByRole("textbox", { name: "Task title" });

	function saving() {
		api.restore();
		api = installRendererApi({
			updateTask: vi.fn(async (_id: string, updates: { title?: string }) => ({
				success: true,
				data: { ...makeTask(), ...updates },
			})),
		});
	}

	afterEach(() => vi.useRealTimers());

	it("renames on a double-click on the title, without opening the card", async () => {
		saving();
		vi.useFakeTimers();
		const { onClick } = renderCard({ task: makeTask() });
		fireEvent.click(titleOf(), { detail: 1 });
		fireEvent.click(titleOf(), { detail: 2 });
		act(() => vi.advanceTimersByTime(1000));
		expect(onClick).not.toHaveBeenCalled();
		expect(box()).toHaveValue("Add login page");
		// Clicks and presses in the box stay in it.
		fireEvent.click(box());
		fireEvent.doubleClick(box());
		fireEvent.pointerDown(box());
		fireEvent.mouseDown(box());
		expect(onClick).not.toHaveBeenCalled();
		fireEvent.change(box(), { target: { value: "  Add the login page " } });
		fireEvent.keyDown(box(), { key: "a" });
		fireEvent.keyDown(box(), { key: "Enter" });
		expect(api.fn("updateTask")).toHaveBeenCalledWith("task-1", {
			title: "Add the login page",
		});
		expect(screen.queryByRole("textbox", { name: "Task title" })).toBeNull();
		expect(document.activeElement).toBe(cardOf());
	});

	it("opens the card a moment after a single click on the title", () => {
		vi.useFakeTimers();
		const { onClick, unmount } = renderCard({ task: makeTask() });
		fireEvent.click(titleOf(), { detail: 1 });
		expect(onClick).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(300));
		expect(onClick).toHaveBeenCalledTimes(1);
		// A click still waiting when the card goes away opens nothing.
		fireEvent.click(titleOf(), { detail: 1 });
		unmount();
		act(() => vi.advanceTimersByTime(300));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("renames with F2; Escape, an empty or the same title change nothing", () => {
		saving();
		renderCard({ task: makeTask() });
		fireEvent.keyDown(cardOf(), { key: "F2" });
		fireEvent.change(box(), { target: { value: "Something else" } });
		fireEvent.keyDown(box(), { key: "Escape" });
		expect(document.activeElement).toBe(cardOf());
		fireEvent.keyDown(cardOf(), { key: "F2" });
		fireEvent.change(box(), { target: { value: "   " } });
		fireEvent.blur(box());
		fireEvent.keyDown(cardOf(), { key: "F2" });
		fireEvent.blur(box());
		expect(api.fn("updateTask")).not.toHaveBeenCalled();
	});

	it("saves when the box is left", async () => {
		saving();
		renderCard({ task: makeTask() });
		fireEvent.keyDown(cardOf(), { key: "F2" });
		fireEvent.change(box(), { target: { value: "Login page" } });
		fireEvent.blur(box());
		expect(api.fn("updateTask")).toHaveBeenCalledWith("task-1", { title: "Login page" });
	});

	it("says so when the title is not saved", async () => {
		render(
			<TooltipProvider>
				<TaskCard task={makeTask()} onClick={vi.fn()} />
				<Toaster />
			</TooltipProvider>,
		);
		fireEvent.keyDown(cardOf(), { key: "F2" });
		fireEvent.change(box(), { target: { value: "Login page" } });
		fireEvent.keyDown(box(), { key: "Enter" });
		await waitFor(() => expect(api.fn("updateTask")).toHaveBeenCalled());
		expect(
			await screen.findByText("The change could not be saved"),
		).toBeInTheDocument();
	});

	it("is not offered while an agent works on the card, nor on an error title", () => {
		const { onClick, unmount } = renderCard({
			task: makeTask({ status: "in_progress" }),
		});
		fireEvent.keyDown(cardOf(), { key: "F2" });
		fireEvent.click(titleOf(), { detail: 1 });
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("textbox", { name: "Task title" })).toBeNull();
		unmount();
		renderCard({ task: makeTask({ title: `Broken${JSON_ERROR_TITLE_SUFFIX}` }) });
		fireEvent.keyDown(screen.getByRole("option"), { key: "F2" });
		expect(screen.queryByRole("textbox", { name: "Task title" })).toBeNull();
	});
});
