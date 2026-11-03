/**
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import i18n from "../../../shared/i18n";
import type { TaskLogs } from "../../../shared/types";
import {
	TaskPhaseProgressBar,
	formatPhaseDuration,
} from "./TaskPhaseProgressBar";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const at = (minutesAgo: number) =>
	new Date(NOW - minutesAgo * 60_000).toISOString();

const LOGS: TaskLogs = {
	spec_id: "001",
	created_at: at(120),
	updated_at: at(0),
	phases: {
		planning: {
			phase: "planning",
			status: "completed",
			started_at: at(100),
			completed_at: at(70),
			entries: [],
		},
		coding: {
			phase: "coding",
			status: "completed",
			started_at: at(70),
			completed_at: at(30),
			entries: [],
		},
		validation: {
			phase: "validation",
			status: "active",
			started_at: at(30),
			completed_at: null,
			entries: [],
		},
	},
};

describe("TaskPhaseProgressBar", () => {
	it("draws one coloured segment per phase with its share", async () => {
		await i18n.changeLanguage("en");
		render(
			<TaskPhaseProgressBar progress={100} phaseLogs={LOGS} now={NOW} isRunning />,
		);
		const bar = screen.getByRole("progressbar");
		expect(bar).toHaveAttribute("aria-valuenow", "100");
		const segments = bar.querySelectorAll("[data-phase]");
		expect([...segments].map((s) => s.getAttribute("data-phase"))).toEqual([
			"planning",
			"coding",
			"validation",
		]);
		expect(segments[0]).toHaveClass("bg-phase-planning");
		expect(segments[1]).toHaveClass("bg-phase-coding");
		expect(segments[2]).toHaveClass("bg-phase-validation");
		expect((segments[1] as HTMLElement).style.width).toBe("40%");
		// Only the running phase shimmers.
		expect(segments[2]).toHaveClass("phase-segment-active");
		expect(segments[0]).not.toHaveClass("phase-segment-active");
		expect(screen.getByText("Planning")).toBeInTheDocument();
		expect(screen.getAllByText("30%")).toHaveLength(2);
		expect(screen.getByText("40%")).toBeInTheDocument();
		expect(screen.getByText("(40 min)")).toBeInTheDocument();
	});

	it("does not shimmer when the task is not running", () => {
		render(<TaskPhaseProgressBar progress={100} phaseLogs={LOGS} now={NOW} />);
		expect(
			screen.getByRole("progressbar").querySelector(".phase-segment-active"),
		).toBeNull();
	});

	it("shows only the phases reached, from the bands, without timing", async () => {
		await i18n.changeLanguage("fr");
		render(<TaskPhaseProgressBar progress={50} phaseLogs={null} />);
		const segments = screen
			.getByRole("progressbar")
			.querySelectorAll("[data-phase]");
		expect(segments).toHaveLength(2);
		expect(screen.getByText("Planification")).toBeInTheDocument();
		expect(screen.getByText("Codage")).toBeInTheDocument();
		expect(screen.queryByText("Validation")).not.toBeInTheDocument();
		expect(screen.getByText("40 %")).toBeInTheDocument();
		await i18n.changeLanguage("en");
	});

	it("renders an empty track at 0%", () => {
		render(<TaskPhaseProgressBar progress={0} phaseLogs={null} />);
		expect(
			screen.getByRole("progressbar").querySelectorAll("[data-phase]"),
		).toHaveLength(0);
		expect(screen.queryByRole("list")).not.toBeInTheDocument();
	});
});

describe("formatPhaseDuration", () => {
	it("picks seconds, minutes or hours", () => {
		expect(formatPhaseDuration(45_000, "en")).toBe("45 sec");
		expect(formatPhaseDuration(12 * 60_000, "en")).toBe("12 min");
		expect(formatPhaseDuration(60 * 60_000, "en")).toBe("1 hr");
		expect(formatPhaseDuration(65 * 60_000, "en")).toBe("1 hr 5 min");
	});
});
