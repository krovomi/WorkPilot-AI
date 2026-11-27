/**
 * CleanProviderCard — one provider of Settings → AI accounts: its state in one
 * chip, how it signs in, the age of a stored key, its usage, and the next
 * thing to do (connect, sign in again, test, edit, make default).
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { CleanProviderCard, type ProviderCardData, providerCardStatus } from "../CleanProviderCard";

const DAY = 24 * 60 * 60 * 1000;
const t = (key: string, options?: Record<string, unknown>) => i18n.t(`settings:${key}`, options);

function provider(extra: Partial<ProviderCardData> = {}): ProviderCardData {
	return { id: "openai", name: "OpenAI", description: "GPT models", isConfigured: true, ...extra };
}

afterEach(cleanup);

describe("providerCardStatus", () => {
	it("puts a missing connection first, then a lost sign-in, then a failed test", () => {
		expect(providerCardStatus(provider({ isConfigured: false, isWorking: false }))).toBe("off");
		expect(
			providerCardStatus(provider({ isWorking: false, realUsageData: { needsReauthentication: true } as never })),
		).toBe("reauth");
		expect(providerCardStatus(provider({ isWorking: false }))).toBe("failing");
		expect(providerCardStatus(provider())).toBe("connected");
	});
});

describe("CleanProviderCard", () => {
	it("offers to connect a provider that is not connected", async () => {
		const onConfigure = vi.fn();
		render(<CleanProviderCard provider={provider({ isConfigured: false, description: undefined })} onConfigure={onConfigure} />);
		expect(screen.getByText(t("aiAccounts.card.status.off"))).toBeInTheDocument();
		expect(screen.queryByText(t("aiAccounts.card.test"))).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: t("aiAccounts.card.connect") }));
		expect(onConfigure).toHaveBeenCalledWith("openai");
	});

	it("says how a connected provider signs in, how old its key is and when it was tested", async () => {
		const onTest = vi.fn();
		const onConfigure = vi.fn();
		const onSetDefault = vi.fn();
		render(
			<CleanProviderCard
				provider={provider({
					lastTested: "2026-11-01T10:00:00.000Z",
					realApiKeyInfo: { hasKey: true, authMethod: "api-key", provider: "Work key", setAt: Date.now() - 3 * DAY },
				})}
				onTest={onTest}
				onConfigure={onConfigure}
				onSetDefault={onSetDefault}
			/>,
		);
		const meta = screen.getByText(/Work key/);
		expect(meta.textContent).toContain(t("aiAccounts.card.auth.api-key"));
		expect(meta.textContent).toContain(t("aiAccounts.card.keyAge", { count: 3 }));
		expect(meta.textContent).toContain(t("aiAccounts.card.lastTest", { date: "" }).trim());
		await userEvent.click(screen.getByRole("button", { name: t("aiAccounts.card.test") }));
		await userEvent.click(screen.getByRole("button", { name: t("aiAccounts.card.edit") }));
		await userEvent.click(screen.getByRole("button", { name: t("aiAccounts.card.setDefault") }));
		expect(onTest).toHaveBeenCalledWith("openai");
		expect(onConfigure).toHaveBeenCalledWith("openai");
		expect(onSetDefault).toHaveBeenCalledWith("openai");
	});

	it("dates a key set today and suggests renewing an old one", () => {
		const { rerender } = render(
			<CleanProviderCard provider={provider({ realApiKeyInfo: { hasKey: true, authMethod: "api-key", setAt: Date.now() } })} />,
		);
		expect(screen.getByText(new RegExp(t("aiAccounts.card.keyToday")))).toBeInTheDocument();
		expect(screen.getByText(new RegExp(t("aiAccounts.card.neverTested")))).toBeInTheDocument();
		rerender(
			<CleanProviderCard
				provider={provider({ realApiKeyInfo: { hasKey: true, authMethod: "api-key", setAt: Date.now() - 200 * DAY } })}
			/>,
		);
		expect(screen.getByText(/200/, { selector: "p.wp-ink" })).toBeInTheDocument();
	});

	it("never dates a key it has no date for, nor a sign-in", () => {
		render(
			<CleanProviderCard provider={provider({ realApiKeyInfo: { hasKey: true, authMethod: "oauth" } })} isDefault />,
		);
		expect(screen.getByText(new RegExp(t("aiAccounts.card.auth.oauth")))).toBeInTheDocument();
		expect(screen.queryByText(new RegExp(t("aiAccounts.card.keyToday")))).toBeNull();
		expect(screen.getByText(t("aiAccounts.card.default"))).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: t("aiAccounts.card.setDefault") })).toBeNull();
	});

	it("shows the usage, in the tone of how close it is to the limit", () => {
		const usage = (sessionPercent: number, weeklyPercent: number) =>
			({ sessionPercent, weeklyPercent, profileId: "p" }) as ProviderCardData["realUsageData"];
		const { rerender } = render(<CleanProviderCard provider={provider({ realUsageData: usage(40.4, 0) })} />);
		expect(screen.getByText(t("aiAccounts.card.usage", { session: 40 }))).toBeInTheDocument();
		rerender(<CleanProviderCard provider={provider({ realUsageData: usage(75, 30) })} />);
		expect(screen.getByText(t("aiAccounts.card.usageWeekly", { session: 75, weekly: 30 }))).toBeInTheDocument();
		rerender(<CleanProviderCard provider={provider({ realUsageData: usage(95, 30) })} />);
		expect(screen.getByText(t("aiAccounts.card.usageWeekly", { session: 95, weekly: 30 }))).toBeInTheDocument();
	});

	it("offers to sign in again, and shows a test in progress", async () => {
		const onConfigure = vi.fn();
		render(
			<CleanProviderCard
				provider={provider({ realUsageData: { needsReauthentication: true, sessionPercent: 1 } as never })}
				onConfigure={onConfigure}
				isTesting
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: t("aiAccounts.card.reconnect") }));
		expect(onConfigure).toHaveBeenCalledWith("openai", { startOAuth: true });
		expect(screen.getByRole("button", { name: t("aiAccounts.card.testing") })).toBeDisabled();
	});

	it("names the account it runs on and opens its accounts", async () => {
		const onManageAccounts = vi.fn();
		render(
			<CleanProviderCard
				provider={provider({
					realApiKeyInfo: { hasKey: true, authMethod: "api-key", provider: "Work key" },
					accounts: { count: 3, defaultName: "Client X" },
				})}
				onManageAccounts={onManageAccounts}
			/>,
		);
		const meta = screen.getByText(/Client X/);
		expect(meta.textContent).toContain(t("aiAccounts.card.account", { name: "Client X" }));
		expect(meta.textContent).not.toContain("Work key");
		await userEvent.click(screen.getByRole("button", { name: t("aiAccounts.card.accounts", { count: 3 }) }));
		expect(onManageAccounts).toHaveBeenCalledWith("openai");
	});

	it("offers its accounts even before it is connected, and not without a handler", () => {
		const { rerender } = render(
			<CleanProviderCard
				provider={provider({ isConfigured: false, accounts: { count: 0 } })}
				onManageAccounts={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: t("aiAccounts.card.accounts", { count: 0 }) })).toBeInTheDocument();
		rerender(<CleanProviderCard provider={provider({ accounts: { count: 2 } })} />);
		expect(screen.queryByRole("button", { name: t("aiAccounts.card.accounts", { count: 2 }) })).toBeNull();
	});

	it("works without any callback", async () => {
		const { rerender } = render(<CleanProviderCard provider={provider({ isConfigured: false })} />);
		await userEvent.click(screen.getByRole("button", { name: t("aiAccounts.card.connect") }));
		rerender(<CleanProviderCard provider={provider({ realUsageData: { needsReauthentication: true } as never })} />);
		await userEvent.click(screen.getByRole("button", { name: t("aiAccounts.card.reconnect") }));
		await userEvent.click(screen.getByRole("button", { name: t("aiAccounts.card.test") }));
		await userEvent.click(screen.getByRole("button", { name: t("aiAccounts.card.edit") }));
	});
});
