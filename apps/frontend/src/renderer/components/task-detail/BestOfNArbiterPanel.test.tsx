/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import type { BestOfNArbiter, BestOfNState } from "../../../shared/types";
import { BestOfNArbiterPanel } from "./BestOfNArbiterPanel";

const engineA = { provider: "anthropic", model: "model-a", effort: "high" } as never;
const engineB = { provider: "openai", model: "model-b", effort: "medium" } as never;

const divergence = {
	needed: true,
	reason: "diverge" as const,
	pairs: [{ a: "001-login-bon1", b: "001-login-bon2", divergence: 0.62 }],
	max: 0.62,
	threshold: 0.3,
};

function stateWith(arbiter: BestOfNArbiter): BestOfNState {
	return {
		parent: "001-login",
		phase: "ranked",
		createdAt: "x",
		variants: [
			{ index: 1, specId: "001-login-bon1", engine: engineA, exitCode: 0 },
			{ index: 2, specId: "001-login-bon2", engine: engineB, exitCode: 0 },
		],
		arbiter,
	};
}

const verdict: BestOfNArbiter = {
	status: "done",
	divergence,
	engine: { provider: "google", model: "model-g" },
	choice: "001-login-bon2",
	merge: [],
	equivalent: false,
	reasons: { correctness: "Both pass; B handles the empty password.", security: "B hashes with a salt." },
	risks: { "001-login-bon1": ["Plain comparison of secrets"] },
	summary: "B is safer.",
	confidence: "high",
	thread: [],
};

const api = {
	arbitrateBestOfN: vi.fn(),
	challengeBestOfN: vi.fn(),
	getBestOfNArbiterMetrics: vi.fn(),
};
Object.defineProperty(window, "electronAPI", { value: api, writable: true });

const call = vi.fn(async (action: () => Promise<{ success: boolean }>) => (await action()).success);

describe("BestOfNArbiterPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.challengeBestOfN.mockResolvedValue({ success: true });
		api.arbitrateBestOfN.mockResolvedValue({ success: true });
	});

	it("shows the verdict, a reason per axis and the risks of the variant set aside", () => {
		render(<BestOfNArbiterPanel taskId="001-login" state={stateWith(verdict)} busy={false} call={call} />);
		expect(screen.getByText("Recommends #2 · openai · model-b")).toBeInTheDocument();
		expect(screen.getByText("High confidence")).toBeInTheDocument();
		expect(screen.getByText(/divergence 0.62, threshold 0.30/)).toBeInTheDocument();
		expect(screen.getByText("B hashes with a salt.")).toBeInTheDocument();
		expect(screen.getByText("Risks of #1 · anthropic · model-a")).toBeInTheDocument();
		expect(screen.getByText("Plain comparison of secrets")).toBeInTheDocument();
		// Another provider than the variants': no bias warning.
		expect(screen.queryByText(/may favour/)).not.toBeInTheDocument();
	});

	it("leaves the choice to the person when the arbiter is not sure", () => {
		const unsure = { ...verdict, status: "needs_human" as const, confidence: "low" as const };
		render(<BestOfNArbiterPanel taskId="001-login" state={stateWith(unsure)} busy={false} call={call} />);
		expect(screen.getByText("The arbiter is not sure: the choice is yours.")).toBeInTheDocument();
		expect(screen.getByText("Low confidence")).toBeInTheDocument();
	});

	it("warns when the arbiter runs on a variant's provider", () => {
		const biased = { ...verdict, engine: { provider: "openai", model: "model-x" } };
		render(<BestOfNArbiterPanel taskId="001-login" state={stateWith(biased)} busy={false} call={call} />);
		expect(screen.getByText(/runs on openai, like one of the variants/)).toBeInTheDocument();
	});

	it("lists a merge file by file, and says it is not applied", () => {
		const merge = {
			...verdict,
			choice: "merge",
			merge: [
				{ file: "src/auth.ts", from: "001-login-bon2" },
				{ file: "src/form.tsx", from: "001-login-bon1" },
			],
		};
		render(<BestOfNArbiterPanel taskId="001-login" state={stateWith(merge)} busy={false} call={call} />);
		expect(screen.getByText("src/auth.ts")).toBeInTheDocument();
		expect(screen.getByText(/not applied for you/)).toBeInTheDocument();
	});

	it("shows no verdict when the answer was invalid, and offers to ask again", async () => {
		const invalid: BestOfNArbiter = { status: "invalid", divergence, thread: [] };
		render(<BestOfNArbiterPanel taskId="001-login" state={stateWith(invalid)} busy={false} call={call} />);
		expect(screen.queryByText(/Recommends/)).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Question the verdict")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Ask the arbiter" }));
		await waitFor(() => expect(api.arbitrateBestOfN).toHaveBeenCalledWith("001-login"));
	});

	it("sends the person's question and shows the exchange", async () => {
		const withThread = {
			...verdict,
			thread: [{ at: "t1", question: "Why not A?", answer: "A compares secrets in plain text." }],
		};
		render(<BestOfNArbiterPanel taskId="001-login" state={stateWith(withThread)} busy={false} call={call} />);
		expect(screen.getByText("A compares secrets in plain text.")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Question the verdict"), { target: { value: "  And B?  " } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(api.challengeBestOfN).toHaveBeenCalledWith("001-login", "And B?"));
	});

	it("closes the thread after ten questions", () => {
		const full = {
			...verdict,
			thread: Array.from({ length: 10 }, (_, i) => ({ at: `t${i}`, question: `q${i}`, answer: `a${i}` })),
		};
		render(<BestOfNArbiterPanel taskId="001-login" state={stateWith(full)} busy={false} call={call} />);
		expect(screen.getByText(/thread is full/)).toBeInTheDocument();
		expect(screen.queryByLabelText("Question the verdict")).not.toBeInTheDocument();
	});

	it("shows the track record per month", async () => {
		api.getBestOfNArbiterMetrics.mockResolvedValue({
			success: true,
			data: [{ month: "2026-11", arbitrations: 4, followedPercent: 75, merges: 1, choices: 3, meanConfidence: 0.8 }],
		});
		render(<BestOfNArbiterPanel taskId="001-login" state={stateWith(verdict)} busy={false} call={call} />);
		fireEvent.click(screen.getByRole("button", { name: "Track record" }));
		expect(await screen.findByText("2026-11: 4 arbitrated, followed 75%, 1 merges proposed")).toBeInTheDocument();
	});
});
