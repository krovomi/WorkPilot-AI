/**
 * Tests unitaires pour PhaseProgressIndicator (mode tile).
 *
 * La card doit refléter le **travail réel** (avancement par sous-tâches, où
 * completed ET blocked comptent comme faits) et rester cohérente avec la pop-in
 * de détail — et NON gonfler vers la progression pondérée par phase
 * (`overallProgress`) qui saute dans la bande QA (80-95%) dès que la QA démarre.
 */
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Subtask } from "../../../shared/types";
import { PhaseProgressIndicator } from "../PhaseProgressIndicator";

vi.mock("motion/react", () => {
	const passthrough = new Proxy(
		{},
		{
			get: () => (props: Record<string, unknown>) => {
				const { children, ...rest } = props as { children?: unknown };
				return <div {...(rest as object)}>{children as never}</div>;
			},
		},
	);
	return {
		motion: passthrough,
		AnimatePresence: ({ children }: { children?: unknown }) => (
			<>{children as never}</>
		),
	};
});

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

beforeAll(() => {
	class MockIntersectionObserver {
		observe = vi.fn();
		disconnect = vi.fn();
		unobserve = vi.fn();
	}
	vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

const makeSubtasks = (completed: number, total: number): Subtask[] =>
	Array.from({ length: total }, (_, i) => ({
		id: `st-${i}`,
		title: `Subtask ${i}`,
		status: i < completed ? "completed" : "pending",
	})) as Subtask[];

describe("PhaseProgressIndicator — progression en mode tile", () => {
	it("affiche le travail réel (sous-tâches), pas overallProgress, en revue QA", () => {
		// 2/4 sous-tâches = 50%, même si le backend pondéré par phase est à 94%.
		render(
			<PhaseProgressIndicator
				phase="qa_review"
				subtasks={makeSubtasks(2, 4)}
				overallProgress={94}
				isRunning={false}
				hasActiveExecution={true}
			/>,
		);

		expect(screen.getByText("50%")).toBeInTheDocument();
		expect(screen.queryByText("94%")).not.toBeInTheDocument();
	});

	it("retombe sur l'avancement par sous-tâches hors exécution active", () => {
		render(
			<PhaseProgressIndicator
				phase="idle"
				subtasks={makeSubtasks(2, 4)}
				overallProgress={94}
				isRunning={false}
				hasActiveExecution={false}
			/>,
		);

		expect(screen.getByText("50%")).toBeInTheDocument();
		expect(screen.queryByText("94%")).not.toBeInTheDocument();
	});

	it("compte les sous-tâches blocked comme faites (100%)", () => {
		// 1 completed + 1 blocked sur 2 → build terminé → 100%.
		const subtasks = [
			{ id: "a", title: "A", status: "completed" },
			{ id: "b", title: "B", status: "blocked" },
		] as Subtask[];
		render(
			<PhaseProgressIndicator
				phase="qa_review"
				subtasks={subtasks}
				overallProgress={94}
				hasActiveExecution={true}
			/>,
		);

		expect(screen.getByText("100%")).toBeInTheDocument();
	});

	it("affiche l'avancement réel des sous-tâches pendant le codage", () => {
		// 1/4 = 25% : on ne gonfle pas vers overallProgress (60%).
		render(
			<PhaseProgressIndicator
				phase="coding"
				subtasks={makeSubtasks(1, 4)}
				overallProgress={60}
				isRunning={true}
			/>,
		);

		expect(screen.getByText("25%")).toBeInTheDocument();
		expect(screen.queryByText("60%")).not.toBeInTheDocument();
	});

	it("affiche le pourcentage global, pas la progression interne à la phase", () => {
		// Bug signalé : la carte lisait 15% (progression DANS la planification)
		// pendant que la pop-in lisait 3% (15% de la bande 0-20) pour la même
		// tâche au même instant. Une seule des deux répond à « où en est la
		// tâche ? », et c'est celle-là.
		render(
			<PhaseProgressIndicator
				phase="planning"
				subtasks={[]}
				phaseProgress={15}
				overallProgress={3}
				isRunning={true}
				hasActiveExecution={true}
			/>,
		);

		expect(screen.getByText("3%")).toBeInTheDocument();
		expect(screen.queryByText("15%")).not.toBeInTheDocument();
	});

	it("reconstitue le pourcentage global quand le backend n'a émis que la phase", () => {
		// Snapshot restauré / enregistrement ancien : sans overallProgress, la
		// carte doit convertir la progression de phase, pas l'afficher brute.
		render(
			<PhaseProgressIndicator
				phase="planning"
				subtasks={[]}
				phaseProgress={50}
				isRunning={true}
				hasActiveExecution={true}
			/>,
		);

		expect(screen.getByText("10%")).toBeInTheDocument();
		expect(screen.queryByText("50%")).not.toBeInTheDocument();
	});
});
