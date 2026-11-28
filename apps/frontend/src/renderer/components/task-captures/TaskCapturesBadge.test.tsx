/**
 * @vitest-environment jsdom
 *
 * The camera on a card: shown only when the task has screens, its state in
 * one word, and the first screen in the hover preview.
 */

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task, TaskCapturesSummary } from "../../../shared/types";
import { capturesState, sameCaptures } from "./captures-state";
import { TaskCapturesBadge, TaskCapturesPreview } from "./TaskCapturesBadge";
import { clearCaptureImageCache } from "./useCaptureImage";

const side = { available: true, status: "clean" as const, kinds: [], passes: [], replaced: 0, file: "captures/published/task/a.png" };
const summary = (patch: Partial<TaskCapturesSummary> = {}): TaskCapturesSummary => ({
	needed: true,
	reason: "ui-files",
	decidedBy: "default",
	uiFiles: [],
	publish: "auto",
	items: [
		{ key: "a", label: "Home", platform: "web", variant: "", route: "/", locale: "en", after: side, publishable: true },
		{ key: "b", label: "Cart", platform: "web", variant: "mobile", route: "/cart", locale: "en", after: side, publishable: true },
	],
	publishable: 2,
	withheld: 0,
	approved: false,
	...patch,
});
const task = (captures?: TaskCapturesSummary) =>
	({ id: "t1", specId: "001", title: "x", status: "done", subtasks: [], logs: [], captures }) as unknown as Task;

const getTaskCaptureImage = vi.fn();
Object.defineProperty(window, "electronAPI", { value: { getTaskCaptureImage }, writable: true });

beforeEach(async () => {
	await i18n.changeLanguage("fr");
	clearCaptureImageCache();
	getTaskCaptureImage.mockReset();
	getTaskCaptureImage.mockResolvedValue({ success: true, data: { base64: "AAAA", mimeType: "image/png" } });
});

describe("TaskCapturesBadge", () => {
	it("is absent without screens", () => {
		const { container } = render(<TaskCapturesBadge task={task()} />);
		expect(container).toBeEmptyDOMElement();
		render(<TaskCapturesBadge task={task(summary({ items: [] }))} />);
		expect(screen.queryByTestId("task-captures-badge")).not.toBeInTheDocument();
	});

	it("counts the screens and says where they stand", () => {
		render(<TaskCapturesBadge task={task(summary({ sync: { status: "published", reason: "", prUrl: "", hosted: 2, section: true } }))} />);
		const badge = screen.getByTestId("task-captures-badge");
		expect(badge).toHaveTextContent("2");
		expect(badge).toHaveAttribute("data-state", "published");
		expect(badge).toHaveAttribute("title", "2 captures · Dans la PR");
	});

	it("shows the first screen in the preview", async () => {
		render(<TaskCapturesPreview task={task(summary())} />);
		expect(await screen.findByRole("img")).toHaveAttribute("src", "data:image/png;base64,AAAA");
	});
});

describe("capturesState", () => {
	it("puts each case in one word", () => {
		expect(capturesState(summary({ publish: "never" }))).toBe("kept");
		expect(capturesState(summary({ publishable: 0 }))).toBe("withheld");
		expect(capturesState(summary({ publish: "review" }))).toBe("waiting");
		expect(capturesState(summary({ publish: "review", approved: true }))).toBe("ready");
		expect(capturesState(summary())).toBe("ready");
	});

	it("tells the card's memo when the badge changes", () => {
		const a = task(summary());
		expect(sameCaptures(a, task(summary()))).toBe(true);
		expect(sameCaptures(a, task(summary({ approved: true })))).toBe(false);
		expect(sameCaptures(a, task())).toBe(false);
	});
});
