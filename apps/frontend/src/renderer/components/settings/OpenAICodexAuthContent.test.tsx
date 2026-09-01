import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OpenAICodexAuthContent } from "./OAuthAuthContent";

const labels: Record<string, string> = {
	"sections.accounts.providerConfig.openaiAuth.description":
		"Reuse your Codex CLI ChatGPT session.",
	"sections.accounts.providerConfig.openaiAuth.login": "Sign in with ChatGPT",
	"sections.accounts.providerConfig.openaiAuth.authenticating": "Signing in…",
	"sections.accounts.providerConfig.openaiAuth.connected": "Connected account",
	"sections.accounts.providerConfig.openaiAuth.reconnect": "Reconnect",
};
const t = (key: string) => labels[key] ?? key;

describe("OpenAICodexAuthContent", () => {
	it("offers Codex CLI login", () => {
		const onLogin = vi.fn();

		render(
			<OpenAICodexAuthContent
				isAuthenticating={false}
				authTerminal={null}
				isAuthenticated={false}
				t={t}
				onOAuthAuth={onLogin}
				onAuthTerminalClose={vi.fn()}
				onAuthTerminalSuccess={vi.fn()}
				onAuthTerminalError={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));

		expect(onLogin).toHaveBeenCalledOnce();
	});

	it("shows the live account and allows reconnecting", () => {
		const onLogin = vi.fn();

		render(
			<OpenAICodexAuthContent
				isAuthenticating={false}
				authTerminal={null}
				isAuthenticated={true}
				profileName="user@example.com"
				t={t}
				onOAuthAuth={onLogin}
				onAuthTerminalClose={vi.fn()}
				onAuthTerminalSuccess={vi.fn()}
				onAuthTerminalError={vi.fn()}
			/>,
		);

		expect(screen.getByText("user@example.com")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
		expect(onLogin).toHaveBeenCalledOnce();
	});
});
