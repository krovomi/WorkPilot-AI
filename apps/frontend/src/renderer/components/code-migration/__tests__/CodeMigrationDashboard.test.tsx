/**
 * The Code Migration page shows the plan the analysis made and hands it to the
 * Kanban task it creates; a free plan, or a plan analysed for another
 * description, is not handed over.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeMigrationResult } from "../../../../main/code-migration-service";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}|${JSON.stringify(options)}` : key,
		i18n: { language: "fr" },
	}),
}));

const createTask = vi.fn();
vi.mock("../../../stores/task-store", () => ({
	createTask: (...args: unknown[]) => createTask(...args),
}));

const project = { id: "p1", path: "/work/shop", name: "shop" };
vi.mock("../../../stores/project-store", () => ({
	useProjectStore: Object.assign(
		(select: (s: unknown) => unknown) => select({ getActiveProject: () => project }),
		{ getState: () => ({ getActiveProject: () => project }) },
	),
}));

import { useCodeMigrationStore } from "../../../stores/code-migration-store";
import { CodeMigrationDashboard } from "../CodeMigrationDashboard";

const DESCRIPTION = "Convert JavaScript files to TypeScript";

function result(status: "ready" | "unsupported", description = DESCRIPTION): CodeMigrationResult {
	const ready = status === "ready";
	return {
		status: "success",
		migration_description: description,
		dry_run: true,
		plan: {
			migration_id: ready ? "m1" : "fallback",
			description,
			source: "javascript, react",
			target: "typescript / typescript",
			...(ready
				? {
						risk_level: "medium",
						total_steps: 3,
						phases: [
							{ name: "Analysis", steps: ["Analyze Source Code Structure", "Assess Migration Risk"] },
							{ name: "JavaScript to TypeScript", steps: ["Add types"] },
							{ name: "Reporting", steps: [] },
						],
					}
				: { note: "not supported" }),
		},
		execution: { status: "dry_run", files_modified: 0 },
		summary: {
			migration_id: ready ? "m1" : "fallback",
			description,
			dry_run: true,
			plan_status: status,
			execution_status: "dry_run",
			files_modified: 0,
		},
	};
}

function show(value: CodeMigrationResult, description = DESCRIPTION) {
	useCodeMigrationStore.setState({
		phase: "complete",
		result: value,
		migrationDescription: description,
		error: null,
		streamingOutput: "",
	});
	render(<CodeMigrationDashboard />);
}

async function createTheTask() {
	await userEvent.click(screen.getByRole("button", { name: "codeMigration:actions.createTask" }));
	await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
	return createTask.mock.calls[0][2] as string;
}

describe("CodeMigrationDashboard", () => {
	beforeEach(() => {
		createTask.mockReset();
		createTask.mockResolvedValue({ id: "t1" });
		useCodeMigrationStore.getState().reset();
	});

	it("shows a known plan, its risk and its phases", () => {
		show(result("ready"));

		expect(screen.getByText(`codeMigration:risk.medium|{"defaultValue":"medium"}`)).toBeInTheDocument();
		expect(screen.getByText('codeMigration:results.plan|{"count":3}')).toBeInTheDocument();
		const plan = screen.getByTestId("code-migration-plan");
		expect(plan.querySelectorAll("li")).toHaveLength(3);
		expect(plan).toHaveTextContent("JavaScript to TypeScript · Add types");
		expect(plan).toHaveTextContent("Reporting");
	});

	it("hands the plan to the Kanban task", async () => {
		show(result("ready"));

		const body = await createTheTask();

		expect(body).toContain("codeMigration:task.plan");
		expect(body).toContain("1. Analysis: Analyze Source Code Structure; Assess Migration Risk");
		expect(body).toContain("2. JavaScript to TypeScript: Add types");
		expect(body).toMatch(/3\. Reporting$/);
	});

	it("shows no plan and hands none over for a free plan", async () => {
		show(result("unsupported"));

		expect(screen.queryByTestId("code-migration-plan")).not.toBeInTheDocument();
		expect(screen.queryByText("codeMigration:results.risk")).not.toBeInTheDocument();
		expect(await createTheTask()).not.toContain("codeMigration:task.plan");
	});

	it("does not hand over the plan of a description analysed before", async () => {
		show(result("ready"), "Convert the Java classes to Kotlin");

		expect(await createTheTask()).not.toContain("codeMigration:task.plan");
	});
});
