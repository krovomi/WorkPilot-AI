/**
 * @vitest-environment jsdom
 */
/**
 * « Tout mettre à jour » at the foot of the « Outils CLI » panel: it shows
 * only while a CLI has a newer release, runs each badge's own update one
 * after the other, says where it is, and goes away once nothing is left.
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { CliToolId } from "../cli-tool-order";
import {
	CliUpdateAllButton,
	type CliUpdateOffer,
	type CliUpdateOffers,
	pendingCliUpdates,
	runCliUpdatesInTurn,
	useReportCliUpdate,
} from "../cli-update-all";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const offer = (run: () => Promise<unknown> = () => Promise.resolve(), isUpdating = false): CliUpdateOffer => ({
	run,
	isUpdating,
});

/** The offer a reporter mock received last. */
function lastOffer(report: ReturnType<typeof vi.fn>): CliUpdateOffer {
	const offered = report.mock.lastCall?.[0] as CliUpdateOffer | null | undefined;
	if (!offered) throw new Error("no offer reported");
	return offered;
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

describe("pendingCliUpdates", () => {
	it("keeps the panel's order and leaves out an update already running", () => {
		const offers: CliUpdateOffers = {
			pi: offer(),
			codex: offer(),
			hermes: offer(undefined, true),
		};
		expect(pendingCliUpdates(["claude-code", "codex", "hermes", "pi"], offers)).toEqual([
			"codex",
			"pi",
		]);
	});
});

describe("runCliUpdatesInTurn", () => {
	it("starts an update only once the one before has ended, and goes on after a failure", async () => {
		const events: string[] = [];
		const first = deferred();
		const offers: CliUpdateOffers = {
			codex: offer(async () => {
				events.push("codex:start");
				await first.promise;
				events.push("codex:end");
			}),
			"gemini-cli": offer(async () => {
				events.push("gemini:start");
				throw new Error("npm failed");
			}),
			pi: offer(async () => {
				events.push("pi:start");
			}),
		};
		const steps: number[] = [];
		const order: CliToolId[] = ["codex", "gemini-cli", "pi"];
		const done = runCliUpdatesInTurn(order, (id) => offers[id], (index) => steps.push(index));
		await Promise.resolve();
		expect(events).toEqual(["codex:start"]);
		first.resolve();
		await done;
		expect(events).toEqual(["codex:start", "codex:end", "gemini:start", "pi:start"]);
		expect(steps).toEqual([0, 1, 2]);
	});
});

describe("useReportCliUpdate", () => {
	it("reports an offer only while an update is available or running, and withdraws it on unmount", () => {
		const report = vi.fn();
		const run = vi.fn().mockResolvedValue(undefined);
		const { rerender, unmount } = renderHook(
			({ available, busy }) => useReportCliUpdate(report, available, busy, run),
			{ initialProps: { available: false, busy: false } },
		);
		expect(report).toHaveBeenLastCalledWith(null);

		rerender({ available: true, busy: false });
		const offered = lastOffer(report);
		expect(offered.isUpdating).toBe(false);
		void offered.run();
		expect(run).toHaveBeenCalledTimes(1);

		rerender({ available: true, busy: true });
		expect(lastOffer(report).isUpdating).toBe(true);

		unmount();
		expect(report).toHaveBeenLastCalledWith(null);
	});

	it("calls the badge's latest handler, not the one of its first render", async () => {
		const report = vi.fn();
		const first = vi.fn().mockResolvedValue(undefined);
		const second = vi.fn().mockResolvedValue(undefined);
		const { rerender } = renderHook(({ run }) => useReportCliUpdate(report, true, false, run), {
			initialProps: { run: first },
		});
		const offered = lastOffer(report);
		rerender({ run: second });
		await offered.run();
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});
});

/** A panel whose two CLIs clear their offer once their update ran, as the badges do. */
function Panel({ runs }: { readonly runs: Record<"codex" | "pi", () => Promise<void>> }) {
	const [offers, setOffers] = useState<CliUpdateOffers>(() => ({
		codex: offer(async () => {
			await runs.codex();
			setOffers(({ codex: _done, ...rest }) => rest);
		}),
		pi: offer(async () => {
			await runs.pi();
			setOffers(({ pi: _done, ...rest }) => rest);
		}),
	}));
	return <CliUpdateAllButton order={["claude-code", "codex", "pi"]} offers={offers} />;
}

describe("CliUpdateAllButton", () => {
	it("shows nothing when every CLI is up to date", () => {
		const { container } = render(<CliUpdateAllButton order={["codex", "pi"]} offers={{}} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("names how many CLIs it updates, and which ones in its tooltip", () => {
		render(<CliUpdateAllButton order={["codex", "pi"]} offers={{ codex: offer(), pi: offer() }} />);
		const button = screen.getByTestId("cli-update-all");
		expect(button).toHaveTextContent("Update all (2)");
		expect(button).toHaveAttribute("title", "Update Codex, pi, one after the other");
	});

	it("reads in French", async () => {
		await i18n.changeLanguage("fr");
		render(<CliUpdateAllButton order={["codex"]} offers={{ codex: offer() }} />);
		expect(screen.getByTestId("cli-update-all")).toHaveTextContent("Tout mettre à jour (1)");
	});

	it("runs each update in turn with its progress, then goes away", async () => {
		const codex = deferred();
		const pi = deferred();
		const runs = { codex: vi.fn(() => codex.promise), pi: vi.fn(() => pi.promise) };
		render(<Panel runs={runs} />);

		fireEvent.click(screen.getByTestId("cli-update-all"));
		const button = screen.getByTestId("cli-update-all");
		expect(button).toHaveTextContent("Updating 1/2…");
		expect(button).toBeDisabled();
		expect(runs.codex).toHaveBeenCalledTimes(1);
		expect(runs.pi).not.toHaveBeenCalled();

		await act(async () => codex.resolve());
		await waitFor(() => expect(screen.getByTestId("cli-update-all")).toHaveTextContent("Updating 2/2…"));
		expect(runs.pi).toHaveBeenCalledTimes(1);

		await act(async () => pi.resolve());
		await waitFor(() => expect(screen.queryByTestId("cli-update-all")).not.toBeInTheDocument());
	});

	it("comes back with what is left when an update did not take", async () => {
		function Stubborn() {
			const [offers] = useState<CliUpdateOffers>({ codex: offer(() => Promise.resolve()) });
			return <CliUpdateAllButton order={["codex"]} offers={offers} />;
		}
		render(<Stubborn />);
		fireEvent.click(screen.getByTestId("cli-update-all"));
		await waitFor(() => expect(screen.getByTestId("cli-update-all")).toHaveTextContent("Update all (1)"));
		expect(screen.getByTestId("cli-update-all")).not.toBeDisabled();
	});
});
