/** @vitest-environment jsdom */
/**
 * Abandoning a task: the reason and the linked task are picked in the app's
 * Select, and only a duplicate or a replacement carries a link.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import type { Task } from "../../../../shared/types";
import { useTaskStore } from "../../../stores/task-store";
import { AbandonDialog } from "../AbandonDialog";

afterEach(cleanup);

async function pick(user: ReturnType<typeof userEvent.setup>, field: string, option: string) {
	screen.getByRole("combobox", { name: field }).focus();
	await user.keyboard("[ArrowDown]");
	await user.click(await screen.findByRole("option", { name: option }));
}

describe("AbandonDialog", () => {
	it("links the duplicate picked in the list, and nothing once 'not on the board' is picked", async () => {
		useTaskStore.setState({
			tasks: [
				{ id: "t1", title: "Leaving" },
				{ id: "t2", title: "Original" },
			] as unknown as Task[],
		});
		const onAbandon = vi.fn();
		render(
			<AbandonDialog
				open
				tasks={[{ id: "t1", title: "Leaving" }]}
				isAbandoning={false}
				onOpenChange={vi.fn()}
				onAbandon={onAbandon}
			/>,
		);
		const user = userEvent.setup();
		expect(screen.queryByRole("combobox", { name: "Duplicate of" })).toBeNull();
		await pick(user, "Why", "Duplicate");
		expect(screen.getByRole("combobox", { name: "Duplicate of" })).toHaveTextContent(
			"Not on the board",
		);
		await pick(user, "Duplicate of", "Original");
		await user.click(screen.getByRole("button", { name: "Abandon" }));
		expect(onAbandon).toHaveBeenLastCalledWith({
			reason: "",
			resolution: "duplicate",
			link: "t2",
		});

		await pick(user, "Duplicate of", "Not on the board");
		await user.click(screen.getByRole("button", { name: "Abandon" }));
		expect(onAbandon).toHaveBeenLastCalledWith({ reason: "", resolution: "duplicate" });
	});
});
