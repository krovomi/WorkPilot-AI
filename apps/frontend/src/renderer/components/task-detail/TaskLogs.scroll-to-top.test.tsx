/**
 * @vitest-environment jsdom
 */
/**
 * Tests du bouton flottant « remonter au début » de la popin de logs.
 *
 * Couvre la visibilité pilotée par le défilement et l'action de remontée
 * fluide vers le sommet du conteneur.
 */

import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Task, TaskLogs as TaskLogsType } from "../../../shared/types";
import { TaskLogs } from "./TaskLogs";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

vi.mock("../../stores/settings-store", () => ({
	useSettingsStore: (selector: (s: unknown) => unknown) =>
		selector({ settings: {}, profiles: [] }),
}));

vi.mock("../../stores/task-store", () => ({
	persistUpdateTask: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../hooks/use-toast", () => ({
	useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("../../hooks/useProviderModelCatalog", () => ({
	useProviderModelCatalog: () => ({
		models: [
			{ value: "llama3.3", label: "Llama 3.3", installed: true },
			{ value: "custom", label: "Custom" },
		],
	}),
}));

vi.mock("../../../shared/utils/providers", () => ({
	getStaticProviders: vi.fn().mockResolvedValue({ providers: [], status: {} }),
}));

function makePhaseLogs(): TaskLogsType {
	const phase = () => ({ status: "pending", entries: [] });
	return {
		phases: {
			planning: phase(),
			coding: phase(),
			validation: phase(),
		},
	} as unknown as TaskLogsType;
}

const baseTask = { id: "task-1", metadata: {} } as unknown as Task;

function renderLogs(containerRef: React.RefObject<HTMLDivElement | null>) {
	return render(
		<TaskLogs
			task={baseTask}
			phaseLogs={makePhaseLogs()}
			isLoadingLogs={false}
			expandedPhases={new Set()}
			isStuck={false}
			logsEndRef={createRef<HTMLDivElement>()}
			logsContainerRef={containerRef}
			onLogsScroll={vi.fn()}
			onTogglePhase={vi.fn()}
		/>,
	);
}

describe("TaskLogs — bouton remonter au début", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rend le bouton masqué tant que l'on est au sommet", () => {
		const ref = createRef<HTMLDivElement>();
		renderLogs(ref);

		const button = screen.getByLabelText("tasks:logs.scrollToTop");
		expect(button).toBeInTheDocument();
		expect(button.className).toContain("opacity-0");
		expect(button.className).toContain("pointer-events-none");
	});

	it("révèle le bouton après un défilement vers le bas", () => {
		const ref = createRef<HTMLDivElement>();
		renderLogs(ref);

		const container = ref.current as HTMLDivElement;
		fireEvent.mouseEnter(container.parentElement as HTMLElement);
		fireEvent.scroll(container, { target: { scrollTop: 300 } });

		const button = screen.getByLabelText("tasks:logs.scrollToTop");
		expect(button.className).toContain("opacity-100");
		expect(button.className).not.toContain("pointer-events-none");
	});

	it("garde le bouton masqué hors survol même après défilement", () => {
		const ref = createRef<HTMLDivElement>();
		renderLogs(ref);

		const container = ref.current as HTMLDivElement;
		fireEvent.scroll(container, { target: { scrollTop: 300 } });

		const button = screen.getByLabelText("tasks:logs.scrollToTop");
		expect(button.className).toContain("opacity-0");
		expect(button.className).toContain("pointer-events-none");
	});

	it("remonte le conteneur en douceur au clic", () => {
		const ref = createRef<HTMLDivElement>();
		renderLogs(ref);

		const container = ref.current as HTMLDivElement;
		container.scrollTo = vi.fn();
		fireEvent.scroll(container, { target: { scrollTop: 300 } });

		fireEvent.click(screen.getByLabelText("tasks:logs.scrollToTop"));
		expect(container.scrollTo).toHaveBeenCalledWith({
			top: 0,
			behavior: "smooth",
		});
	});

	it("remonte au début via la touche Origine (Home)", () => {
		const ref = createRef<HTMLDivElement>();
		renderLogs(ref);

		const container = ref.current as HTMLDivElement;
		container.scrollTo = vi.fn();
		fireEvent.keyDown(container, { key: "Home" });

		expect(container.scrollTo).toHaveBeenCalledWith({
			top: 0,
			behavior: "smooth",
		});
	});

	it("descend tout en bas via la touche Fin (End)", () => {
		const ref = createRef<HTMLDivElement>();
		renderLogs(ref);

		const container = ref.current as HTMLDivElement;
		Object.defineProperty(container, "scrollHeight", {
			configurable: true,
			value: 5000,
		});
		container.scrollTo = vi.fn();
		fireEvent.keyDown(container, { key: "End" });

		expect(container.scrollTo).toHaveBeenCalledWith({
			top: 5000,
			behavior: "smooth",
		});
	});

	it("révèle le bouton « aller en bas » loin de la fin et le masque au sommet", () => {
		const ref = createRef<HTMLDivElement>();
		renderLogs(ref);

		const container = ref.current as HTMLDivElement;
		Object.defineProperty(container, "scrollHeight", {
			configurable: true,
			value: 5000,
		});
		Object.defineProperty(container, "clientHeight", {
			configurable: true,
			value: 500,
		});

		const bottomButton = screen.getByLabelText("tasks:logs.scrollToBottom");
		expect(bottomButton.className).toContain("opacity-0");

		fireEvent.mouseEnter(container.parentElement as HTMLElement);
		fireEvent.scroll(container, { target: { scrollTop: 0 } });
		expect(bottomButton.className).toContain("opacity-100");
		expect(bottomButton.className).not.toContain("pointer-events-none");
	});

	it("descend tout en bas au clic sur le bouton dédié", () => {
		const ref = createRef<HTMLDivElement>();
		renderLogs(ref);

		const container = ref.current as HTMLDivElement;
		Object.defineProperty(container, "scrollHeight", {
			configurable: true,
			value: 5000,
		});
		Object.defineProperty(container, "clientHeight", {
			configurable: true,
			value: 500,
		});
		container.scrollTo = vi.fn();
		fireEvent.scroll(container, { target: { scrollTop: 0 } });

		fireEvent.click(screen.getByLabelText("tasks:logs.scrollToBottom"));
		expect(container.scrollTo).toHaveBeenCalledWith({
			top: 5000,
			behavior: "smooth",
		});
	});
});

describe("local model log status icons", () => {
	it.each(["⏳", "🧠", "📊", "⚠️"])("renders %s as SVG", (marker) => {
		const logs = makePhaseLogs();
		logs.phases.planning.entries = [
			{
				type: "info",
				content: `${marker} Local status`,
				timestamp: "2026-09-07T19:00:00Z",
			} as never,
		];
		const { container } = render(
			<TaskLogs
				task={baseTask}
				phaseLogs={logs}
				isLoadingLogs={false}
				expandedPhases={new Set(["planning"])}
				isStuck={false}
				logsEndRef={createRef<HTMLDivElement>()}
				logsContainerRef={createRef<HTMLDivElement>()}
				onLogsScroll={vi.fn()}
				onTogglePhase={vi.fn()}
			/>,
		);
		expect(container.textContent).toContain("Local status");
		expect(container.textContent).not.toContain(marker);
		expect(container.querySelector("svg.inline-block")).toBeTruthy();
	});
});

it("keeps custom input open when the select restores focus", async () => {
	HTMLElement.prototype.scrollIntoView = vi.fn();
	render(
		<TaskLogs
			task={{
				...baseTask,
				metadata: { provider: "ollama", model: "llama3.3" },
			}}
			phaseLogs={makePhaseLogs()}
			isLoadingLogs={false}
			expandedPhases={new Set()}
			isStuck={false}
			logsEndRef={createRef<HTMLDivElement>()}
			logsContainerRef={createRef<HTMLDivElement>()}
			onLogsScroll={vi.fn()}
			onTogglePhase={vi.fn()}
		/>,
	);
	const select = screen.getAllByLabelText("tasks:logs.model.selectAria")[0];
	fireEvent.keyDown(select, { key: "ArrowDown" });
	const option = await screen.findByRole("option", {
		name: "tasks:logs.model.customOption",
	});
	expect(option.textContent).not.toContain("tasks:logs.model.download");
	fireEvent.keyDown(option, { key: "Enter" });
	const input = await screen.findByLabelText("tasks:logs.model.customAria");
	fireEvent.blur(input);
	expect(input).toBeInTheDocument();
	fireEvent.keyDown(input, { key: "Escape" });
	expect(screen.queryByLabelText("tasks:logs.model.customAria")).toBeNull();
});
