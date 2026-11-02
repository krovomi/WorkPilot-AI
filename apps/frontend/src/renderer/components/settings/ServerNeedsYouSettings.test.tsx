/** @vitest-environment jsdom */
/**
 * My notifications from the server: a stored secret shows as stored and is
 * kept when its field stays empty, a new one is sent once, a channel can be
 * tested and removed, and the operator's switch and the vault are explained.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import { ServerNeedsYouSettings } from "./ServerNeedsYouSettings";

const bridge = {
	getNeedsYou: vi.fn(),
	saveNeedsYouChannel: vi.fn(),
	deleteNeedsYouChannel: vi.fn(),
	testNeedsYouChannel: vi.fn(),
	saveNeedsYouPreferences: vi.fn(),
};

function overview(patch: Record<string, unknown> = {}) {
	return {
		success: true,
		data: {
			available: true,
			vault: true,
			locale: "en",
			events: { plan_review: true, review_ready: true, failed: true },
			channels: {
				ntfy: { configured: false },
				telegram: {
					configured: true,
					enabled: true,
					readable: true,
					bot_token: "********",
					chat_id: "42",
				},
				teams: { configured: false },
			},
			...patch,
		},
	};
}

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockReset();
	bridge.getNeedsYou.mockResolvedValue(overview());
	bridge.saveNeedsYouChannel.mockResolvedValue({ success: true });
	bridge.deleteNeedsYouChannel.mockResolvedValue({ success: true });
	bridge.testNeedsYouChannel.mockResolvedValue({ success: true, data: "sent" });
	bridge.saveNeedsYouPreferences.mockResolvedValue({ success: true });
	(globalThis as { electronAPI?: unknown }).electronAPI = { serverAuth: bridge };
});

afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("ServerNeedsYouSettings", () => {
	it("keeps a stored secret when its field stays empty", async () => {
		render(<ServerNeedsYouSettings />);
		const token = await screen.findByLabelText("Bot token");
		expect(token).toHaveValue("");
		expect(token).toHaveAttribute("type", "password");
		expect(screen.getByLabelText("Chat id")).toHaveValue("42");
		fireEvent.click(screen.getAllByRole("button", { name: "Save" })[1]);
		await waitFor(() =>
			expect(bridge.saveNeedsYouChannel).toHaveBeenCalledWith("telegram", {
				enabled: true,
				chat_id: "42",
			}),
		);
	});

	it("sends a new secret once", async () => {
		render(<ServerNeedsYouSettings />);
		const url = await screen.findByLabelText("Webhook URL");
		fireEvent.change(url, {
			target: { value: "https://contoso.webhook.office.com/webhookb2/fake" },
		});
		fireEvent.click(screen.getAllByRole("button", { name: "Save" })[2]);
		await waitFor(() =>
			expect(bridge.saveNeedsYouChannel).toHaveBeenCalledWith("teams", {
				enabled: true,
				webhook_url: "https://contoso.webhook.office.com/webhookb2/fake",
			}),
		);
		await waitFor(() => expect(url).toHaveValue(""));
	});

	it("tests and removes a stored channel", async () => {
		render(<ServerNeedsYouSettings />);
		fireEvent.click(await screen.findByRole("button", { name: "Send a test" }));
		expect(await screen.findByText("Test sent")).toBeInTheDocument();
		expect(bridge.testNeedsYouChannel).toHaveBeenCalledWith("telegram");
		fireEvent.click(screen.getByRole("button", { name: "Remove Telegram from the server" }));
		await waitFor(() => expect(bridge.deleteNeedsYouChannel).toHaveBeenCalledWith("telegram"));
	});

	it("saves a muted moment", async () => {
		render(<ServerNeedsYouSettings />);
		fireEvent.click(await screen.findByRole("switch", { name: "A run stopped on an error" }));
		await waitFor(() =>
			expect(bridge.saveNeedsYouPreferences).toHaveBeenCalledWith({
				events: { plan_review: true, review_ready: true, failed: false },
				locale: "en",
			}),
		);
	});

	it("explains a server that has it off or has no master key", async () => {
		bridge.getNeedsYou.mockResolvedValue(overview({ available: false, vault: false }));
		render(<ServerNeedsYouSettings />);
		expect(await screen.findByText(/has not turned these notifications on/)).toBeInTheDocument();
		expect(screen.getByText(/no master key for secrets/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send a test" })).toBeDisabled();
		for (const button of screen.getAllByRole("button", { name: "Save" })) {
			expect(button).toBeDisabled();
		}
	});
});
