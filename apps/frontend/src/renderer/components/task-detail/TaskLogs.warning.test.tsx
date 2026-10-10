/**
 * @vitest-environment jsdom
 */
/**
 * A warning entry — a spec phase that stood a placeholder in for what its agent
 * did not produce — is rendered as a warning, not as plain text.
 */

import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Task, TaskLogs as TaskLogsType } from "../../../shared/types";
import { TaskLogs } from "./TaskLogs";

beforeEach(() => {
	HTMLElement.prototype.scrollTo = vi.fn();
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {
				/* Layout is simulated in jsdom. */
			}
			disconnect() {
				/* No browser observation to release. */
			}
		},
	);
});

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
	useProviderModelCatalog: () => ({ models: [] }),
}));

vi.mock("../../../shared/utils/providers", () => ({
	getStaticProviders: vi.fn().mockResolvedValue({ providers: [], status: {} }),
}));

const WARNING =
	"research: research.json is a placeholder: Research agent failed after retries";

function logsWithWarning(): TaskLogsType {
	const phase = (entries: unknown[] = []) => ({
		status: entries.length ? "completed" : "pending",
		entries,
	});
	return {
		phases: {
			planning: phase([
				{
					timestamp: "2026-10-10T12:00:00Z",
					type: "warning",
					content: WARNING,
					phase: "planning",
				},
			]),
			coding: phase(),
			validation: phase(),
		},
	} as unknown as TaskLogsType;
}

describe("TaskLogs — warning entries", () => {
	it("renders a warning as a warning row", () => {
		render(
			<TaskLogs
				task={{ id: "task-1", metadata: {} } as unknown as Task}
				phaseLogs={logsWithWarning()}
				isLoadingLogs={false}
				expandedPhases={new Set(["planning"])}
				isStuck={false}
				logsEndRef={createRef<HTMLDivElement>()}
				logsContainerRef={createRef<HTMLDivElement>()}
				onLogsScroll={vi.fn()}
				onTogglePhase={vi.fn()}
			/>,
		);

		const text = screen.getByText(WARNING);
		const row = text.closest("div");
		expect(row?.className).toContain("text-warning");
		expect(row?.className).toContain("bg-warning/10");
	});
});
