import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "./ui/tooltip";

// Mock du contexte CLI : on contrôle le statut/version renvoyés au badge.
const mockUseCliStatus = vi.fn();
const refreshCatalog = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useProviderModelCatalog", () => ({
	refreshProviderModelCatalog: refreshCatalog,
}));
vi.mock("@/contexts/CliStatusContext", () => ({
	useCliStatus: () => mockUseCliStatus(),
}));

import i18n from "../../shared/i18n";
import { CodexCliStatusBadge } from "./CodexCliStatusBadge";

function setStatus(status: string, installed?: string) {
	mockUseCliStatus.mockReturnValue({
		data: {
			codex: {
				status,
				versionInfo: installed ? { installed } : null,
				lastChecked: null,
			},
		},
		refreshCodex: vi.fn(),
	});
}

// Le badge utilise Radix Tooltip, qui exige un TooltipProvider ancêtre
// (fourni par la Sidebar en production).
function renderBadge(ui: ReactElement) {
	return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("CodexCliStatusBadge", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
		mockUseCliStatus.mockReset();
		refreshCatalog.mockReset();
	});
	afterEach(() => vi.unstubAllGlobals());

	it.each([true, false])(
		"refreshes models only after a successful CLI update (%s)",
		async (success) => {
			setStatus("outdated", "1.0.0");
			const update = vi
				.fn()
				.mockResolvedValue({ success, error: "update failed" });
			vi.stubGlobal("electronAPI", { updateCodexCli: update });
			renderBadge(<CodexCliStatusBadge />);
			fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
			fireEvent.click(screen.getByRole("button", { name: "Update" }));
			await waitFor(() => expect(update).toHaveBeenCalledOnce());
			if (success) {
				await waitFor(() =>
					expect(refreshCatalog).toHaveBeenCalledWith("openai-codex"),
				);
			} else {
				await screen.findByText("update failed");
				expect(refreshCatalog).not.toHaveBeenCalled();
			}
		},
	);

	describe("mode replié (isCollapsed)", () => {
		it("masque le libellé et le badge Update quand le statut est outdated", () => {
			setStatus("outdated", "1.0.0");
			renderBadge(<CodexCliStatusBadge isCollapsed />);

			// Le texte "Codex" et le badge "Update" ne doivent pas déborder.
			expect(screen.queryByText(/Codex/)).not.toBeInTheDocument();
			expect(screen.queryByText("Update")).not.toBeInTheDocument();
		});

		it("masque le badge Install quand le statut est not-found", () => {
			setStatus("not-found");
			renderBadge(<CodexCliStatusBadge isCollapsed />);

			expect(screen.queryByText("Install")).not.toBeInTheDocument();
		});
	});

	describe("mode déplié (par défaut)", () => {
		it("affiche le libellé avec la version et le badge Update quand outdated", () => {
			setStatus("outdated", "1.0.0");
			renderBadge(<CodexCliStatusBadge />);

			expect(screen.getByText(/Codex \(1\.0\.0\)/)).toBeInTheDocument();
			expect(screen.getByText("Update")).toBeInTheDocument();
		});

		it("affiche le badge Install quand not-found", () => {
			setStatus("not-found");
			renderBadge(<CodexCliStatusBadge />);

			expect(screen.getByText("Install")).toBeInTheDocument();
		});
	});
});

describe("CodexCliStatusBadge status and actions", () => {
	const refreshCodex = vi.fn();
	const updateCodexCli = vi.fn();
	const openExternal = vi.fn();

	function useStatus(
		status: string,
		versionInfo: { installed?: string; latest?: string } | null = null,
		lastChecked: Date | null = null,
	) {
		mockUseCliStatus.mockReturnValue({
			data: { codex: { status, versionInfo, lastChecked } },
			refreshCodex,
		});
	}

	beforeEach(async () => {
		await i18n.changeLanguage("en");
		vi.clearAllMocks();
		refreshCodex.mockResolvedValue(undefined);
		openExternal.mockResolvedValue(undefined);
		vi.stubGlobal("electronAPI", { updateCodexCli, openExternal });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it.each([
		["loading", null, "Checking Codex CLI...", "Checking..."],
		["installed", { installed: "0.9.1" }, "Codex CLI (0.9.1)", "Installed"],
		["installed", null, "Codex CLI installed", "Installed"],
		["outdated", null, "Codex CLI () - update available", "Update available"],
		["not-found", null, "Codex CLI not found", "Not installed"],
		["error", null, "Codex CLI error", "Error"],
	])("says what it knows when %s (%j)", async (status, versionInfo, tooltip, label) => {
		useStatus(status, versionInfo);
		renderBadge(<CodexCliStatusBadge />);
		const badge = screen.getByRole("button", { name: /Codex/ });
		fireEvent.focus(badge);
		expect((await screen.findAllByText(tooltip))[0]).toBeInTheDocument();
		fireEvent.click(badge);
		expect(await screen.findByText(label)).toBeInTheDocument();
	});

	it("reports where the panel should place it", () => {
		const onPresenceChange = vi.fn();
		useStatus("loading");
		const { rerender } = renderBadge(<CodexCliStatusBadge onPresenceChange={onPresenceChange} />);
		expect(onPresenceChange).not.toHaveBeenCalled();
		useStatus("error");
		rerender(
			<TooltipProvider>
				<CodexCliStatusBadge onPresenceChange={onPresenceChange} />
			</TooltipProvider>,
		);
		expect(onPresenceChange).toHaveBeenLastCalledWith("missing");
		useStatus("outdated", { installed: "0.9.1" });
		rerender(
			<TooltipProvider>
				<CodexCliStatusBadge onPresenceChange={onPresenceChange} />
			</TooltipProvider>,
		);
		expect(onPresenceChange).toHaveBeenLastCalledWith("installed");
	});

	it("shows the installed and latest versions and when they were checked", async () => {
		useStatus("outdated", { installed: "0.9.1", latest: "0.10.0" }, new Date(2026, 10, 2, 16, 30));
		renderBadge(<CodexCliStatusBadge />);
		fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
		expect((await screen.findByText("Current:")).nextElementSibling).toHaveTextContent("0.9.1");
		expect(screen.getByText("Latest:").nextElementSibling).toHaveTextContent("0.10.0");
		expect(screen.getByText("Last checked:").nextElementSibling).toHaveTextContent("4:30:00 PM");
	});

	it("shows only the versions it has", async () => {
		useStatus("installed", { latest: "0.10.0" });
		const { unmount } = renderBadge(<CodexCliStatusBadge />);
		fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
		expect(await screen.findByText("Latest:")).toBeInTheDocument();
		expect(screen.queryByText("Current:")).not.toBeInTheDocument();
		expect(screen.queryByText("Last checked:")).not.toBeInTheDocument();
		unmount();

		useStatus("installed");
		renderBadge(<CodexCliStatusBadge />);
		fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
		await screen.findByText("Installed");
		expect(screen.queryByText("Latest:")).not.toBeInTheDocument();
	});

	it("explains how a missing CLI is installed, and offers to install it", async () => {
		useStatus("not-found");
		renderBadge(<CodexCliStatusBadge />);
		fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
		expect(await screen.findByText("install -g @openai/codex@latest")).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: "Install" })).toHaveLength(1);
	});

	it("offers nothing to run while it is checking", async () => {
		useStatus("loading");
		renderBadge(<CodexCliStatusBadge />);
		fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
		expect(await screen.findByRole("button", { name: "Refresh" })).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
	});

	it("checks again and reloads the model list on refresh", async () => {
		useStatus("error");
		renderBadge(<CodexCliStatusBadge />);
		fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
		fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
		expect(refreshCodex).toHaveBeenCalledOnce();
		expect(refreshCatalog).toHaveBeenCalledWith("openai-codex");
	});

	it("opens the Codex CLI documentation", async () => {
		useStatus("installed");
		renderBadge(<CodexCliStatusBadge />);
		fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
		fireEvent.click(await screen.findByRole("button", { name: "View Codex CLI documentation" }));
		expect(openExternal).toHaveBeenCalledWith("https://github.com/openai/codex");
	});

	it("says it is installing, then checks a second time a little later", async () => {
		let answer: (value: unknown) => void = () => undefined;
		updateCodexCli.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		useStatus("installed", { installed: "0.9.1" });
		renderBadge(<CodexCliStatusBadge />);
		fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
		fireEvent.click(await screen.findByRole("button", { name: "Update" }));
		expect(await screen.findByText("Installing, please wait...")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await act(async () => {
			answer({ success: true });
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(refreshCodex).toHaveBeenCalledOnce();
		expect(screen.queryByText("Installing, please wait...")).not.toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		expect(refreshCodex).toHaveBeenCalledTimes(2);
	});

	it("does not check again once the badge is gone", async () => {
		updateCodexCli.mockResolvedValue({ success: true });
		useStatus("installed", { installed: "0.9.1" });
		const { unmount } = renderBadge(<CodexCliStatusBadge />);
		fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
		const update = await screen.findByRole("button", { name: "Update" });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await act(async () => {
			fireEvent.click(update);
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(refreshCodex).toHaveBeenCalledOnce();
		unmount();
		await vi.advanceTimersByTimeAsync(2000);
		expect(refreshCodex).toHaveBeenCalledOnce();
	});

	it.each([
		["the update gives no reason", () => updateCodexCli.mockResolvedValue({ success: false }), "Updating Codex CLI failed."],
		["the update throws", () => updateCodexCli.mockRejectedValue(new Error("EACCES")), "EACCES"],
		["the update throws a non-error", () => updateCodexCli.mockRejectedValue("killed"), "Updating Codex CLI failed."],
	])("shows why it failed when %s", async (_case, arrange, text) => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		arrange();
		useStatus("error");
		renderBadge(<CodexCliStatusBadge />);
		fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
		fireEvent.click(await screen.findByRole("button", { name: "Update" }));
		expect(await screen.findByText(text)).toBeInTheDocument();
		expect(refreshCodex).not.toHaveBeenCalled();
	});
});
