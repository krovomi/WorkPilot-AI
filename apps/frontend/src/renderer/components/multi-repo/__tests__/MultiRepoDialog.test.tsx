/**
 * @vitest-environment jsdom
 *
 * The follow-up of a run: what it waits for, one row per repo in execution
 * order with its card, and Stop / Resume as the run allows.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MultiRepoOrchestration } from "../../../../shared/types";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => {
			const values = options
				? Object.entries(options)
						.filter(([name]) => name !== "defaultValue")
						.map(([, value]) => String(value))
				: [];
			return values.length > 0 ? `${key}(${values.join(",")})` : key;
		},
		i18n: { language: "en" },
	}),
}));
vi.mock("@/stores/project-store", () => ({
	useProjectStore: (select: (s: { projects: unknown[] }) => unknown) => select({ projects: [] }),
	loadProjects: vi.fn(),
}));
vi.mock("../../../stores/project-store", () => ({ loadProjects: vi.fn() }));

import { useMultiRepoStore } from "@/stores/multi-repo-store";
import { MultiRepoDialog } from "../MultiRepoDialog";

const stop = vi.fn();
const start = vi.fn();

function orchestration(over: Partial<MultiRepoOrchestration>): MultiRepoOrchestration {
	return {
		id: "001-add-auth",
		projectId: "p1",
		taskDescription: "Add auth",
		status: "executing",
		statusKey: "status.waitingOnRepo",
		statusRepo: "lib",
		running: true,
		repos: [],
		dependencyGraph: { nodes: [], edges: [] },
		executionOrder: ["lib", "app"],
		repoStates: [
			{ repo: "app", status: "pending", progress: 0 },
			{ repo: "lib", status: "needs_you", progress: 80, taskId: "001-lib-add-auth" },
		],
		breakingChanges: [],
		overallProgress: 40,
		createdAt: "",
		updatedAt: "",
		...over,
	};
}

function show(o: MultiRepoOrchestration) {
	useMultiRepoStore.setState({
		isDialogOpen: true,
		view: "detail",
		projectId: "p1",
		orchestrations: [o],
		activeId: o.id,
		error: null,
		start,
		stop,
	});
	render(<MultiRepoDialog />);
}

beforeEach(() => {
	stop.mockReset();
	start.mockReset();
});
afterEach(cleanup);

describe("MultiRepoDialog detail", () => {
	it("says what the run waits for and lists repos in execution order", () => {
		show(orchestration({}));
		expect(screen.getByText("multiRepo:status.waitingOnRepo(lib)")).toBeInTheDocument();
		const rows = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
		expect(rows[0]).toContain("lib");
		expect(rows[0]).toContain("multiRepo:execution.card(001-lib-add-auth)");
		expect(rows[1]).toContain("app");
		expect(rows[1]).toContain("multiRepo:execution.noCardYet");
	});

	it("offers Stop while running, nothing to resume", () => {
		show(orchestration({}));
		fireEvent.click(screen.getByText("multiRepo:dialog.stop"));
		expect(stop).toHaveBeenCalledWith("001-add-auth");
		expect(screen.queryByText("multiRepo:dialog.resume")).not.toBeInTheDocument();
	});

	it("offers Resume once stopped, and nothing once completed", () => {
		show(orchestration({ running: false, status: "stopped", statusKey: undefined }));
		fireEvent.click(screen.getByText("multiRepo:dialog.resume"));
		expect(start).toHaveBeenCalledWith("001-add-auth");
		cleanup();
		show(orchestration({ running: false, status: "completed", statusKey: undefined }));
		expect(screen.queryByText("multiRepo:dialog.resume")).not.toBeInTheDocument();
		expect(screen.queryByText("multiRepo:dialog.stop")).not.toBeInTheDocument();
	});
});
