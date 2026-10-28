import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppSettings } from "../../../shared/types";
import i18n from "../../../shared/i18n";
import en from "../../../shared/i18n/locales/en/settings.json";
import fr from "../../../shared/i18n/locales/fr/settings.json";
import { NeedsYouChannels, randomTopic } from "./NeedsYouChannels";

const base = { notifications: { onTaskComplete: true, onTaskFailed: true, onReviewNeeded: true, sound: false } } as AppSettings;

beforeEach(async () => {
	await i18n.changeLanguage("en");
	Object.assign(window.electronAPI, {
		testNeedsYou: vi.fn().mockResolvedValue({ success: true, data: { ntfy: "sent", telegram: "off" } }),
	});
});
afterEach(cleanup);

it("generates a long random topic when ntfy is switched on", () => {
	const onChange = vi.fn();
	render(<NeedsYouChannels settings={base} onSettingsChange={onChange} />);
	fireEvent.click(screen.getByRole("switch", { name: "ntfy" }));
	const next = onChange.mock.calls[0][0] as AppSettings;
	expect(next.needsYou?.ntfy?.enabled).toBe(true);
	expect(next.needsYou?.ntfy?.topic).toMatch(/^workpilot-[A-Za-z0-9_-]{24}$/);
});

it("keeps random topics apart", () => {
	expect(randomTopic()).not.toBe(randomTopic());
});

it("stores the bot token as an app secret, not inside needsYou", () => {
	const onChange = vi.fn();
	const settings = { ...base, needsYou: { telegram: { enabled: true, chatId: "", remoteApproval: false } } } as AppSettings;
	render(<NeedsYouChannels settings={settings} onSettingsChange={onChange} />);
	fireEvent.change(screen.getByLabelText("Bot token"), { target: { value: "123:abc" } });
	const next = onChange.mock.calls[0][0] as AppSettings;
	expect(next.globalTelegramBotToken).toBe("123:abc");
	expect(JSON.stringify(next.needsYou)).not.toContain("123:abc");
});

it("reports what the test reached", async () => {
	render(<NeedsYouChannels settings={base} onSettingsChange={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: "Send a test" }));
	await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("ntfy: sent · Telegram: not configured"));
});

it("ships matching French and English keys", () => {
	function keys(value: object, prefix = ""): string[] {
		return Object.entries(value).flatMap(([key, item]) =>
			typeof item === "object" ? keys(item, `${prefix}${key}.`) : [`${prefix}${key}`],
		);
	}
	expect(keys(fr.needsYou).sort()).toEqual(keys(en.needsYou).sort());
});
