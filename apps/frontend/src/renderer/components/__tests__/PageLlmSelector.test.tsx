/**
 * The page's own "provider × model × effort": shown only on a page that can
 * run it, saved as a page override, reset to the settings.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { AppSettings } from "../../../shared/types/settings";
import { useSettingsStore } from "../../stores/settings-store";
import { PageLlmSelector } from "../PageLlmSelector";

const api = {
	saveSettings: vi.fn(),
	checkClaudeOAuth: vi.fn(),
	checkOpenAICodexOAuth: vi.fn(),
	checkAgentCli: vi.fn(),
	invoke: vi.fn(),
	localBackendRequest: vi.fn(),
};

function setSettings(settings: Partial<AppSettings>) {
	act(() => useSettingsStore.setState({ settings: settings as AppSettings }));
}

const trigger = () => screen.getByRole("button", { name: /·/ });

async function openPopover() {
	await userEvent.click(trigger());
	return screen.findByRole("dialog");
}

async function choose(field: string, option: string | RegExp) {
	fireEvent.keyDown(screen.getByRole("combobox", { name: field }), { key: "Enter" });
	await userEvent.click(await screen.findByRole("option", { name: option }));
}

/** The text of every option of a list, closed again afterwards. */
async function optionsOf(field: string) {
	fireEvent.keyDown(screen.getByRole("combobox", { name: field }), { key: "Enter" });
	const listbox = await screen.findByRole("listbox");
	const options = within(listbox).getAllByRole("option");
	fireEvent.keyDown(listbox, { key: "Escape" });
	await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
	return options;
}

/** The "as in settings" entry (a searchable list sorts its options). */
const inheritOf = (options: HTMLElement[]) => options.find((o) => o.textContent?.startsWith("As in settings"));

describe("PageLlmSelector", () => {
	beforeAll(() => {
		Element.prototype.hasPointerCapture = vi.fn(() => false);
		Element.prototype.releasePointerCapture = vi.fn();
	});

	beforeEach(async () => {
		await i18n.changeLanguage("en");
		for (const fn of Object.values(api)) fn.mockReset();
		api.saveSettings.mockResolvedValue({ success: true });
		api.checkClaudeOAuth.mockResolvedValue({ isAuthenticated: true });
		api.checkOpenAICodexOAuth.mockResolvedValue({ isAuthenticated: false });
		api.checkAgentCli.mockResolvedValue({ installed: false });
		api.invoke.mockResolvedValue({ installed: false, authenticated: false });
		// No live catalog: the selector offers the bundled model list.
		api.localBackendRequest.mockResolvedValue({ unreachable: true });
		Object.assign(globalThis.electronAPI, api);
		useSettingsStore.setState({ profiles: [], settings: { selectedProvider: "anthropic" } as AppSettings });
	});

	it("shows nothing on a page that cannot run its own choice", () => {
		const { container, rerender } = render(<PageLlmSelector page="kanban" />);
		expect(container).toBeEmptyDOMElement();
		rerender(<PageLlmSelector page={undefined} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("sums up what the page follows from the settings", async () => {
		render(<PageLlmSelector page="insights" />);
		await waitFor(() => expect(trigger()).toHaveTextContent("Anthropic (Claude) · Claude Sonnet 5.5 · Medium"));
		expect(trigger()).toHaveAttribute("title", "Choose the provider, model and effort for this page");
		expect(screen.queryByText("page")).toBeNull();

		const dialog = await openPopover();
		expect(dialog).toHaveTextContent("This page's engine");
		expect(dialog).toHaveTextContent("This page follows the global choice.");
		expect(within(dialog).getByRole("button", { name: "Reset" })).toBeDisabled();
		expect(screen.getByRole("combobox", { name: "Default provider" })).toHaveTextContent(
			"As in settings (Anthropic (Claude))",
		);
		expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent("As in settings (Claude Sonnet 5.5)");
		expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent("As in settings (Medium)");
	});

	it("names the default provider when none is chosen anywhere", async () => {
		setSettings({});
		render(<PageLlmSelector page="insights" />);
		expect(trigger()).toHaveTextContent("Default provider · Claude Sonnet 5.5 · Medium");
		await openPopover();
		// Without a provider the effort is still offered.
		expect(screen.getByRole("combobox", { name: "Effort" })).toBeInTheDocument();
	});

	it("falls back to the provider's id while the provider list is unknown", async () => {
		setSettings({ selectedProvider: "acme" });
		render(<PageLlmSelector page="insights" />);
		expect(trigger()).toHaveTextContent(/^acme · /);
		await openPopover();
		// A provider without extended thinking has no effort to choose.
		expect(screen.queryByRole("combobox", { name: "Effort" })).toBeNull();
	});

	it("keeps the selector usable when the sign-in checks fail", async () => {
		api.checkClaudeOAuth.mockImplementation(() => {
			throw new Error("bridge gone");
		});
		const original = globalThis.electronAPI.checkAgentCli;
		Object.assign(globalThis.electronAPI, {
			checkAgentCli: () => {
				throw new Error("bridge gone");
			},
		});
		render(<PageLlmSelector page="insights" />);
		await openPopover();
		expect(screen.getByRole("combobox", { name: "Default provider" })).toBeInTheDocument();
		Object.assign(globalThis.electronAPI, { checkAgentCli: original });
	});

	it("saves a provider for this page, and greys out the ones not set up", async () => {
		render(<PageLlmSelector page="insights" />);
		await waitFor(() => expect(trigger()).toHaveTextContent("Anthropic (Claude)"));
		await openPopover();

		const options = await optionsOf("Default provider");
		expect(options.find((o) => o.textContent === "OpenAI (ChatGPT)")).toHaveAttribute("aria-disabled", "true");
		expect(options.find((o) => o.textContent === "Ollama (Local)")).not.toHaveAttribute("aria-disabled");

		await choose("Default provider", "Ollama (Local)");
		await waitFor(() =>
			expect(api.saveSettings).toHaveBeenCalledWith({ pageLlmOverrides: { insights: { provider: "ollama" } } }),
		);
		await waitFor(() => expect(trigger()).toHaveTextContent(/^Ollama \(Local\) · /));
		expect(screen.getByText("page")).toBeInTheDocument();
		expect(screen.getByText("This page overrides the global choice.")).toBeInTheDocument();
	});

	it("offers the settings' choices under 'as in settings', not the page's own", async () => {
		setSettings({
			selectedProvider: "anthropic",
			pageLlmOverrides: { insights: { provider: "openai", thinking: "high" } },
		});
		render(<PageLlmSelector page="insights" />);
		await waitFor(() => expect(trigger()).toHaveTextContent("OpenAI (ChatGPT) · GPT-5.6 Terra · High"));
		await openPopover();

		expect(screen.getByRole("combobox", { name: "Default provider" })).toHaveTextContent("OpenAI (ChatGPT)");
		const providers = await optionsOf("Default provider");
		expect(inheritOf(providers)).toHaveTextContent("As in settings (Anthropic (Claude))");
		expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent("High");
		const efforts = await optionsOf("Effort");
		expect(inheritOf(efforts)).toHaveTextContent("As in settings (Medium)");
	});

	it("pins the model with the provider it was picked from", async () => {
		render(<PageLlmSelector page="insights" />);
		await waitFor(() => expect(trigger()).toHaveTextContent("Anthropic (Claude)"));
		await openPopover();
		await choose("Model", "Claude Opus 5.5");
		await waitFor(() =>
			expect(api.saveSettings).toHaveBeenCalledWith({
				pageLlmOverrides: { insights: { model: "claude-opus-5-5", provider: "anthropic" } },
			}),
		);
		await waitFor(() => expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent("Claude Opus 5.5"));
		const models = await optionsOf("Model");
		expect(inheritOf(models)).toHaveTextContent("As in settings (Claude Sonnet 5.5)");
	});

	it("goes back to the settings for one field, then resets the whole page", async () => {
		setSettings({
			selectedProvider: "anthropic",
			pageLlmOverrides: { insights: { thinking: "high" }, roadmap: { thinking: "low" } },
		});
		render(<PageLlmSelector page="insights" />);
		await openPopover();
		await choose("Effort", "Ultra Think");
		await waitFor(() =>
			expect(api.saveSettings).toHaveBeenLastCalledWith({
				pageLlmOverrides: { insights: { thinking: "ultrathink" }, roadmap: { thinking: "low" } },
			}),
		);
		await choose("Effort", "As in settings (Medium)");
		await waitFor(() =>
			expect(api.saveSettings).toHaveBeenLastCalledWith({ pageLlmOverrides: { roadmap: { thinking: "low" } } }),
		);

		setSettings({ selectedProvider: "anthropic", pageLlmOverrides: { insights: { provider: "ollama" } } });
		await userEvent.click(screen.getByRole("button", { name: "Reset" }));
		await waitFor(() => expect(api.saveSettings).toHaveBeenLastCalledWith({ pageLlmOverrides: {} }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled());
	});

	it("says when the page's choice could not be saved, and clears it on the next save", async () => {
		api.saveSettings.mockResolvedValueOnce({ success: false, error: "disk full" });
		render(<PageLlmSelector page="insights" />);
		await openPopover();
		await choose("Effort", "Low");
		expect(await screen.findByRole("alert")).toHaveTextContent("This page's choice could not be saved.");
		// Nothing changed on the page.
		expect(trigger()).toHaveTextContent("· Medium");

		await choose("Effort", "High");
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		await waitFor(() => expect(trigger()).toHaveTextContent("· High"));
	});

	it("ignores a provider list that arrives after the page changed", async () => {
		let release!: (value: { isAuthenticated: boolean }) => void;
		api.checkClaudeOAuth.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
		const { unmount } = render(<PageLlmSelector page="insights" />);
		unmount();
		await act(async () => release({ isAuthenticated: true }));
		expect(api.checkClaudeOAuth).toHaveBeenCalled();
	});
});
