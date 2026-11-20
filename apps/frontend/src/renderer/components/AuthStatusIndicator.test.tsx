/**
 * @vitest-environment jsdom
 */
/**
 * The authentication badge of the tab bar: which provider the usage badges
 * observe, how it is signed in, and the details its tooltip gives for an API
 * profile, the Claude Code subscription, GitHub Copilot and Windsurf.
 */
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../shared/i18n";
import type { ClaudeProfile } from "../../shared/types/agent";
import type { APIProfile } from "../../shared/types/profile";
import { useClaudeProfileStore } from "../stores/claude-profile-store";
import { useSettingsStore } from "../stores/settings-store";
import { AuthStatusIndicator } from "./AuthStatusIndicator";
import { ProviderContext } from "./ProviderContext";

const PROFILES: APIProfile[] = [
	{
		id: "profile-1",
		name: "Production API",
		baseUrl: "https://api.anthropic.com",
		apiKey: "fake-key-1",
		createdAt: 1,
		updatedAt: 1,
	},
	{
		id: "profile-2",
		name: "Development API",
		baseUrl: "https://dev-api.example.com/v1",
		apiKey: "fake-key-2",
		createdAt: 1,
		updatedAt: 1,
	},
	{
		id: "profile-3",
		name: "Ollama Remote",
		baseUrl: "https://ollama.ai/api",
		apiKey: "fake-key-3",
		createdAt: 1,
		updatedAt: 1,
	},
	{
		id: "profile-4",
		name: "Ollama Local",
		baseUrl: "http://localhost:11434/v1",
		apiKey: "fake-key-4",
		createdAt: 1,
		updatedAt: 1,
	},
];

const api = {
	getGithubCliStatus: vi.fn(),
	detectWindsurfToken: vi.fn(),
};

function context(usageProvider: string) {
	return {
		selectedProvider: usageProvider,
		setSelectedProvider: vi.fn(),
		usageProvider,
		usageProviderChoice: null,
		setUsageProviderChoice: vi.fn(),
		runningProviders: [],
	};
}

function renderBadge(usageProvider = "") {
	const view = render(
		<ProviderContext.Provider value={context(usageProvider)}>
			<AuthStatusIndicator />
		</ProviderContext.Provider>,
	);
	return {
		...view,
		switchTo: (next: string) =>
			view.rerender(
				<ProviderContext.Provider value={context(next)}>
					<AuthStatusIndicator />
				</ProviderContext.Provider>,
			),
	};
}

/** Opens the tooltip (Radix renders its text twice). */
async function openDetails() {
	fireEvent.focus(screen.getByRole("button"));
	await screen.findAllByText("Authentication Details");
}

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	vi.clearAllMocks();
	useSettingsStore.setState({ profiles: PROFILES, activeProfileId: null });
	useClaudeProfileStore.setState({ profiles: [], activeProfileId: "default" });
	api.getGithubCliStatus.mockResolvedValue({
		success: true,
		data: { available: true, isAuth: true, username: "octocat" },
	});
	api.detectWindsurfToken.mockResolvedValue({ success: false });
	Object.assign(globalThis.electronAPI, api);
});

describe("AuthStatusIndicator badge", () => {
	it("shows the Claude Code subscription when no profile is active", async () => {
		useClaudeProfileStore.setState({
			profiles: [{ id: "default", name: "Default", subscriptionType: "claude_max" } as ClaudeProfile],
			activeProfileId: "default",
		});
		renderBadge();
		const badge = screen.getByRole("button", { name: "Authentication: Anthropic" });
		expect(badge).toHaveTextContent("Anthropic");
		expect(badge.className).toContain("text-orange-500");
		await openDetails();
		expect(screen.getAllByText("OAuth")[0]).toBeInTheDocument();
		expect(screen.getAllByText("Claude Code Max")[0]).toBeInTheDocument();
	});

	it.each([
		["pro", "Claude Code Pro"],
		["enterprise", "Claude Code"],
		[undefined, "Claude Code"],
	])("names the subscription %s", async (subscriptionType, label) => {
		useClaudeProfileStore.setState({
			profiles: [{ id: "default", name: "Default", subscriptionType } as ClaudeProfile],
			activeProfileId: "default",
		});
		// Anthropic observed without an API profile for it: the subscription.
		useSettingsStore.setState({ profiles: [] });
		renderBadge("anthropic");
		await openDetails();
		expect(screen.getAllByText(label)[0]).toBeInTheDocument();
	});

	it("shows the active API profile, its id and its endpoint", async () => {
		useSettingsStore.setState({ activeProfileId: "profile-1" });
		renderBadge();
		expect(screen.getByRole("button", { name: "Authentication: Anthropic" })).toBeInTheDocument();
		await openDetails();
		expect(screen.getAllByText("API Key")[0]).toBeInTheDocument();
		expect(screen.getAllByText("Production API")[0]).toBeInTheDocument();
		expect(screen.getAllByText("profile-1")[0]).toBeInTheDocument();
		expect(screen.getAllByText("https://api.anthropic.com")[0]).toBeInTheDocument();
		expect(screen.queryByText("Subscription")).not.toBeInTheDocument();
	});

	it("falls back to the subscription when the active profile no longer exists", () => {
		useSettingsStore.setState({ activeProfileId: "deleted-profile" });
		renderBadge();
		expect(screen.getByRole("button", { name: "Authentication: Anthropic" })).toBeInTheDocument();
	});

	it.each([
		["profile-3", "Ollama", "text-emerald-500"],
		["profile-4", "Ollama (Local)", "text-teal-500"],
	])("names the provider of profile %s from its address", (activeProfileId, label, color) => {
		useSettingsStore.setState({ activeProfileId });
		renderBadge();
		const badge = screen.getByRole("button", { name: `Authentication: ${label}` });
		expect(badge.className).toContain(color);
	});

	it("says in the person's language that a profile's provider is unknown", () => {
		useSettingsStore.setState({ activeProfileId: "profile-2" });
		const { unmount } = renderBadge();
		expect(screen.getByRole("button", { name: "Authentication: Unknown" })).toBeInTheDocument();
		unmount();
		void i18n.changeLanguage("fr");
		renderBadge();
		expect(screen.getByRole("button")).toHaveTextContent("Inconnu");
	});

	it("uses the profile that matches the observed provider", async () => {
		renderBadge("ollama_local");
		expect(screen.getByRole("button", { name: "Authentication: Ollama (Local)" })).toBeInTheDocument();
		await openDetails();
		expect(screen.getAllByText("Ollama Local")[0]).toBeInTheDocument();
	});

	it("names an observed provider that has no profile, even one it has no label for", async () => {
		const { switchTo } = renderBadge("openai");
		expect(screen.getByRole("button", { name: "Authentication: OpenAI" })).toBeInTheDocument();
		await openDetails();
		expect(
			screen.getAllByText("No profile configured for provider OpenAI.")[0],
		).toBeInTheDocument();

		switchTo("lm-studio");
		const badge = screen.getByRole("button", { name: "Authentication: lm-studio" });
		expect(badge).toHaveTextContent("lm-studio");
		expect(badge.className).not.toContain("undefined");
	});
});

describe("AuthStatusIndicator for GitHub Copilot", () => {
	it("shows the GitHub CLI account that signs Copilot in", async () => {
		renderBadge("copilot");
		await openDetails();
		expect(
			screen.getAllByText("GitHub Copilot uses GitHub CLI authentication (gh auth login).")[0],
		).toBeInTheDocument();
		expect((await screen.findAllByText("Connected"))[0]).toBeInTheDocument();
		expect(screen.getAllByText("@octocat")[0]).toBeInTheDocument();
		expect(screen.getAllByText("Usage data unavailable")[0]).toBeInTheDocument();
		expect(
			screen.getAllByRole("link", { name: "View GitHub Copilot dashboard →" })[0],
		).toHaveAttribute("href", "https://github.com/settings/copilot");
	});

	it("says the CLI is installed but signed out", async () => {
		api.getGithubCliStatus.mockResolvedValue({
			success: true,
			data: { available: true, isAuth: false },
		});
		renderBadge("copilot");
		await openDetails();
		expect((await screen.findAllByText("Not connected"))[0]).toBeInTheDocument();
		expect(screen.queryByText("Active Account")).not.toBeInTheDocument();
	});

	it.each([
		["the check fails", () => api.getGithubCliStatus.mockResolvedValue({ success: false })],
		["the check throws", () => api.getGithubCliStatus.mockRejectedValue(new Error("ipc down"))],
	])("says the CLI is missing when %s", async (_case, arrange) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		arrange();
		renderBadge("copilot");
		await openDetails();
		expect(
			(await screen.findAllByText(/GitHub CLI not available\. Install GitHub CLI and run/))[0],
		).toHaveTextContent("gh auth login");
		warn.mockRestore();
	});

	it("says it is checking, and drops an answer that comes after the provider changed", async () => {
		const answer = deferred<unknown>();
		api.getGithubCliStatus.mockReturnValue(answer.promise);
		const { switchTo } = renderBadge("copilot");
		await openDetails();
		expect(screen.getAllByText("Checking GitHub status...")[0]).toBeInTheDocument();

		switchTo("openai");
		api.getGithubCliStatus.mockReturnValue(new Promise(() => undefined));
		switchTo("copilot");
		await act(async () => {
			answer.resolve({ success: true, data: { available: true, isAuth: true, username: "late" } });
		});
		expect(screen.getAllByText("Checking GitHub status...")[0]).toBeInTheDocument();
		expect(screen.queryByText("@late")).not.toBeInTheDocument();
	});
});

describe("AuthStatusIndicator for Windsurf", () => {
	it("shows the account, the plan and the credits", async () => {
		api.detectWindsurfToken.mockResolvedValue({
			success: true,
			userName: "Ada",
			planName: "Pro",
			usageInfo: {
				usedMessages: 1250,
				totalMessages: 50000,
				usedFlowActions: 340,
				totalFlowActions: 100000,
			},
		});
		renderBadge("windsurf");
		await openDetails();
		expect(
			screen.getAllByText("Windsurf (Codeium) uses IDE-based authentication via local token.")[0],
		).toBeInTheDocument();
		expect((await screen.findAllByText("Ada"))[0]).toBeInTheDocument();
		expect(screen.getAllByText("Pro")[0]).toBeInTheDocument();
		expect(screen.getAllByText("Credits (messages)")[0].nextElementSibling).toHaveTextContent("13/500");
		expect(screen.getAllByText("Flow Actions")[0].nextElementSibling).toHaveTextContent("3/1000");
		expect(
			screen.getAllByRole("link", { name: "View Windsurf membership dashboard →" })[0],
		).toHaveAttribute("href", "https://windsurf.com/subscription/usage");
	});

	it("shows only what the account tells", async () => {
		api.detectWindsurfToken.mockResolvedValue({ success: true });
		renderBadge("windsurf");
		await openDetails();
		await waitFor(() => expect(screen.queryByText("Checking Windsurf account...")).not.toBeInTheDocument());
		expect(screen.queryByText("Active Account")).not.toBeInTheDocument();
		expect(screen.queryByText("Plan")).not.toBeInTheDocument();
		expect(screen.queryByText("Credits (messages)")).not.toBeInTheDocument();
		expect(screen.queryByText("Windsurf IDE not detected. Make sure Windsurf is running.")).not.toBeInTheDocument();
	});

	it.each([
		["the IDE is not found", () => api.detectWindsurfToken.mockResolvedValue({ success: false })],
		["the check throws", () => api.detectWindsurfToken.mockRejectedValue(new Error("ipc down"))],
	])("says Windsurf is not detected when %s", async (_case, arrange) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		arrange();
		renderBadge("windsurf");
		await openDetails();
		expect(
			(await screen.findAllByText("Windsurf IDE not detected. Make sure Windsurf is running."))[0],
		).toBeInTheDocument();
		warn.mockRestore();
	});

	it("says it is checking, and drops an answer that comes after the provider changed", async () => {
		const answer = deferred<unknown>();
		api.detectWindsurfToken.mockReturnValue(answer.promise);
		const { switchTo } = renderBadge("windsurf");
		await openDetails();
		expect(screen.getAllByText("Checking Windsurf account...")[0]).toBeInTheDocument();

		switchTo("anthropic");
		api.detectWindsurfToken.mockReturnValue(new Promise(() => undefined));
		switchTo("windsurf");
		await act(async () => {
			answer.resolve({ success: true, userName: "Late" });
		});
		expect(screen.getAllByText("Checking Windsurf account...")[0]).toBeInTheDocument();
		expect(screen.queryByText("Late")).not.toBeInTheDocument();
	});
});
