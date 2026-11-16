/**
 * The default provider picker of Settings → Agent: it lists the providers,
 * says which are signed in, sends the choice to the main process and keeps it
 * in ProviderContext.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProvidersResponse } from "@shared/utils/providers";
import { useSettingsStore } from "../../stores/settings-store";
import { ProviderContextProvider, useProviderContext } from "../ProviderContext";
import { ProviderSelector } from "../ProviderSelector";

const mocks = vi.hoisted(() => ({
	getStaticProviders: vi.fn(),
	toast: vi.fn(),
}));

vi.mock("@shared/utils/providers", () => ({
	getStaticProviders: mocks.getStaticProviders,
}));

vi.mock("@/hooks/use-toast", () => ({
	useToast: () => ({ toast: mocks.toast }),
}));

const PROVIDERS: ProvidersResponse = {
	providers: [
		{ name: "openai", label: "OpenAI", description: "GPT models" },
		{ name: "anthropic", label: "Anthropic", description: "Claude models" },
		{ name: "zeta", label: "zeta cloud", description: "No icon of its own" },
	],
	status: { openai: true, anthropic: true },
};

const selectProvider = vi.fn();
const setActiveProfile = vi.fn();
const updateSettings = vi.fn();

/** What the context holds, for the assertions. */
function ContextProbe() {
	const { selectedProvider } = useProviderContext();
	return <output data-testid="context">{selectedProvider}</output>;
}

function renderSelector(onOpenAccountsSettings?: () => void) {
	return render(
		<ProviderContextProvider>
			<ProviderSelector onOpenAccountsSettings={onOpenAccountsSettings} />
			<ContextProbe />
		</ProviderContextProvider>,
	);
}

/** Radix Select opens from the keyboard in jsdom (no pointer capture). */
async function openList() {
	act(() => screen.getByRole("combobox").focus());
	await userEvent.keyboard("[ArrowDown]");
}

async function choose(label: string | RegExp) {
	await openList();
	await userEvent.click(
		await screen.findByRole("option", {
			name: typeof label === "string" ? new RegExp(label) : label,
		}),
	);
}

describe("ProviderSelector", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		localStorage.clear();
		mocks.getStaticProviders.mockResolvedValue(PROVIDERS);
		selectProvider.mockResolvedValue({ success: true });
		Object.assign(globalThis.electronAPI, { selectProvider });
		useSettingsStore.setState({
			profiles: [
				{ id: "prof-openai", name: "Work", baseUrl: "https://api.openai.com/v1" },
			] as never,
			settings: {} as never,
			setActiveProfile,
			updateSettings,
		});
	});

	it("chooses Anthropic by default and remembers it", async () => {
		renderSelector();

		await waitFor(() => expect(screen.getByTestId("context")).toHaveTextContent("anthropic"));
		expect(localStorage.getItem("selectedProvider")).toBe("anthropic");
		// Nothing is sent to the main process for a default.
		expect(selectProvider).not.toHaveBeenCalled();
	});

	it("falls back to the first provider when Anthropic is not offered", async () => {
		mocks.getStaticProviders.mockResolvedValue({
			providers: [PROVIDERS.providers[0]],
			status: PROVIDERS.status,
		});
		renderSelector();

		await waitFor(() => expect(screen.getByTestId("context")).toHaveTextContent("openai"));
	});

	it("keeps the provider chosen earlier", async () => {
		localStorage.setItem("selectedProvider", "openai");
		renderSelector();

		await waitFor(() => expect(mocks.getStaticProviders).toHaveBeenCalled());
		expect(screen.getByTestId("context")).toHaveTextContent("openai");
		expect(screen.getByRole("combobox")).toHaveTextContent("OpenAI");
	});

	it("lists each provider with its sign-in state", async () => {
		renderSelector();
		await waitFor(() => expect(screen.getByTestId("context")).toHaveTextContent("anthropic"));
		await openList();

		const openai = await screen.findByRole("option", { name: /OpenAI/ });
		expect(openai).toHaveTextContent("OK");
		const zeta = screen.getByRole("option", { name: /zeta cloud/ });
		expect(zeta).toHaveTextContent("Not authenticated");
		// A provider without a logo gets its initial.
		expect(screen.getByRole("img", { name: "zeta cloud" })).toHaveTextContent("Z");
	});

	it("sends a signed-in choice to the main process and everywhere else", async () => {
		const changed = vi.fn();
		globalThis.addEventListener("providerChanged", changed);
		renderSelector();
		await waitFor(() => expect(screen.getByTestId("context")).toHaveTextContent("anthropic"));

		await choose("OpenAI");

		await waitFor(() => expect(screen.getByTestId("context")).toHaveTextContent("openai"));
		expect(selectProvider).toHaveBeenCalledWith("openai");
		expect(localStorage.getItem("selectedProvider")).toBe("openai");
		expect(setActiveProfile).toHaveBeenCalledWith("prof-openai");
		expect(updateSettings).toHaveBeenCalledWith({ selectedProvider: "openai" });
		expect(changed).toHaveBeenCalledTimes(1);
		expect((changed.mock.calls[0][0] as CustomEvent).detail.provider).toBe("openai");
		globalThis.removeEventListener("providerChanged", changed);
	});

	it("leaves no profile active for a provider without one", async () => {
		localStorage.setItem("selectedProvider", "openai");
		renderSelector();

		await choose("Anthropic");

		await waitFor(() => expect(setActiveProfile).toHaveBeenCalledWith(null));
	});

	it.each([
		["refuses", () => selectProvider.mockResolvedValue({ success: false, error: "no key" })],
		["fails", () => selectProvider.mockRejectedValue(new Error("ipc down"))],
	])("keeps the previous choice when the main process %s", async (_l, arrange) => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		arrange();
		renderSelector();
		await waitFor(() => expect(screen.getByTestId("context")).toHaveTextContent("anthropic"));

		await choose("OpenAI");

		await waitFor(() =>
			expect(mocks.toast).toHaveBeenCalledWith({
				title: "Unable to change provider",
				variant: "destructive",
			}),
		);
		expect(screen.getByTestId("context")).toHaveTextContent("anthropic");
		expect(updateSettings).not.toHaveBeenCalled();
		expect(screen.getByRole("combobox")).toBeEnabled();
	});

	it("sends a provider that is not signed in to the accounts", async () => {
		const openAccounts = vi.fn();
		renderSelector(openAccounts);

		await choose("zeta cloud");

		expect(selectProvider).not.toHaveBeenCalled();
		expect(await screen.findByText(/The provider "zeta cloud" is not yet configured\./)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Go to Accounts" }));

		expect(openAccounts).toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith({
			title: "Redirect to Accounts",
			description: "Configuration of zeta cloud required",
			duration: 3000,
		});
		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
	});

	it("names a provider without a label by its id", async () => {
		mocks.getStaticProviders.mockResolvedValue({
			providers: [...PROVIDERS.providers, { name: "ghost", label: "", description: "" }],
			status: PROVIDERS.status,
		});
		renderSelector();
		await waitFor(() => expect(screen.getByTestId("context")).toHaveTextContent("anthropic"));

		await choose(/^Not authenticated$/);

		expect(await screen.findByText(/The provider "ghost" is not yet configured\./)).toBeInTheDocument();
	});

	it("closes the sign-in question on Cancel", async () => {
		renderSelector();
		await choose("zeta cloud");

		await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
	});

	it("shows loading, then no provider, then a failure as none", async () => {
		let resolve!: (value: ProvidersResponse) => void;
		mocks.getStaticProviders.mockReturnValue(new Promise((r) => (resolve = r)));
		const { unmount } = renderSelector();
		await openList();
		expect(await screen.findByRole("option", { name: "Loading..." })).toBeInTheDocument();
		await act(async () => resolve({ providers: [], status: {} }));
		expect(await screen.findByRole("option", { name: "No providers available" })).toBeInTheDocument();
		unmount();

		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.getStaticProviders.mockRejectedValue(new Error("boom"));
		renderSelector();
		await waitFor(() => expect(mocks.getStaticProviders).toHaveBeenCalled());
		await openList();
		expect(await screen.findByRole("option", { name: "No providers available" })).toBeInTheDocument();
	});

	it("still works when storage refuses to write", async () => {
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota");
		});
		try {
			renderSelector();
			await waitFor(() => expect(screen.getByTestId("context")).toHaveTextContent("anthropic"));
		} finally {
			setItem.mockRestore();
		}
	});
});
