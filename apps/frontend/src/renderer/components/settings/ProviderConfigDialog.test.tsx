import type { ComponentProps, ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderConfigDialog } from "./ProviderConfigDialog";

vi.mock("react-i18next", () => {
	const t = (key: string) => key;
	return { useTranslation: () => ({ t }) };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("./ApiKeyConfigContent", () => ({
	ApiKeyConfigContent: () => <div>API form</div>,
}));
vi.mock("./GitHubCopilotConfig", () => ({ GitHubCopilotConfig: () => null }));
vi.mock("./OAuthAuthContent", () => ({
	OAuthAuthContent: (
		props: ComponentProps<typeof import("./OAuthAuthContent").OAuthAuthContent>,
	) => (
		<div>
			<button type="button" onClick={props.onOAuthAuth}>
				Start login
			</button>
			{props.authTerminal && (
				<button type="button" onClick={props.onAuthTerminalClose}>
					Close terminal
				</button>
			)}
			<span>
				{props.openAICodexStatus?.isAuthenticated
					? "Connected"
					: "Disconnected"}
			</span>
		</div>
	),
}));
vi.mock("../ui/dialog", () => {
	const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
	return {
		Dialog: Part,
		DialogContent: Part,
		DialogTitle: Part,
		DialogDescription: Part,
		DialogHeader: Part,
		DialogFooter: Part,
	};
});
vi.mock("../ui/tabs", () => ({
	Tabs: ({
		value,
		onValueChange,
		children,
	}: {
		value: string;
		onValueChange: (value: string) => void;
		children: ReactNode;
	}) => (
		<div>
			<button type="button" onClick={() => onValueChange("oauth")}>
				OAuth tab
			</button>
			<span data-testid="active-tab">{value}</span>
			{children}
		</div>
	),
	TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	TabsTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const provider = { id: "openai", name: "OpenAI", isConfigured: false };
const props = {
	isOpen: true,
	useSheet: true,
	provider,
	settings: {},
	onOpenChange: vi.fn(),
	onSettingsChange: vi.fn(),
	onProviderActivated: vi.fn(),
};
beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	window.electronAPI.checkOpenAICodexOAuth = vi
		.fn()
		.mockResolvedValue({ isAuthenticated: false });
});
afterEach(() => vi.useRealTimers());

describe("provider authentication lifecycle", () => {
	it("keeps the OAuth tab open when unrelated settings update", async () => {
		const view = render(<ProviderConfigDialog {...props} />);
		fireEvent.click(screen.getByText("OAuth tab"));
		await act(async () => {
			/* Flush status verification. */
		});
		view.rerender(
			<ProviderConfigDialog {...props} settings={{ language: "fr" }} />,
		);
		expect(screen.getByTestId("active-tab").textContent).toBe("oauth");
	});

	it("saves a verified login when the terminal closes before the next poll", async () => {
		render(<ProviderConfigDialog {...props} />);
		fireEvent.click(screen.getByText("OAuth tab"));
		await act(async () => {
			/* Flush status verification. */
		});
		fireEvent.click(screen.getByText("Start login"));
		vi.mocked(window.electronAPI.checkOpenAICodexOAuth).mockResolvedValue({
			isAuthenticated: true,
			profileName: "Codex",
		});
		await act(async () => {
			fireEvent.click(screen.getByText("Close terminal"));
		});
		expect(props.onSettingsChange).toHaveBeenCalledWith(
			expect.objectContaining({
				globalOpenAIAuthMode: "codex-cli",
				globalOpenAICodexOAuthToken: "Codex",
			}),
		);
	});

	it("offers verification and saving on the OpenAI OAuth tab", async () => {
		render(<ProviderConfigDialog {...props} />);
		fireEvent.click(screen.getByText("OAuth tab"));
		await act(async () => {
			/* Flush status verification. */
		});
		expect(screen.getByRole("button", { name: "actions.save" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "actions.test" })).toBeTruthy();
	});
});

it("does not save an unverified login", async () => {
	render(<ProviderConfigDialog {...props} />);
	fireEvent.click(screen.getByText("OAuth tab"));
	await act(async () => {
		/* Flush status verification. */
	});
	fireEvent.click(screen.getByText("Start login"));
	await act(async () => {
		fireEvent.click(screen.getByText("Close terminal"));
	});
	expect(props.onSettingsChange).not.toHaveBeenCalled();
});
it("ignores a verification finishing after unmount", async () => {
	const view = render(<ProviderConfigDialog {...props} />);
	fireEvent.click(screen.getByText("OAuth tab"));
	await act(async () => {
		/* Flush status verification. */
	});
	fireEvent.click(screen.getByText("Start login"));
	let resolve!: (value: { isAuthenticated: boolean }) => void;
	vi.mocked(window.electronAPI.checkOpenAICodexOAuth).mockImplementation(
		() =>
			new Promise((r) => {
				resolve = r;
			}),
	);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1000);
	});
	view.unmount();
	await act(async () => {
		resolve({ isAuthenticated: true });
	});
	expect(props.onSettingsChange).not.toHaveBeenCalled();
});
it("does not activate a provider when persistence fails", async () => {
	const save = vi.fn().mockResolvedValue(false);
	render(<ProviderConfigDialog {...props} onSettingsChange={save} />);
	fireEvent.click(screen.getByText("OAuth tab"));
	await act(async () => {
		/* Flush status verification. */
	});
	vi.mocked(window.electronAPI.checkOpenAICodexOAuth).mockResolvedValue({
		isAuthenticated: true,
	});
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "actions.save" }));
	});
	expect(props.onProviderActivated).not.toHaveBeenCalled();
	expect(props.onOpenChange).not.toHaveBeenCalled();
});

it("continues polling across rerenders and saves the latest settings", async () => {
	const view = render(<ProviderConfigDialog {...props} />);
	fireEvent.click(screen.getByText("OAuth tab"));
	await act(async () => {
		/* Flush initial status. */
	});
	fireEvent.click(screen.getByText("Start login"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(500);
	});
	const save = vi.fn();
	view.rerender(
		<ProviderConfigDialog
			{...props}
			settings={{ language: "fr" }}
			onSettingsChange={save}
		/>,
	);
	vi.mocked(window.electronAPI.checkOpenAICodexOAuth).mockResolvedValue({
		isAuthenticated: true,
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(500);
	});
	expect(save).toHaveBeenCalledWith(
		expect.objectContaining({
			language: "fr",
			globalOpenAIAuthMode: "codex-cli",
		}),
	);
	expect(screen.queryByText("Close terminal")).toBeNull();
});

it("waits for persistence before activating the provider", async () => {
	let finishSave!: () => void;
	const save = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finishSave = resolve;
			}),
	);
	render(<ProviderConfigDialog {...props} onSettingsChange={save} />);
	fireEvent.click(screen.getByText("OAuth tab"));
	await act(async () => {
		/* Flush initial status. */
	});
	vi.mocked(window.electronAPI.checkOpenAICodexOAuth).mockResolvedValue({
		isAuthenticated: true,
	});
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "actions.save" }));
	});
	expect(props.onProviderActivated).not.toHaveBeenCalled();
	expect(props.onOpenChange).not.toHaveBeenCalled();
	await act(async () => {
		finishSave();
	});
	expect(props.onProviderActivated).toHaveBeenCalledWith("openai");
	expect(props.onOpenChange).toHaveBeenCalledWith(false);
});
