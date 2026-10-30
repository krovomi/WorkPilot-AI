/**
 * The bench's recommendation on a card's engine step: the kind's own, else
 * the one over every card; offered with its evidence, applied only on a click.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BenchRecommendation, BenchStatus } from "../../../../shared/types";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && "kind" in options ? `${key}:${options.kind}` : key,
		i18n: { language: "en" },
	}),
}));

import { BenchEngineHint, recommendationFor, recommendedTrio } from "../BenchRecommendation";

const PICK: BenchRecommendation = {
	provider: "openai",
	model: "gpt-mini",
	effort: "low",
	judged: 4,
	resolved: 4,
	rate: 1,
	cases: 4,
	avgCostUsd: 0.25,
	bestRate: 1,
	considered: 2,
};

const getBenchStatus = vi.fn();

function status(recommendations: BenchStatus["recommendations"]): BenchStatus {
	return {
		activeRunId: null,
		running: [],
		queued: 0,
		concurrency: 1,
		runs: [],
		table: [],
		recommendations,
	};
}

beforeEach(() => {
	getBenchStatus.mockReset();
	(window as unknown as { electronAPI: unknown }).electronAPI = { getBenchStatus };
});

describe("recommendationFor", () => {
	it("prefers the kind's own, then the one over every card", () => {
		const all = { ...PICK, model: "all" };
		expect(recommendationFor({ bug_fix: PICK, "*": all }, "bug_fix")).toEqual({
			pick: PICK,
			scope: "kind",
		});
		expect(recommendationFor({ "*": all }, "feature")).toEqual({ pick: all, scope: "all" });
		expect(recommendationFor({}, "feature")).toBeNull();
	});

	it("refuses an effort the app does not know", () => {
		expect(recommendedTrio({ ...PICK, effort: "maximum" })).toBeNull();
		expect(recommendedTrio(PICK)).toEqual({
			provider: "openai",
			model: "gpt-mini",
			effort: "low",
		});
	});
});

describe("BenchEngineHint", () => {
	it("offers the kind's engine and applies it only on a click", async () => {
		getBenchStatus.mockResolvedValue({ success: true, data: status({ bug_fix: PICK }) });
		const onUse = vi.fn();
		render(
			<BenchEngineHint projectId="p1" kind="bug_fix" isCurrent={() => false} onUse={onUse} />,
		);
		expect(await screen.findByText("gpt-mini")).toBeInTheDocument();
		expect(screen.getByText(/bench:recommend.hintKind/)).toBeInTheDocument();
		expect(getBenchStatus).toHaveBeenCalledWith("p1");
		expect(onUse).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "bench:recommend.use" }));
		expect(onUse).toHaveBeenCalledWith({ provider: "openai", model: "gpt-mini", effort: "low" });
	});

	it("says when the engine shown is already the recommended one", async () => {
		getBenchStatus.mockResolvedValue({ success: true, data: status({ "*": PICK }) });
		render(<BenchEngineHint projectId="p1" kind="docs" isCurrent={() => true} onUse={vi.fn()} />);
		expect(await screen.findByText(/bench:recommend.hintAll/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "bench:recommend.inUse" })).toBeDisabled();
	});

	it("shows nothing without a recommendation", async () => {
		getBenchStatus.mockResolvedValue({ success: true, data: status({}) });
		const { container } = render(
			<BenchEngineHint projectId="p1" kind="feature" isCurrent={() => false} onUse={vi.fn()} />,
		);
		await Promise.resolve();
		expect(container).toBeEmptyDOMElement();
	});
});
