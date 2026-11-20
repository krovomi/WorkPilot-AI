/**
 * Adding an agent: a name that follows the role until one is typed, a
 * provider, and a model recommended for the role. The dialog keeps what was
 * typed until the agent exists, and says why it was refused.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getModelsForProvider } from "../../../shared/constants/models";
import i18n from "../../../shared/i18n";
import { AddAgentDialog } from "./AddAgentDialog";

beforeAll(() => {
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(async () => {
	await i18n.changeLanguage("en");
	// The backend is not running: each provider offers its built-in models.
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
		localBackendRequest: vi.fn().mockResolvedValue({ unreachable: true }),
	};
});

function dialog(props: Partial<Parameters<typeof AddAgentDialog>[0]> = {}) {
	const onAdd = vi.fn().mockResolvedValue(true);
	const onOpenChange = vi.fn();
	render(<AddAgentDialog open onOpenChange={onOpenChange} onAdd={onAdd} {...props} />);
	return { onAdd: (props.onAdd as typeof onAdd | undefined) ?? onAdd, onOpenChange };
}

async function choose(label: RegExp, option: RegExp | string) {
	fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "Enter" });
	fireEvent.click(await screen.findByRole("option", { name: option }));
}

const tierOf = (provider: string, value: string) => getModelsForProvider(provider).find((m) => m.value === value)?.tier;

describe("AddAgentDialog", () => {
	it("names a coder on Claude after its role and picks a standard model", async () => {
		const user = userEvent.setup();
		const { onAdd } = dialog();
		expect(screen.getByText("Mission control", { selector: ".wp-kicker" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Add Agent" })).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Agent Name" })).toHaveValue("Agent Coder");
		expect(screen.getByRole("combobox", { name: "Role" })).toHaveTextContent("💻 Coder");
		expect(screen.getByRole("combobox", { name: "Provider" })).toHaveTextContent("Anthropic (Claude)");
		await waitFor(() => expect(screen.getByText("Standard", { selector: "label span" })).toBeInTheDocument());

		await user.click(screen.getByRole("button", { name: "Create Agent" }));
		const [name, role, provider, model, label] = onAdd.mock.calls[0];
		expect([name, role, provider]).toEqual(["Agent Coder", "coder", "anthropic"]);
		expect(tierOf("anthropic", model)).toBe("standard");
		expect(label).toBe(getModelsForProvider("anthropic").find((m) => m.value === model)?.label);
	});

	it("renames and re-picks the model for another role, with each role explained", async () => {
		const user = userEvent.setup();
		const { onAdd } = dialog();
		fireEvent.keyDown(screen.getByRole("combobox", { name: "Role" }), { key: "Enter" });
		expect(await screen.findByRole("option", { name: /Testing & QA/ })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("option", { name: /🏗️ Architect.*System design & architecture/ }));
		expect(screen.getByRole("textbox", { name: "Agent Name" })).toHaveValue("Agent Architect");
		await waitFor(() => expect(screen.getByText("Flagship", { selector: "label span" })).toBeInTheDocument());
		await user.click(screen.getByRole("button", { name: "Create Agent" }));
		expect(onAdd.mock.calls[0].slice(0, 2)).toEqual(["Agent Architect", "architect"]);
		expect(tierOf("anthropic", onAdd.mock.calls[0][3])).toBe("flagship");
	});

	it("keeps a typed name across roles, and needs a name to create", async () => {
		const user = userEvent.setup();
		dialog();
		const name = screen.getByRole("textbox", { name: "Agent Name" });
		await user.clear(name);
		expect(screen.getByRole("button", { name: "Create Agent" })).toBeDisabled();
		expect(name).toHaveAttribute("placeholder", "e.g. Architecture Agent");
		await user.type(name, "  ");
		expect(screen.getByRole("button", { name: "Create Agent" })).toBeDisabled();
		await user.clear(name);
		await user.type(name, "Login fixer");
		await choose(/Role/, /Debugger/);
		expect(name).toHaveValue("Login fixer");
		expect(screen.getByRole("button", { name: "Create Agent" })).toBeEnabled();
	});

	it("falls back to the provider's first model when none fits the role, and to none", async () => {
		const user = userEvent.setup();
		const { onAdd } = dialog();
		await choose(/Role/, /Tester/);
		await choose(/Provider/, "DeepSeek");
		// DeepSeek has no fast model: its first one.
		await waitFor(() =>
			expect(screen.getByRole("combobox", { name: /^Model/ })).toHaveTextContent(
				getModelsForProvider("deepseek")[0].label,
			),
		);
		await user.click(screen.getByRole("button", { name: "Create Agent" }));
		expect(onAdd.mock.calls[0].slice(2, 4)).toEqual(["deepseek", getModelsForProvider("deepseek")[0].value]);

		await choose(/Provider/, "OpenCode");
		await waitFor(() => expect(screen.getByRole("combobox", { name: /^Model/ })).toHaveTextContent(""));
		await user.click(screen.getByRole("button", { name: "Create Agent" }));
		expect(onAdd.mock.calls[1].slice(2)).toEqual(["opencode", "", ""]);
	});

	it("lets the person pick a model, each one named with its tier", async () => {
		const user = userEvent.setup();
		const { onAdd } = dialog();
		await choose(/Provider/, "Custom/Enterprise");
		const fast = getModelsForProvider("custom").find((m) => m.tier === "fast");
		fireEvent.keyDown(screen.getByRole("combobox", { name: /^Model/ }), { key: "Enter" });
		expect((await screen.findAllByRole("option", { name: /Local$/ })).length).toBeGreaterThan(0);
		expect(screen.getAllByRole("option", { name: /Standard$/ }).length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("option", { name: `${fast?.label}Fast` }));
		await user.click(screen.getByRole("button", { name: "Create Agent" }));
		expect(onAdd.mock.calls[0].slice(2)).toEqual(["custom", fast?.value, fast?.label]);
	});

	it("keeps the form and says why when the agent is refused, then resets once created", async () => {
		const user = userEvent.setup();
		let finish: (created: boolean) => void = () => undefined;
		const onAdd = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
		const { rerender } = render(<AddAgentDialog open onOpenChange={vi.fn()} onAdd={onAdd} error={null} />);
		await choose(/Role/, /Planner/);
		const create = screen.getByRole("button", { name: "Create Agent" });
		await user.click(create);
		// One click, one agent: the button waits for the answer.
		expect(create).toBeDisabled();
		finish(false);
		await waitFor(() => expect(create).toBeEnabled());
		rerender(<AddAgentDialog open onOpenChange={vi.fn()} onAdd={onAdd} error="Backend unavailable" />);
		expect(screen.getByRole("alert")).toHaveTextContent("Unable to create the agent: Backend unavailable");
		expect(screen.getByRole("textbox", { name: "Agent Name" })).toHaveValue("Agent Planner");

		rerender(<AddAgentDialog open onOpenChange={vi.fn()} onAdd={onAdd} error="" />);
		expect(screen.getByRole("alert")).toHaveTextContent("The agent was not created.");

		await user.click(create);
		finish(true);
		await waitFor(() => expect(screen.getByRole("textbox", { name: "Agent Name" })).toHaveValue("Agent Coder"));
		expect(screen.getByRole("combobox", { name: "Role" })).toHaveTextContent("💻 Coder");
	});

	it("closes on Cancel", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = dialog();
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
