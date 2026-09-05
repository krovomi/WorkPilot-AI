/**
 * The panel is the whole point of the change: a failed run has to *say* what
 * failed. These render it the way a user meets it — through the real
 * translation catalogue, so a missing key fails here rather than shipping as a
 * blank card.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { useTestGenerationStore } from "../../../stores/test-generation-store";
import { GenerationErrorPanel } from "../GenerationErrorPanel";

const initial = useTestGenerationStore.getState();

beforeEach(async () => {
	useTestGenerationStore.setState(initial, true);
	await i18n.changeLanguage("en");
});

describe("GenerationErrorPanel", () => {
	it("renders nothing when there is no failure", () => {
		const { container } = render(<GenerationErrorPanel />);
		expect(container).toBeEmptyDOMElement();
	});

	it("names the failure, explains it, and says what to do", () => {
		render(
			<GenerationErrorPanel
				error={{
					message: "HTTP 401 Unauthorized",
					code: "auth",
					stage: "generate",
					provider: "claude",
				}}
			/>,
		);

		// Title from the code, message from the runner, hint from the catalogue.
		expect(
			screen.getByText("The AI provider rejected your credentials"),
		).toBeInTheDocument();
		expect(screen.getByText("HTTP 401 Unauthorized")).toBeInTheDocument();
		expect(screen.getByText(/Settings → Providers/)).toBeInTheDocument();
		// And the context that makes it diagnosable.
		expect(screen.getByText("Generating")).toBeInTheDocument();
		expect(screen.getByText("claude")).toBeInTheDocument();
	});

	it("is announced, not merely coloured", () => {
		render(
			<GenerationErrorPanel error={{ message: "boom", code: "unknown" }} />,
		);
		expect(screen.getByRole("alert")).toBeInTheDocument();
	});

	it("keeps the technical text folded away until asked", () => {
		render(
			<GenerationErrorPanel
				error={{
					message: "boom",
					code: "runner_crashed",
					details: "Traceback (most recent call last)",
				}}
			/>,
		);

		expect(
			screen.queryByText(/Traceback \(most recent call last\)/),
		).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /Technical details/ }));

		expect(
			screen.getByText(/Traceback \(most recent call last\)/),
		).toBeInTheDocument();
	});

	it("falls back to readable copy for a code it has never seen", () => {
		render(
			<GenerationErrorPanel
				error={{ message: "boom", code: "from_the_future" as never }}
			/>,
		);
		expect(screen.getByText("Test generation failed")).toBeInTheDocument();
	});

	it("offers a retry only when there is a run to replay", () => {
		const { rerender } = render(
			<GenerationErrorPanel error={{ message: "boom", code: "network" }} />,
		);
		expect(
			screen.queryByRole("button", { name: /Try again/ }),
		).not.toBeInTheDocument();

		const run = vi.fn().mockResolvedValue(undefined);
		useTestGenerationStore.setState({ lastRun: run });
		rerender(
			<GenerationErrorPanel error={{ message: "boom", code: "network" }} />,
		);

		fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("speaks the user's language", async () => {
		await i18n.changeLanguage("fr");
		render(
			<GenerationErrorPanel error={{ message: "boom", code: "rate_limit" }} />,
		);
		expect(screen.getByText("Limite de débit atteinte")).toBeInTheDocument();
	});
});
