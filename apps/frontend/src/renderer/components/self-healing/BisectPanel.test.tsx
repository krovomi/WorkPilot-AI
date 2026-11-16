/**
 * @vitest-environment jsdom
 */
/**
 * The bisect of a CI/CD incident (#375): a commit id that is not one is never
 * sent, each tested commit shows as it comes, and the verdict says what the
 * bisect found.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { BisectResult, Incident } from "../../../shared/types/self-healing";
import { useSelfHealingStore } from "../../stores/self-healing-store";
import { BisectPanel } from "./BisectPanel";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key} ${JSON.stringify(options)}` : key,
		i18n: { language: "en" },
	}),
}));

const SHA = "a".repeat(40);
const startBisect = vi.fn(async () => undefined);

function incident(source_data: Record<string, unknown> = {}): Incident {
	return {
		id: "inc1",
		mode: "cicd",
		source: "git_push",
		severity: "medium",
		title: "Test regression",
		description: "",
		status: "pending",
		created_at: "2026-10-10T00:00:00",
		source_data,
		affected_files: [],
	};
}

function result(extra: Partial<BisectResult>): BisectResult {
	return {
		status: "found",
		good: "b".repeat(40),
		bad: "c".repeat(40),
		first_bad: SHA,
		first_bad_subject: "change 4",
		candidates: [],
		steps: [],
		tested: 5,
		commits_in_range: 7,
		command: "pytest",
		narrowed: true,
		reason: "",
		cached: false,
		...extra,
	};
}

beforeEach(() => {
	startBisect.mockClear();
	useSelfHealingStore.setState({ bisects: {}, startBisect });
});

describe("BisectPanel", () => {
	it("starts from the last green commit and sends it", () => {
		render(
			<BisectPanel
				incident={incident({
					last_green: "1234567",
					bisect_triggers: {
						fired: true,
						reasons: ["trivial_diff", "old_test"],
						changed_lines: 2,
						old_tests: [],
						dependency_files: [],
					},
				})}
				projectPath="/proj"
			/>,
		);
		expect(screen.getByRole("textbox")).toHaveValue("1234567");
		expect(screen.getByText(/selfHealing:bisect.trigger.trivial_diff/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /selfHealing:bisect.start/ }));
		expect(startBisect).toHaveBeenCalledWith("/proj", "inc1", "1234567");
	});

	it("refuses a commit id that is not one", () => {
		render(
			<BisectPanel
				incident={incident({ bisect_triggers: { fired: false, reasons: [] } })}
				projectPath="/proj"
			/>,
		);
		expect(screen.queryByText("selfHealing:bisect.triggers")).not.toBeInTheDocument();
		const input = screen.getByRole("textbox");
		expect(input).toHaveValue("");
		fireEvent.change(input, { target: { value: "  HEAD~1 " } });
		expect(input).toHaveValue("HEAD~1");
		expect(input).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByText("selfHealing:bisect.invalidSha")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /selfHealing:bisect.start/ })).toBeDisabled();
	});

	it("shows each tested commit while it runs, and no verdict yet", () => {
		useSelfHealingStore.setState({
			bisects: {
				inc1: {
					running: true,
					steps: [{ sha: SHA, outcome: "bad", role: "bad-check", seconds: 1, detail: "", tested: 1 }],
				},
			},
		});
		render(<BisectPanel incident={incident({ bisect: result({}) })} projectPath="/proj" />);
		expect(screen.getByTestId("bisect-steps")).toHaveTextContent("aaaaaaaa");
		expect(screen.getByRole("button", { name: /selfHealing:bisect.running/ })).toBeDisabled();
		expect(screen.queryByText("selfHealing:bisect.status.found")).not.toBeInTheDocument();
	});

	it("names the first bad commit, cached or not", () => {
		useSelfHealingStore.setState({
			bisects: { inc1: { running: false, steps: [], result: result({ cached: true }) } },
		});
		const { rerender } = render(<BisectPanel incident={incident()} projectPath="/proj" />);
		expect(screen.getByText("aaaaaaaaaaaa")).toBeInTheDocument();
		expect(screen.getByText("change 4")).toBeInTheDocument();
		expect(screen.getByText("selfHealing:bisect.cached")).toBeInTheDocument();
		expect(screen.queryByTestId("bisect-steps")).not.toBeInTheDocument();

		useSelfHealingStore.setState({ bisects: {} });
		rerender(<BisectPanel incident={incident({ bisect: result({}) })} projectPath="/proj" />);
		expect(screen.getByText("aaaaaaaaaaaa")).toBeInTheDocument();
		expect(screen.queryByText("selfHealing:bisect.cached")).not.toBeInTheDocument();
	});

	it("lists the candidates of a range and explains other endings", () => {
		const candidates = ["d".repeat(40), "e".repeat(40)];
		const { rerender } = render(
			<BisectPanel
				incident={incident({ bisect: result({ status: "ambiguous", first_bad: "", candidates }) })}
				projectPath="/proj"
			/>,
		);
		expect(screen.getByText("selfHealing:bisect.status.ambiguous")).toBeInTheDocument();
		expect(screen.getByText("dddddddd")).toBeInTheDocument();

		rerender(
			<BisectPanel
				incident={incident({
					bisect: result({ status: "not_reproduced", first_bad: "", reason: "passes here" }),
				})}
				projectPath="/proj"
			/>,
		);
		expect(screen.getByText(/selfHealing:bisect.status.not_reproduced/)).toHaveTextContent("passes here");
	});

	it("shows why a bisect failed", () => {
		useSelfHealingStore.setState({
			bisects: { inc1: { running: false, steps: [], error: "invalid commit id" } },
		});
		render(<BisectPanel incident={incident()} projectPath="/proj" />);
		expect(screen.getByRole("alert")).toHaveTextContent("invalid commit id");
	});
});
