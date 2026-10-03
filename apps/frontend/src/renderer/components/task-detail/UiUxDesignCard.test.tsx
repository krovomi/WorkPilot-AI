/**
 * The ui-ux-pro-max card in the task panel.
 *
 * Nothing on a backend task — that is the point of deciding relevance once,
 * on the server. On a UI task: why, which design system, its swatches, and the
 * way to set the task aside (and back).
 */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task } from "../../../shared/types";

const mockFetch = vi.fn();
const mockOverride = vi.fn();

vi.mock("../../lib/agent-tools-api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/agent-tools-api")>()),
	fetchUiUxTask: (...args: unknown[]) => mockFetch(...args),
	setUiUxOverride: (...args: unknown[]) => mockOverride(...args),
}));

import { UiUxDesignCard } from "./UiUxDesignCard";

const task = { id: "t1", specId: "001-settings" } as unknown as Task;

function relevance(overrides: Record<string, unknown> = {}) {
	return {
		verdict: "ui",
		reason: "planned-ui-files",
		detail: "app/settings/page.tsx",
		plannedFiles: ["app/settings/page.tsx"],
		uiFiles: ["app/settings/page.tsx"],
		override: "auto",
		...overrides,
	};
}

function payload(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		data: {
			installed: true,
			reason: null,
			record: {
				status: "ready",
				relevance: relevance(),
				source: "generated",
				masterPath: "design-system/shop/MASTER.md",
				masterWritten: true,
				guide: "nextjs",
				toolkit: "nextjs",
				reasons: [],
			},
			forecast: null,
			design: {
				colors: [
					{ role: "Primary", hex: "#2563EB" },
					{ role: "Card", hex: "#FFFFFF" },
				],
				heading: "Plus Jakarta Sans",
				body: "Inter",
				style: "Glassmorphism",
			},
			...overrides,
		},
	};
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	mockFetch.mockReset();
	mockOverride.mockReset();
});

afterEach(cleanup);

it("renders nothing on a task that is not about the interface", async () => {
	mockFetch.mockResolvedValue(
		payload({
			record: null,
			design: null,
			forecast: relevance({ verdict: "not-ui", reason: "planned-no-ui-files" }),
		}),
	);
	const { container } = render(<UiUxDesignCard task={task} projectPath="/p" />);
	await waitFor(() => expect(mockFetch).toHaveBeenCalled());
	expect(container).toBeEmptyDOMElement();
});

it("shows why, which design system, and the primary swatch", async () => {
	mockFetch.mockResolvedValue(payload());
	render(<UiUxDesignCard task={task} projectPath="/p" />);
	expect(await screen.findByText("UI/UX design system")).toBeInTheDocument();
	expect(screen.getByText(/The plan touches the interface/)).toBeInTheDocument();
	expect(screen.getByText(/design-system\/shop\/MASTER\.md/)).toBeInTheDocument();
	expect(screen.getByText("#2563EB")).toBeInTheDocument();
	// Only the roles a person recognises at a glance are drawn.
	expect(screen.queryByText("#FFFFFF")).not.toBeInTheDocument();
});

it("sets the task aside, and offers the way back", async () => {
	mockFetch.mockResolvedValue(payload());
	mockOverride.mockResolvedValue(
		payload({
			record: {
				...payload().data.record,
				relevance: relevance({
					verdict: "not-ui",
					reason: "override-skip",
					override: "skip",
				}),
			},
		}),
	);
	render(<UiUxDesignCard task={task} projectPath="/p" />);
	fireEvent.click(await screen.findByText("Skip for this task"));
	await waitFor(() =>
		expect(mockOverride).toHaveBeenCalledWith(
			expect.objectContaining({ specId: "001-settings", projectDir: "/p" }),
			"skip",
		),
	);
	expect(await screen.findByText("Decide automatically")).toBeInTheDocument();
});
