/** @vitest-environment jsdom */
/**
 * The AI account a project or a card pins per provider: a row per provider
 * with a choice, the inherited account named first, a pick sent as an id, a
 * pin to a deleted account still shown so it can be removed.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAccountView } from "../../../../shared/types/ai-accounts";
import { useAiAccountsStore } from "../../../stores/ai-accounts-store";
import { useClaudeProfileStore } from "../../../stores/claude-profile-store";
import { AiAccountPinsEditor, accountPinRows } from "../AiAccountPinsEditor";

vi.mock("react-i18next", () => {
	const t = (key: string, options?: { name?: string }) =>
		options?.name !== undefined ? `${key}:${options.name}` : key;
	return { useTranslation: () => ({ t }) };
});

// Radix Select needs pointer capture jsdom lacks: a list of options stands in.
const SelectContext = createContext<(value: string) => void>(() => undefined);
vi.mock("../../ui/select", () => ({
	Select: ({
		value,
		onValueChange,
		disabled,
		children,
	}: {
		value: string;
		onValueChange: (value: string) => void;
		disabled?: boolean;
		children: ReactNode;
	}) => (
		<SelectContext.Provider value={onValueChange}>
			<fieldset data-value={value} disabled={disabled}>
				{children}
			</fieldset>
		</SelectContext.Provider>
	),
	SelectTrigger: ({ id }: { id: string }) => <span data-trigger={id} />,
	SelectValue: () => null,
	SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
	SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
		const choose = useContext(SelectContext);
		return (
			<button type="button" data-option={value} onClick={() => choose(value)}>
				{children}
			</button>
		);
	},
}));

const account = (id: string, name: string, provider: string, hasKey = true): AiAccountView => ({
	id,
	provider,
	name,
	hasKey,
	createdAt: "2026-11-27T10:00:00.000Z",
});

const bridge = {
	listAiAccounts: vi.fn(async () => ({
		success: true,
		data: { accounts: [account("o1", "Perso", "openai")], defaults: {}, mainKeys: [] },
	})),
	getClaudeProfiles: vi.fn(async () => ({
		success: true,
		data: { profiles: [], activeProfileId: "default" },
	})),
};

const profile = (id: string, name: string, email?: string) => ({
	id,
	name,
	email,
	isDefault: id === "default",
	createdAt: new Date(0),
});

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockClear();
	useAiAccountsStore.setState({
		accounts: [
			account("o1", "Perso", "openai"),
			account("o2", "Client", "openai"),
			account("o3", "Empty", "openai", false),
			account("g1", "Work", "google"),
		],
		defaults: { openai: "o1" },
		mainKeys: ["openai"],
		loaded: true,
		error: null,
	});
	useClaudeProfileStore.setState({
		profiles: [profile("default", "Primary", "me@example.com"), profile("team", "Team")],
		activeProfileId: "default",
	});
	(globalThis as { electronAPI?: unknown }).electronAPI = bridge;
	(globalThis as { window: { electronAPI?: unknown } }).window.electronAPI = bridge;
});

afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

function row(provider: string) {
	return screen.getByText(provider).parentElement as HTMLElement;
}

describe("AiAccountPinsEditor", () => {
	it("offers each provider with a choice its accounts, the default named first", () => {
		render(
			<AiAccountPinsEditor
				providers={["anthropic", "openai", "gemini", "ollama"]}
				value={undefined}
				onChange={vi.fn()}
				scope="project"
				idPrefix="p"
			/>,
		);
		const openai = within(row("OpenAI (ChatGPT)"));
		expect(openai.getByText("settings:aiAccounts.pins.inheritDefault:Perso")).toBeInTheDocument();
		expect(openai.getByText("Client")).toBeInTheDocument();
		expect(openai.queryByText("Empty")).not.toBeInTheDocument();
		expect(
			within(row("Anthropic (Claude)")).getByText("settings:aiAccounts.pins.inheritDefault:Primary (me@example.com)"),
		).toBeInTheDocument();
		expect(screen.getByText("settings:aiAccounts.pins.projectDescription")).toBeInTheDocument();
		expect(screen.queryByText(/Ollama/)).not.toBeInTheDocument();
	});

	it("sends the picked account as an id, and the inherited entry as no pin", () => {
		const onChange = vi.fn();
		render(
			<AiAccountPinsEditor
				providers={["openai"]}
				value={{ openai: "o2", google: "g1" }}
				onChange={onChange}
				scope="card"
				idPrefix="c"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Perso" }));
		expect(onChange).toHaveBeenLastCalledWith({ openai: "o1", google: "g1" });
		fireEvent.click(screen.getByRole("button", { name: /inheritDefault/ }));
		expect(onChange).toHaveBeenLastCalledWith({ google: "g1" });
	});

	it("names the project's account as what a card inherits", () => {
		render(
			<AiAccountPinsEditor
				providers={["openai", "claude"]}
				value={undefined}
				inherited={{ openai: "o2", claude: "gone" }}
				onChange={vi.fn()}
				scope="card"
				idPrefix="c"
				disabled
			/>,
		);
		expect(screen.getByText("settings:aiAccounts.pins.inheritProject:Client")).toBeInTheDocument();
		// A project pin to a profile that is gone names the first one.
		expect(
			screen.getByText("settings:aiAccounts.pins.inheritProject:Primary (me@example.com)"),
		).toBeInTheDocument();
		expect(screen.getByText("settings:aiAccounts.pins.cardDescription")).toBeInTheDocument();
	});

	it("shows nothing when no provider has a choice, and loads what it lacks", () => {
		useAiAccountsStore.setState({ accounts: [], defaults: {}, mainKeys: [], loaded: false });
		useClaudeProfileStore.setState({
			profiles: undefined as unknown as [],
			activeProfileId: "default",
		});
		const { container } = render(
			<AiAccountPinsEditor
				providers={["claude", "mistral"]}
				value={undefined}
				onChange={vi.fn()}
				scope="card"
				idPrefix="c"
			/>,
		);
		expect(container).toBeEmptyDOMElement();
		expect(bridge.listAiAccounts).toHaveBeenCalled();
		expect(bridge.getClaudeProfiles).toHaveBeenCalled();
	});
});

describe("accountPinRows", () => {
	const snapshot = {
		accounts: [account("m1", "Client", "mistral")],
		defaults: {},
		claudeProfiles: [{ id: "only", name: "Only" }],
		activeClaudeProfileId: "only",
	};
	const labels = { mainKey: "Main key", removed: "Deleted" };

	it("keeps a pin to a deleted account so it can be removed", () => {
		expect(
			accountPinRows(["mistral", "deepseek"], snapshot, labels, undefined, { deepseek: "gone" }),
		).toEqual([
			{ provider: "mistral", choices: [{ id: "m1", name: "Client" }], inheritedName: "Main key" },
			{ provider: "deepseek", choices: [{ id: "gone", name: "Deleted" }], inheritedName: "Main key" },
		]);
	});

	it("leaves out Claude with a single profile, unless it is pinned", () => {
		expect(accountPinRows(["claude"], snapshot, labels)).toEqual([]);
		expect(accountPinRows(["claude"], { ...snapshot, claudeProfiles: [] }, labels, undefined, { claude: "x" })).toEqual([
			{ provider: "claude", choices: [{ id: "x", name: "Deleted" }], inheritedName: "Deleted" },
		]);
		expect(
			accountPinRows(["claude"], { ...snapshot, claudeProfiles: [] }, labels, { claude: "y" }, {}),
		).toEqual([]);
	});
});
