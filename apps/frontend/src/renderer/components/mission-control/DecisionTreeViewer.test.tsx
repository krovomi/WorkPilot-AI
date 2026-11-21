/**
 * An agent's reasoning as a tree: every node with its kind, status and
 * details; a branch folds by click or by keyboard, once per press.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "../../../shared/i18n";
import type { DecisionNode, DecisionTree } from "../../stores/mission-control-store";
import { DecisionTreeViewer } from "./DecisionTreeViewer";

function node(id: string, overrides: Partial<DecisionNode> = {}): DecisionNode {
	return {
		id,
		parent_id: null,
		node_type: "thinking",
		status: "completed",
		label: id,
		description: "",
		timestamp: 0,
		tool_name: "",
		tool_input: "",
		tool_output: "",
		options_considered: [],
		chosen_option: "",
		reasoning: "",
		children: [],
		duration_ms: 0,
		...overrides,
	};
}

function tree(nodes: DecisionNode[], overrides: Partial<DecisionTree> = {}): DecisionTree {
	return {
		agent_id: "a1",
		root_id: nodes[0]?.id ?? null,
		current_node_id: null,
		node_count: nodes.length,
		nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
		...overrides,
	};
}

const reasoning = tree(
	[
		node("Task: fix the login", {
			node_type: "root",
			status: "active",
			children: ["Look at the cookie", "Read", "Pick a fix", "missing-node"],
		}),
		node("Look at the cookie", {
			description: "The session expires after an hour",
			duration_ms: 1234.4,
			children: ["Cookie lifetime found"],
		}),
		node("Cookie lifetime found", { node_type: "result" }),
		node("Read", { node_type: "tool_call", tool_name: "Read", tool_input: "src/auth.ts", status: "failed" }),
		node("Pick a fix", {
			node_type: "decision",
			chosen_option: "Extend to 30 days",
			reasoning: "matches the product rule",
			status: "skipped",
		}),
	],
	{ current_node_id: "Read" },
);

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

describe("DecisionTreeViewer", () => {
	it("says so when the agent has decided nothing yet", () => {
		render(<DecisionTreeViewer tree={tree([])} />);
		expect(screen.getByText("No decisions recorded yet")).toBeInTheDocument();
	});

	it("draws nothing, without failing, for a root missing from its nodes", () => {
		render(<DecisionTreeViewer tree={tree([], { root_id: "gone", node_count: 3 })} />);
		expect(screen.getByText("No decisions recorded yet")).toBeInTheDocument();
	});

	it("shows each node with its details, and skips a child it does not have", () => {
		render(<DecisionTreeViewer tree={reasoning} />);
		expect(screen.getByRole("button", { name: /Task: fix the login/ })).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("The session expires after an hour")).toBeInTheDocument();
		expect(screen.getByText("1234ms")).toBeInTheDocument();
		expect(screen.getByText("Cookie lifetime found")).toBeInTheDocument();
		expect(screen.getByText("src/auth.ts")).toBeInTheDocument();
		expect(screen.getByText("→ Extend to 30 days")).toBeInTheDocument();
		expect(screen.getByText("(matches the product rule)")).toBeInTheDocument();
		expect(screen.queryByText("missing-node")).toBeNull();
		// A leaf has nothing to fold.
		expect(screen.getByRole("button", { name: /Cookie lifetime found/ })).not.toHaveAttribute("aria-expanded");
		// The node the agent is on is marked.
		expect(screen.getByRole("button", { name: /^Read/ }).className).toContain("ring-1");
	});

	it("shows a tool without input and a decision without reasoning", () => {
		render(
			<DecisionTreeViewer
				tree={tree([
					node("root", { node_type: "root", children: ["tool", "choice", "plain"] }),
					node("tool", { node_type: "tool_call", tool_name: "Glob" }),
					node("choice", { node_type: "decision", chosen_option: "Keep it" }),
					node("plain", { node_type: "decision" }),
				])}
			/>,
		);
		expect(screen.getByText("Glob")).toBeInTheDocument();
		expect(screen.getByText("→ Keep it")).toBeInTheDocument();
		expect(screen.queryByText(/\(/)).toBeNull();
		expect(screen.queryByText(/ms$/)).toBeNull();
	});

	it("folds and unfolds a branch on click, and a leaf stays as it is", async () => {
		const user = userEvent.setup();
		render(<DecisionTreeViewer tree={reasoning} />);
		const branch = screen.getByRole("button", { name: /Look at the cookie/ });
		await user.click(branch);
		expect(branch).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("Cookie lifetime found")).toBeNull();
		await user.click(branch);
		expect(branch).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("Cookie lifetime found")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /Cookie lifetime found/ }));
		expect(screen.getByText("Cookie lifetime found")).toBeInTheDocument();
	});

	it("folds a branch once per Enter or Space", async () => {
		const user = userEvent.setup();
		render(<DecisionTreeViewer tree={reasoning} />);
		const branch = screen.getByRole("button", { name: /Look at the cookie/ });
		branch.focus();
		await user.keyboard("{Enter}");
		expect(branch).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("Cookie lifetime found")).toBeNull();
		await user.keyboard(" ");
		expect(branch).toHaveAttribute("aria-expanded", "true");
	});
});
