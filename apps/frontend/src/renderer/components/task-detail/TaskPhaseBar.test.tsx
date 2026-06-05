/**
 * @vitest-environment jsdom
 */
/**
 * Tests TaskPhaseBar — la barre de phase collante au-dessus des logs.
 *
 * Couvre le suivi de la phase en fonction du défilement (`currentPhase`) et le
 * repli sur la phase active lorsque l'utilisateur n'a pas encore défilé.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";
import type { TaskLogPhase, TaskLogs } from "../../../shared/types";
import { TaskPhaseBar } from "./TaskPhaseBar";

function makePhaseLogs(activePhase?: TaskLogPhase): TaskLogs {
	const phase = (name: TaskLogPhase) => ({
		status: name === activePhase ? "active" : "pending",
		entries: [],
	});
	return {
		phases: {
			planning: phase("planning"),
			coding: phase("coding"),
			validation: phase("validation"),
		},
	} as unknown as TaskLogs;
}

describe("TaskPhaseBar", () => {
	it("ne rend rien sans phaseLogs", () => {
		const { container } = render(<TaskPhaseBar phaseLogs={null} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("affiche la phase active quand aucune phase de défilement n'est fournie", () => {
		render(<TaskPhaseBar phaseLogs={makePhaseLogs("validation")} />);
		expect(screen.getByText("Validation")).toBeInTheDocument();
		expect(screen.getByText("Phase 3/3")).toBeInTheDocument();
	});

	it("privilégie la phase de défilement sur la phase active", () => {
		render(
			<TaskPhaseBar
				phaseLogs={makePhaseLogs("validation")}
				currentPhase="coding"
			/>,
		);
		expect(screen.getByText("Coding")).toBeInTheDocument();
		expect(screen.getByText("Phase 2/3")).toBeInTheDocument();
		expect(screen.queryByText("Validation")).not.toBeInTheDocument();
	});

	it("se replie sur la phase active quand currentPhase vaut null", () => {
		render(
			<TaskPhaseBar phaseLogs={makePhaseLogs("coding")} currentPhase={null} />,
		);
		expect(screen.getByText("Coding")).toBeInTheDocument();
		expect(screen.getByText("Phase 2/3")).toBeInTheDocument();
	});

	it("ne rend rien quand aucune phase active ni de défilement", () => {
		const { container } = render(
			<TaskPhaseBar phaseLogs={makePhaseLogs()} currentPhase={null} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
