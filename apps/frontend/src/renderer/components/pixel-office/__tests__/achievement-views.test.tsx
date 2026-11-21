import { act, fireEvent, render, screen } from "@testing-library/react";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../../shared/types/task";
import { ACHIEVEMENT_IDS } from "../../../lib/pixel-office-achievements";
import { AchievementsPanel } from "../AchievementsPanel";
import { ACHIEVEMENT_TOAST_MS, AchievementToast } from "../AchievementToast";
import { KioskOverlay } from "../KioskOverlay";
import { shippedToday } from "../office-stats";

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

describe("AchievementToast", () => {
	afterEach(() => vi.useRealTimers());

	it("announces an achievement politely and moves on by itself", () => {
		vi.useFakeTimers();
		const onDismiss = vi.fn();
		const { rerender } = render(
			<AchievementToast achievement="qa-first-try" onDismiss={onDismiss} calm={false} />,
		);
		expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
		expect(screen.getByText("Achievement unlocked")).toBeTruthy();
		expect(screen.getByText("Right the first time")).toBeTruthy();
		expect(screen.getByTestId("achievement-toast").className).toContain("animate-in");

		act(() => vi.advanceTimersByTime(ACHIEVEMENT_TOAST_MS));
		expect(onDismiss).toHaveBeenCalledTimes(1);

		rerender(<AchievementToast achievement="first-ship" onDismiss={onDismiss} calm />);
		expect(screen.getByTestId("achievement-toast").className).not.toContain("animate-in");
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(onDismiss).toHaveBeenCalledTimes(2);
	});

	it("shows nothing between achievements", () => {
		render(<AchievementToast achievement={undefined} onDismiss={vi.fn()} calm={false} />);
		expect(screen.queryByTestId("achievement-toast")).toBeNull();
	});

	it("says it in French too", async () => {
		await i18n.changeLanguage("fr");
		render(<AchievementToast achievement="second-opinion" onDismiss={vi.fn()} calm />);
		expect(screen.getByText("Succès débloqué")).toBeTruthy();
		expect(screen.getByText("Deuxième avis")).toBeTruthy();
	});
});

describe("AchievementsPanel", () => {
	it("counts what is earned and lists every achievement, earned or locked", () => {
		render(<AchievementsPanel unlocked={{ "first-ship": "2026-11-16T10:00:00Z" }} />);
		const trigger = screen.getByRole("button", { name: "Show the project's achievements" });
		expect(trigger.textContent).toContain(`1/${ACHIEVEMENT_IDS.length}`);

		fireEvent.click(trigger);
		expect(screen.getByText("Achievements")).toBeTruthy();
		expect(screen.getByTestId("achievement-first-ship").dataset.earned).toBe("true");
		expect(screen.getByTestId("achievement-first-ship").textContent).toContain("Earned on");
		expect(screen.getByTestId("achievement-ten-ships-week").dataset.earned).toBe("false");
		expect(screen.getAllByText("Not earned yet")).toHaveLength(ACHIEVEMENT_IDS.length - 1);
	});
});

describe("KioskOverlay", () => {
	afterEach(() => vi.useRealTimers());

	const stats = { active: 3, waiting: 1, shippedToday: 4, achievements: 2 };

	it("shows the big numbers and a clock that keeps time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 10, 16, 9, 5));
		render(
			<KioskOverlay stats={stats} calm={false} calmLocked={false} onToggleCalm={vi.fn()} onExit={vi.fn()} />,
		);
		expect(screen.getByTestId("kiosk-active").textContent).toBe("3");
		expect(screen.getByTestId("kiosk-waiting").textContent).toBe("1");
		expect(screen.getByTestId("kiosk-shippedToday").textContent).toBe("4");
		expect(screen.getByTestId("kiosk-achievements").textContent).toBe("2");
		const before = screen.getByTestId("kiosk-clock").textContent;
		act(() => vi.advanceTimersByTime(60_000));
		expect(screen.getByTestId("kiosk-clock").textContent).not.toBe(before);
	});

	it("switches calm mode and leaves", () => {
		const onToggleCalm = vi.fn();
		const onExit = vi.fn();
		const { rerender } = render(
			<KioskOverlay stats={stats} calm={false} calmLocked={false} onToggleCalm={onToggleCalm} onExit={onExit} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Calm mode" }));
		expect(onToggleCalm).toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Leave TV mode" }));
		expect(onExit).toHaveBeenCalled();

		rerender(
			<KioskOverlay stats={stats} calm calmLocked={false} onToggleCalm={onToggleCalm} onExit={onExit} />,
		);
		expect(screen.getByRole("button", { name: "Animations" }).getAttribute("aria-pressed")).toBe("true");
	});

	it("cannot turn calm off while the system asks for reduced motion", () => {
		render(
			<KioskOverlay stats={stats} calm calmLocked onToggleCalm={vi.fn()} onExit={vi.fn()} />,
		);
		const button = screen.getByRole("button", { name: "Animations" }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(button.title).toContain("reduced motion");
	});
});

describe("shippedToday", () => {
	const now = new Date(2026, 10, 16, 15, 0);
	const task = (status: Task["status"], updatedAt: Date) => ({ status, updatedAt }) as Task;

	it("counts done and PR tasks of today only", () => {
		expect(
			shippedToday(
				[
					task("done", new Date(2026, 10, 16, 8, 0)),
					task("pr_created", new Date(2026, 10, 16, 14, 0)),
					task("human_review", new Date(2026, 10, 16, 9, 0)),
					task("done", new Date(2026, 10, 15, 23, 59)),
					task("done", new Date(2026, 9, 16, 10, 0)),
					task("done", new Date(2025, 10, 16, 10, 0)),
				],
				now,
			),
		).toBe(2);
	});
});
