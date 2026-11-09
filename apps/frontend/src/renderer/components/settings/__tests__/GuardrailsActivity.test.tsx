/**
 * @vitest-environment jsdom
 */
/**
 * The activity of the guardrails: an invalid policy is said, a pending request
 * can be approved once or refused, and the dry run lists what it would block.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGuardrailsStore } from "../../../stores/guardrails-store";
import { GuardrailsActivity } from "../GuardrailsActivity";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, fallback?: unknown) => (typeof fallback === "string" ? `${key}` : key),
		i18n: { language: "en" },
	}),
}));

const answer = vi.fn(async () => undefined);
const event = {
	id: "0123456789ab",
	at: "2026-11-09T10:00:00Z",
	action: "require_approval" as const,
	outcome: "pending",
	rules: ["deps"],
	tool: "Write",
	target: { kind: "file" as const, key: "file:package.json", summary: "package.json" },
	details: { deps: ["zod"] },
	task: "001-orders",
	message: "Guardrail triggered",
};

beforeEach(() => {
	answer.mockClear();
	useGuardrailsStore.setState({
		policy: {
			rules: [],
			sources: [{ layer: "project", path: "/p/.workpilot/guardrails.json", rules: 1 }],
			errors: ["guardrails.json: rule x: unknown condition 'path_prefx'"],
			warnings: [],
		},
		activity: { events: [event], pending: [event], counts: { deps: { pending: 1 } }, blockedLast10Min: 25, answers: {} },
		diffCheck: {
			policy: { rules: [], sources: [], errors: [], warnings: [] },
			ref: "HEAD",
			files: [{ path: "tests/test_a.py", change: "M", action: "deny", triggered: ["keep-tests"], message: "", details: { "keep-tests": ["test_b"] } }],
		},
		answer,
		refreshInsights: vi.fn(async () => undefined),
		checkDiff: vi.fn(async () => undefined),
	});
});

describe("GuardrailsActivity", () => {
	it("says the policy is invalid and names the mistake", () => {
		render(<GuardrailsActivity projectPath="/p" />);
		expect(screen.getByRole("alert").textContent).toContain("unknown condition 'path_prefx'");
		expect(screen.getByText("/p/.workpilot/guardrails.json")).toBeTruthy();
	});

	it("approves a pending request once, or refuses it", () => {
		render(<GuardrailsActivity projectPath="/p" />);
		expect(screen.getAllByText("(zod)").length).toBeGreaterThan(0);
		fireEvent.click(screen.getByText("guardrails.approveOnce"));
		expect(answer).toHaveBeenCalledWith("/p", "0123456789ab", true);
		fireEvent.click(screen.getByText("guardrails.refuse"));
		expect(answer).toHaveBeenLastCalledWith("/p", "0123456789ab", false);
	});

	it("warns about a rule that blocks too often and lists the dry run", () => {
		render(<GuardrailsActivity projectPath="/p" />);
		expect(screen.getByText("guardrails.noisy")).toBeTruthy();
		expect(screen.getByText("tests/test_a.py")).toBeTruthy();
		expect(screen.getByText("(test_b)")).toBeTruthy();
	});
});
