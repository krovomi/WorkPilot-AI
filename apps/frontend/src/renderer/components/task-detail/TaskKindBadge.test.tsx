/** @vitest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

// Focus the trigger before opening, as in ui/select.search.test.tsx: jsdom
// does not open a Radix Select from a synthetic pointer event.
async function pick(label: string) {
	const user = userEvent.setup();
	await user.tab();
	expect(screen.getByRole("combobox")).toHaveFocus();
	await user.keyboard("[ArrowDown]");
	await user.click(await screen.findByRole("option", { name: label }));
}

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
		await pick("kind.values.hotfix");
		await waitFor(() => expect(persistUpdateTask).toHaveBeenCalledWith("t1", {
			metadata: { kind: "hotfix", kindSource: "user", kindConfidence: 1 },
		}));
	});

	it("does nothing when the same kind is picked again", async () => {
		render(
			<TaskKindBadge task={task({ kind: "run", kindSource: "user" })} editable />,
		);
		await pick("kind.values.run");
		expect(persistUpdateTask).not.toHaveBeenCalled();
		expect(screen.getByText("(kind.chosen)")).toBeInTheDocument();
	});

	it("lists every kind in the themed Select, not a native <select>", async () => {
		const { container } = render(
			<TaskKindBadge task={task({ kind: "docs", kindSource: "user" })} editable />,
		);
		expect(container.querySelector("select:not([aria-hidden])")).toBeNull();
		const user = userEvent.setup();
		await user.tab();
		await user.keyboard("[ArrowDown]");
		const options = await screen.findAllByRole("option");
		expect(options).toHaveLength(10);
		expect(screen.getByRole("listbox")).toHaveClass("bg-card", "text-foreground");
	});
});
