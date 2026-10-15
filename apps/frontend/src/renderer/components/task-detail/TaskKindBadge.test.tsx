import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types/task";
import { TaskKindBadge } from "./TaskKindBadge";

const persistUpdateTask = vi.fn();
vi.mock("../../stores/task-store", () => ({
	persistUpdateTask: (...args: unknown[]) => persistUpdateTask(...args),
	useTaskStore: vi.fn(),
}));
vi.mock("../../hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

function task(metadata: Task["metadata"]): Task {
	return { id: "t1", title: "x", description: "", metadata } as unknown as Task;
}

describe("TaskKindBadge", () => {
	beforeEach(() => persistUpdateTask.mockReset());

	it("renders nothing without a kind", () => {
		const { container } = render(<TaskKindBadge task={task({})} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the kind, and says when it is only a proposal", () => {
		render(
			<TaskKindBadge
				task={task({ kind: "feature", kindConfidence: 0.3, kindSource: "default" })}
			/>,
		);
		expect(screen.getByText("kind.values.feature")).toBeInTheDocument();
		expect(screen.getByText("(kind.proposed)")).toBeInTheDocument();
	});

	it("does not call a confident verdict a proposal", () => {
		render(
			<TaskKindBadge
				task={task({ kind: "bug_fix", kindConfidence: 0.9, kindSource: "category" })}
			/>,
		);
		expect(screen.queryByText("(kind.proposed)")).not.toBeInTheDocument();
	});

	it("persists the user's choice with kindSource user", async () => {
		persistUpdateTask.mockResolvedValue(true);
		render(
			<TaskKindBadge
				task={task({ kind: "bug_fix", kindConfidence: 0.75, kindSource: "keywords" })}
				editable
			/>,
		);
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "hotfix" } });
		expect(persistUpdateTask).toHaveBeenCalledWith("t1", {
			metadata: { kind: "hotfix", kindSource: "user", kindConfidence: 1 },
		});
	});

	it("does nothing when the same kind is picked again", () => {
		render(
			<TaskKindBadge task={task({ kind: "run", kindSource: "user" })} editable />,
		);
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "run" } });
		expect(persistUpdateTask).not.toHaveBeenCalled();
		expect(screen.getByText("(kind.chosen)")).toBeInTheDocument();
	});
});
