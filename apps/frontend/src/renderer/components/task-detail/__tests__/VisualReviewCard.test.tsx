/**
 * @vitest-environment jsdom
 */

/**
 * VisualReviewCard — what the captures of the running app showed, by OCR.
 *
 * Pinned: the card says nothing when the task has no capture; captures not
 * read yet offer the reading; findings, the base → task diff and the mockup
 * coverage are rendered from the record; screen text is rendered as text.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Task } from "../../../../shared/types";
import type {
	VisualQaPayload,
	VisualQaRecord,
} from "../../../lib/agent-tools-api";

const mockFetch = vi.fn();
const mockRun = vi.fn();

vi.mock("../../../lib/agent-tools-api", () => ({
	fetchVisualQa: (...args: unknown[]) => mockFetch(...args),
	runVisualQa: (...args: unknown[]) => mockRun(...args),
	saveCapture: vi.fn(),
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && "count" in options ? `${key}:${options.count}` : key,
	}),
}));

import { useDocintelVisualStore } from "../../../stores/docintel-visual-store";
import { captureSide } from "../TaskEmulator";
import { VisualReviewCard } from "../VisualReviewCard";

const task = { id: "t1", specId: "001-orders" } as unknown as Task;

const capture = {
	path: "captures/task/web--orders--fr.png",
	origin: "spec" as const,
	side: "task" as const,
	platform: "web" as const,
	route: "/orders",
	locale: "fr",
	source: "emulator",
	label: "",
	key: "web|orders|fr",
};

const record: VisualQaRecord = {
	captures: [capture],
	findings: [
		{
			kind: "untranslated-key",
			severity: "medium",
			text: "orders:export.title",
			detail: "",
			capture: capture.path,
		},
		{
			kind: "crash",
			severity: "high",
			text: "<img src=x onerror=alert(1)>",
			detail: "",
			capture: "captures/task/android--home.png",
		},
	],
	diffs: [
		{
			key: "web|orders|fr",
			route: "/orders",
			locale: "fr",
			platform: "web",
			base: "captures/base/web--orders--fr.png",
			task: capture.path,
			changed: [{ before: "Annuler", after: "Annuler la commande", similarity: 0.6 }],
			added: ["Exporter"],
			removed: [],
			unchanged: 2,
		},
	],
	mockups: [
		{
			source: "attachments/maquette.figma.json",
			kind: "figma",
			status: "compared",
			frame: "Orders",
			capture: capture.path,
			coverage: 0.5,
			matched: 1,
			total: 2,
			missing: ["Exporter en CSV"],
		},
	],
	skipped: "",
	generated_at: "2026-09-26T10:00:00+00:00",
};

function answer(payload: Partial<VisualQaPayload>) {
	return {
		ok: true as const,
		data: {
			record: null,
			counts: null,
			captures: [],
			pending: 0,
			...payload,
		},
	};
}

describe("VisualReviewCard", () => {
	beforeEach(() => {
		mockFetch.mockReset();
		mockRun.mockReset();
		useDocintelVisualStore.setState({ byTask: {} });
	});

	it("renders nothing when the task has no capture", async () => {
		mockFetch.mockResolvedValue(answer({}));
		const { container } = render(
			<VisualReviewCard task={task} projectPath="/p" />,
		);
		await waitFor(() => expect(mockFetch).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});

	it("offers to read captures that are waiting", async () => {
		mockFetch.mockResolvedValue(answer({ captures: [capture], pending: 1 }));
		mockRun.mockResolvedValue(
			answer({
				record,
				captures: [capture],
				counts: { high: 1, medium: 1, low: 0 },
			}),
		);
		render(<VisualReviewCard task={task} projectPath="/p" />);
		const read = await screen.findByText("tasks:visualReview.read");
		expect(screen.getByText("tasks:visualReview.notRead")).toBeInTheDocument();
		fireEvent.click(read);
		await waitFor(() =>
			expect(mockRun).toHaveBeenCalledWith(
				{ projectDir: "/p", specId: "001-orders" },
				expect.anything(),
			),
		);
		expect(await screen.findByText("tasks:visualReview.badge.high:1")).toBeInTheDocument();
	});

	it("shows findings, the base → task diff and the mockup coverage", async () => {
		mockFetch.mockResolvedValue(
			answer({
				record,
				captures: [capture],
				counts: { high: 1, medium: 1, low: 0 },
			}),
		);
		render(<VisualReviewCard task={task} projectPath="/p" />);
		fireEvent.click(await screen.findByText("tasks:visualReview.expand"));

		expect(screen.getByText("orders:export.title")).toBeInTheDocument();
		expect(screen.getByText("tasks:visualReview.kind.crash")).toBeInTheDocument();
		// Screen text is data: rendered as text, never as markup.
		expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
		expect(document.querySelector("img")).toBeNull();
		expect(screen.getByText("Annuler la commande")).toBeInTheDocument();
		expect(screen.getByText("Exporter")).toBeInTheDocument();
		expect(screen.getByText("Exporter en CSV")).toBeInTheDocument();
		expect(screen.queryByText("tasks:visualReview.read")).not.toBeInTheDocument();
	});
});

describe("captureSide", () => {
	it("is the task when the server runs in the task's worktree", () => {
		expect(
			captureSide(
				"/repo/.workpilot/worktrees/tasks/001-orders/src/Api",
				"/repo/.workpilot/worktrees/tasks/001-orders",
			),
		).toBe("task");
	});

	it("is the base branch when it runs in the repository itself", () => {
		expect(
			captureSide("/repo/src/Api", "/repo/.workpilot/worktrees/tasks/001-orders"),
		).toBe("base");
		expect(captureSide("/repo/src/Api", null)).toBe("base");
	});
});
