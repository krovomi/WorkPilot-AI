import { assign, createMachine } from "xstate";
import type { ReviewReason } from "../types";

export interface TaskContext {
	reviewReason?: ReviewReason;
	error?: string;
}

export type TaskEvent =
	| { type: "PLANNING_STARTED" }
	| {
			type: "PLANNING_COMPLETE";
			hasSubtasks: boolean;
			subtaskCount: number;
			requireReviewBeforeCoding: boolean;
	  }
	| { type: "PLAN_APPROVED" }
	| { type: "CODING_STARTED"; subtaskId: string; subtaskDescription: string }
	| {
			type: "SUBTASK_COMPLETED";
			subtaskId: string;
			completedCount: number;
			totalCount: number;
	  }
	| { type: "ALL_SUBTASKS_DONE"; totalCount: number }
	| { type: "QA_STARTED"; iteration: number; maxIterations: number }
	| { type: "QA_PASSED"; iteration: number; testsRun: Record<string, unknown> }
	| {
			type: "QA_FAILED";
			iteration: number;
			issueCount: number;
			issues: string[];
	  }
	| { type: "QA_FIXING_STARTED"; iteration: number }
	| { type: "QA_FIXING_COMPLETE"; iteration: number }
	| { type: "PLANNING_FAILED"; error: string; recoverable: boolean }
	| {
			type: "CODING_FAILED";
			subtaskId: string;
			error: string;
			attemptCount: number;
	  }
	| { type: "QA_MAX_ITERATIONS"; iteration: number; maxIterations: number }
	| { type: "QA_AGENT_ERROR"; iteration: number; consecutiveErrors: number }
	| {
			type: "PROCESS_EXITED";
			exitCode: number;
			signal?: string;
			unexpected?: boolean;
	  }
	| { type: "USER_STOPPED"; hasPlan?: boolean }
	| { type: "USER_RESUMED" }
	| { type: "MARK_DONE" }
	| { type: "CREATE_PR" }
	| { type: "PR_CREATED"; prUrl: string };

export const taskMachine = createMachine(
	{
		id: "task",
		initial: "backlog",
		types: {} as {
			context: TaskContext;
			events: TaskEvent;
		},
		context: {
			reviewReason: undefined,
			error: undefined,
		},
		states: {
			backlog: {
				on: {
					PLANNING_STARTED: "planning",
					// Fallback: if coding starts from backlog (e.g., resumed task), go to coding
					CODING_STARTED: "coding",
					USER_STOPPED: "backlog",
				},
			},
			planning: {
				on: {
					PLANNING_COMPLETE: [
						{
							target: "plan_review",
							guard: "requiresReview",
							actions: "setReviewReasonPlan",
						},
						{ target: "coding", actions: "clearReviewReason" },
					],
					// Fallback: if CODING_STARTED arrives while in planning, transition to coding
					CODING_STARTED: { target: "coding", actions: "clearReviewReason" },
					// Fallback: if ALL_SUBTASKS_DONE arrives while in planning, go directly to qa_review
					ALL_SUBTASKS_DONE: "qa_review",
					// Fallback: if QA_STARTED arrives while in planning, go to qa_review
					QA_STARTED: "qa_review",
					// Fallback: if QA_PASSED arrives while in planning (entire build completed), go to human_review
					QA_PASSED: {
						target: "human_review",
						actions: "setReviewReasonCompleted",
					},
					PLANNING_FAILED: {
						target: "error",
						actions: ["setReviewReasonErrors", "setError"],
					},
					USER_STOPPED: [
						{
							target: "backlog",
							guard: "noPlanYet",
							actions: "clearReviewReason",
						},
						{ target: "human_review", actions: "setReviewReasonStopped" },
					],
					PROCESS_EXITED: {
						target: "error",
						guard: "unexpectedExit",
						actions: ["setReviewReasonErrors", "setError"],
					},
				},
			},
			plan_review: {
				on: {
					PLAN_APPROVED: { target: "coding", actions: "clearReviewReason" },
					USER_STOPPED: { target: "backlog", actions: "clearReviewReason" },
					PROCESS_EXITED: {
						target: "error",
						guard: "unexpectedExit",
						actions: ["setReviewReasonErrors", "setError"],
					},
				},
			},
			coding: {
				on: {
					QA_STARTED: "qa_review",
					// ALL_SUBTASKS_DONE means coder finished but QA hasn't started yet
					// Transition to qa_review - QA will emit QA_PASSED or QA_FAILED
					ALL_SUBTASKS_DONE: "qa_review",
					// Fallback: if QA_PASSED arrives while still in coding (missed QA_STARTED), go to human_review
					QA_PASSED: {
						target: "human_review",
						actions: "setReviewReasonCompleted",
					},
					CODING_FAILED: {
						target: "error",
						actions: ["setReviewReasonErrors", "setError"],
					},
					USER_STOPPED: {
						target: "human_review",
						actions: "setReviewReasonStopped",
					},
					PROCESS_EXITED: {
						target: "error",
						guard: "unexpectedExit",
						actions: ["setReviewReasonErrors", "setError"],
					},
				},
			},
			qa_review: {
				on: {
					QA_FAILED: "qa_fixing",
					QA_PASSED: {
						target: "human_review",
						actions: "setReviewReasonCompleted",
					},
					QA_MAX_ITERATIONS: {
						target: "error",
						actions: ["setReviewReasonErrors", "setError"],
					},
					QA_AGENT_ERROR: {
						target: "error",
						actions: ["setReviewReasonErrors", "setError"],
					},
					USER_STOPPED: {
						target: "human_review",
						actions: "setReviewReasonStopped",
					},
					PROCESS_EXITED: {
						target: "error",
						guard: "unexpectedExit",
						actions: ["setReviewReasonErrors", "setError"],
					},
				},
			},
			qa_fixing: {
				on: {
					QA_FIXING_COMPLETE: "qa_review",
					QA_FAILED: {
						target: "human_review",
						actions: "setReviewReasonQaRejected",
					},
					QA_PASSED: {
						target: "human_review",
						actions: "setReviewReasonCompleted",
					},
					QA_MAX_ITERATIONS: {
						target: "error",
						actions: ["setReviewReasonErrors", "setError"],
					},
					QA_AGENT_ERROR: {
						target: "error",
						actions: ["setReviewReasonErrors", "setError"],
					},
					USER_STOPPED: {
						target: "human_review",
						actions: "setReviewReasonStopped",
					},
					PROCESS_EXITED: {
						target: "error",
						guard: "unexpectedExit",
						actions: ["setReviewReasonErrors", "setError"],
					},
				},
			},
			human_review: {
				on: {
					CREATE_PR: "creating_pr",
					MARK_DONE: "done",
					USER_RESUMED: { target: "coding", actions: "clearReviewReason" },
					USER_STOPPED: { target: "backlog", actions: "clearReviewReason" },
				},
			},
			error: {
				on: {
					USER_RESUMED: { target: "coding", actions: "clearReviewReason" },
					USER_STOPPED: { target: "backlog", actions: "clearReviewReason" },
					MARK_DONE: "done",
					// Relaunching a failed task must re-enter the active pipeline.
					// Without these, a new agent run's PLANNING_STARTED/CODING_STARTED
					// is ignored (error is a settled state), the settled-state guard
					// drops all execution-progress events, and the frontend stays
					// frozen on the previous failure even though the backend is
					// actively re-running.
					PLANNING_STARTED: {
						target: "planning",
						actions: "clearReviewReason",
					},
					CODING_STARTED: {
						target: "coding",
						actions: "clearReviewReason",
					},
				},
			},
			creating_pr: {
				on: {
					PR_CREATED: "pr_created",
				},
			},
			pr_created: {
				on: {
					MARK_DONE: "done",
				},
			},
			done: {
				type: "final",
			},
		},
	},
	{
		guards: {
			requiresReview: ({ event }) =>
				event.type === "PLANNING_COMPLETE" &&
				event.requireReviewBeforeCoding === true,
			noPlanYet: ({ event }) =>
				event.type === "USER_STOPPED" && event.hasPlan === false,
			unexpectedExit: ({ event }) =>
				event.type === "PROCESS_EXITED" && event.unexpected === true,
		},
		actions: {
			setReviewReasonPlan: assign({ reviewReason: () => "plan_review" }),
			setReviewReasonCompleted: assign({ reviewReason: () => "completed" }),
			setReviewReasonStopped: assign({ reviewReason: () => "stopped" }),
			setReviewReasonQaRejected: assign({ reviewReason: () => "qa_rejected" }),
			setReviewReasonErrors: assign({ reviewReason: () => "errors" }),
			clearReviewReason: assign({
				reviewReason: () => undefined,
				error: () => undefined,
			}),
			// Every event that lands the task in `error` names the failure.
			//
			// Before, only PLANNING_FAILED and CODING_FAILED did — and those two
			// were the paths the backend never emitted. Every real failure
			// arrived as PROCESS_EXITED, QA_MAX_ITERATIONS or QA_AGENT_ERROR,
			// which set no message at all, so the card showed "Has Errors" and
			// the user had no way to learn what had gone wrong short of opening
			// the logs.
			setError: assign({
				error: ({ event }) => {
					switch (event.type) {
						case "PLANNING_FAILED":
						case "CODING_FAILED":
							return event.error;
						case "QA_MAX_ITERATIONS":
							return `QA gave up after ${event.maxIterations} review passes without approving the build.`;
						case "QA_AGENT_ERROR":
							return `The QA agent failed ${event.consecutiveErrors} time(s) in a row on review pass ${event.iteration}.`;
						case "PROCESS_EXITED":
							// The last resort: the backend stopped without saying
							// why. Naming the exit code is still strictly better
							// than an empty badge — it is what the user quotes when
							// asking for help.
							return `The build process exited unexpectedly with code ${event.exitCode}${
								event.signal ? ` (signal ${event.signal})` : ""
							}. See the task logs for the last output.`;
						default:
							return undefined;
					}
				},
			}),
		},
	},
);
