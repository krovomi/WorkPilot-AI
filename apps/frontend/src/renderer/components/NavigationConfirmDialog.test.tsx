/**
 * @vitest-environment jsdom
 */
/**
 * Tests NavigationConfirmDialog — le choix proposé quand on quitte le Kanban
 * alors qu'une tâche tourne. Vérifie surtout la quatrième option, « continuer
 * en arrière-plan », et que chaque option est câblée sur son propre callback :
 * une inversion entre « arrière-plan » et « arrêter » perd le travail en cours.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import "../../shared/i18n";

import type { Task } from "../../shared/types";
import { NavigationConfirmDialog } from "./NavigationConfirmDialog";

function makeTask(title = "Testing feature"): Task {
	return { id: "task-1", title, metadata: {} } as unknown as Task;
}

function renderDialog(
	overrides: Partial<Parameters<typeof NavigationConfirmDialog>[0]> = {},
) {
	const handlers = {
		onBackground: vi.fn(),
		onContinue: vi.fn(),
		onStop: vi.fn(),
		onPause: vi.fn(),
	};
	render(
		<NavigationConfirmDialog
			open
			runningTask={makeTask()}
			{...handlers}
			{...overrides}
		/>,
	);
	return handlers;
}

describe("NavigationConfirmDialog", () => {
	it("propose les quatre options et nomme la tâche en cours", () => {
		renderDialog();

		expect(screen.getByText(/Testing feature/)).toBeInTheDocument();
		expect(
			screen.getByText("Continue in the background"),
		).toBeInTheDocument();
		expect(
			screen.getByText("Continue task"),
		).toBeInTheDocument();
		expect(screen.getByText("Pause task")).toBeInTheDocument();
		expect(screen.getByText("Stop task")).toBeInTheDocument();
	});

	it("chaque option déclenche son seul callback", () => {
		const handlers = renderDialog();

		fireEvent.click(screen.getByText("Continue in the background"));
		expect(handlers.onBackground).toHaveBeenCalledTimes(1);
		expect(handlers.onStop).not.toHaveBeenCalled();
		expect(handlers.onPause).not.toHaveBeenCalled();

		fireEvent.click(screen.getByText("Pause task"));
		expect(handlers.onPause).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByText("Stop task"));
		expect(handlers.onStop).toHaveBeenCalledTimes(1);
		expect(handlers.onBackground).toHaveBeenCalledTimes(1);
	});

	it("compte les tâches restantes au-delà de la première", () => {
		renderDialog({ runningCount: 3 });
		expect(screen.getByText(/and 2 more tasks/)).toBeInTheDocument();
	});

	it("n'affiche la case « ne plus demander » que si elle est pilotée", () => {
		const { unmount } = render(
			<NavigationConfirmDialog
				open
				runningTask={makeTask()}
				onBackground={vi.fn()}
				onContinue={vi.fn()}
				onStop={vi.fn()}
				onPause={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
		unmount();

		const onDontAskAgainChange = vi.fn();
		renderDialog({ dontAskAgain: false, onDontAskAgainChange });
		fireEvent.click(screen.getByRole("checkbox"));
		expect(onDontAskAgainChange).toHaveBeenCalledWith(true);
	});
});
