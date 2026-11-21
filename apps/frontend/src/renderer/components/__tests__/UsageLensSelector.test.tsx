/**
 * Which provider the usage badges observe: automatic (the running tasks) or one
 * picked by hand. It never changes what a task runs on.
 *
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task } from "../../../shared/types";
import { useTaskStore } from "../../stores/task-store";
import { ProviderContextProvider } from "../ProviderContext";
import { TooltipProvider } from "../ui/tooltip";
import { UsageLensSelector } from "../UsageLensSelector";

const originalApi = globalThis.electronAPI;

function runningTask(id: string, provider: string): Task {
	return {
		id,
		specId: id,
		projectId: "p1",
		title: id,
		description: "",
		status: "in_progress",
		subtasks: [],
		logs: [],
		metadata: { provider },
		executionProgress: { phase: "coding", phaseProgress: 0, overallProgress: 0 },
		createdAt: new Date(),
		updatedAt: new Date(),
	} as Task;
}

function renderLens() {
	return render(
		<TooltipProvider>
			<ProviderContextProvider>
				<UsageLensSelector />
			</ProviderContextProvider>
		</TooltipProvider>,
	);
}

const trigger = () => screen.getByRole("combobox", { name: "Provider shown by the usage badges" });

async function openList() {
	fireEvent.keyDown(trigger(), { key: "Enter" });
	return screen.findByRole("listbox");
}

describe("UsageLensSelector", () => {
	beforeAll(() => {
		Element.prototype.scrollIntoView = vi.fn();
		Element.prototype.hasPointerCapture = vi.fn(() => false);
		Element.prototype.releasePointerCapture = vi.fn();
	});

	beforeEach(async () => {
		localStorage.clear();
		useTaskStore.setState({ tasks: [] });
		// Signed in to Claude; Ollama is always there.
		(globalThis as unknown as { electronAPI: unknown }).electronAPI = new Proxy(
			{
				checkClaudeOAuth: vi.fn(async () => ({ isAuthenticated: true })),
				invoke: vi.fn(async () => ({ installed: false, authenticated: false })),
			} as Record<string, unknown>,
			{ get: (target, key: string) => target[key] ?? vi.fn(async () => undefined) },
		);
		await i18n.changeLanguage("en");
	});

	afterEach(() => {
		(globalThis as unknown as { electronAPI: unknown }).electronAPI = originalApi;
	});

	it("follows the running tasks, listing their providers first", async () => {
		useTaskStore.setState({ tasks: [runningTask("t1", "ollama")] });
		renderLens();
		await waitFor(() => expect(trigger().textContent).toMatch(/^Automatic \(Ollama/));

		const list = await openList();
		const options = within(list).getAllByRole("option").map((o) => o.textContent);
		expect(options[0]).toMatch(/^Automatic \(Ollama/);
		expect(options[1]).toMatch(/^Ollama.* — running$/);
		expect(options.some((o) => /Anthropic/.test(o ?? ""))).toBe(true);
		expect(options.findIndex((o) => /Anthropic/.test(o ?? ""))).toBeGreaterThan(1);
	});

	it("says just Automatic when nothing tells it which account to watch", async () => {
		renderLens();
		await waitFor(() => expect(trigger().textContent).toBe("Automatic"));
	});

	it("pins a provider by hand, remembers it, and goes back to automatic", async () => {
		const { unmount } = renderLens();
		const list = await openList();
		await waitFor(() => expect(within(list).getAllByRole("option").length).toBeGreaterThan(1));
		fireEvent.click(within(list).getByRole("option", { name: /Anthropic/ }));

		expect(trigger().textContent).toMatch(/Anthropic/);
		expect(localStorage.getItem("usageProvider")).toBe("anthropic");
		unmount();

		renderLens();
		await waitFor(() => expect(trigger().textContent).toMatch(/Anthropic/));
		const again = await openList();
		fireEvent.click(within(again).getByRole("option", { name: /^Automatic/ }));
		expect(localStorage.getItem("usageProvider")).toBeNull();
	});

	it("keeps a remembered provider that is no longer configured", async () => {
		localStorage.setItem("usageProvider", "mistral");
		renderLens();
		// Named by its label, as everywhere the header names a provider.
		expect(trigger().textContent).toBe("Mistral AI");
		const list = await openList();
		expect(within(list).getByRole("option", { name: "Mistral AI" })).toBeTruthy();
	});

	it("explains itself on focus, but never over the open list", async () => {
		renderLens();
		const wrapper = trigger().parentElement as HTMLElement;
		fireEvent.focus(wrapper);
		const tip = /Which provider's usage the badges show/;
		expect((await screen.findAllByText(tip)).length).toBeGreaterThan(0);

		await openList();
		expect(screen.queryAllByText(tip)).toHaveLength(0);

		// Closing hands focus back, which must not bring the tooltip back...
		fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
		fireEvent.focus(wrapper);
		expect(screen.queryAllByText(tip)).toHaveLength(0);

		// ...until the pointer has left once.
		fireEvent.pointerLeave(wrapper);
		fireEvent.blur(wrapper);
		await act(async () => {
			fireEvent.focus(wrapper);
		});
		expect((await screen.findAllByText(tip)).length).toBeGreaterThan(0);
	});
});
