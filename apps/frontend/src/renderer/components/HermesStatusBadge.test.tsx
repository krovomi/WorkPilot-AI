/** @vitest-environment jsdom */
/**
 * Hermes in the « Outils CLI » panel: the doctor's answer and what to type,
 * never a button that installs or trusts on the person's behalf, and nothing
 * at all in server mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HermesStatus } from "../lib/agent-tools-api";
import { TooltipProvider } from "./ui/tooltip";

// Keys come back as-is so the assertions do not depend on translations.
vi.mock("react-i18next", () => ({
	useTranslation: vi.fn(() => ({ t: (key: string) => key })),
}));

const mockFetchStatus = vi.fn();
const mockInstallSoul = vi.fn();
vi.mock("../lib/agent-tools-api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/agent-tools-api")>()),
	fetchHermesStatus: (...args: unknown[]) => mockFetchStatus(...args),
	installHermesSoul: (...args: unknown[]) => mockInstallSoul(...args),
}));

import { useHermesStore } from "../stores/hermes-store";
import { HermesStatusBadge } from "./HermesStatusBadge";

const INSTALL = "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash";

function status(overrides: Partial<HermesStatus> = {}): HermesStatus {
	return {
		readiness: {
			state: "ready",
			installed: true,
			ready: true,
			degraded: false,
			home: "/home/me/.hermes",
			checks: [{ name: "install", ok: true, detail: "on PATH", remedy: "", required: true }],
		},
		soul: {
			state: "installed",
			offered: true,
			installed: true,
			matches: true,
			installedPath: "",
			repoPath: "",
		},
		pending: [],
		candidates: [],
		stale: 0,
		adopted: [],
		adoptedPack: "hermes-learned",
		surfaces: [],
		...overrides,
	} as HermesStatus;
}

function renderBadge() {
	return render(
		<TooltipProvider>
			<HermesStatusBadge />
		</TooltipProvider>,
	);
}

function openPopover() {
	fireEvent.click(screen.getByRole("button", { name: /Hermes/ }));
}

describe("HermesStatusBadge", () => {
	beforeEach(() => {
		mockFetchStatus.mockReset();
		mockInstallSoul.mockReset();
		useHermesStore.getState().reset();
	});
	afterEach(cleanup);

	it("renders nothing in server mode", async () => {
		mockFetchStatus.mockResolvedValue({
			ok: false,
			error: "the hermes learning loop is a desktop feature",
		});
		const { container } = renderBadge();
		await waitFor(() => expect(useHermesStore.getState().unavailable).toBe(true));
		expect(container).toBeEmptyDOMElement();
	});

	it("shows a missing hermes with the command that installs it", async () => {
		mockFetchStatus.mockResolvedValue({
			ok: true,
			data: {
				status: status({
					readiness: {
						state: "absent",
						installed: false,
						ready: false,
						degraded: false,
						home: "/home/me/.hermes",
						checks: [
							{
								name: "install",
								ok: false,
								detail: "no hermes binary and no hermes home",
								remedy: INSTALL,
								required: true,
							},
						],
					},
				}),
			},
		});
		renderBadge();
		await waitFor(() => expect(mockFetchStatus).toHaveBeenCalled());
		openPopover();
		expect(await screen.findByText("hermes:state.absent")).toBeInTheDocument();
		expect(screen.getByText(INSTALL)).toBeInTheDocument();
		// Nothing installs on the person's behalf.
		expect(screen.queryByRole("button", { name: /install/i })).not.toBeInTheDocument();
	});

	it("counts what waits for review and offers the persona", async () => {
		mockFetchStatus.mockResolvedValue({
			ok: true,
			data: {
				status: status({
					pending: ["hermes--a.md", "hermes--b.md"],
					soul: {
						state: "not-installed",
						offered: true,
						installed: false,
						matches: false,
						installedPath: "",
						repoPath: "",
					},
				}),
			},
		});
		mockInstallSoul.mockResolvedValue({
			ok: true,
			data: { changed: true, message: "", soul: status().soul },
		});
		renderBadge();
		expect(await screen.findByText("2")).toBeInTheDocument();
		openPopover();
		expect(await screen.findByText("hermes:sidebar.pending")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /hermes:soul.install/ }));
		await waitFor(() => expect(mockInstallSoul).toHaveBeenCalledWith(false));
	});

	describe("update", () => {
		const checkCliUpdate = vi.fn();
		const updateCli = vi.fn();
		const outdated = {
			tool: "hermes",
			installed: true,
			version: "0.21.1",
			latest: "0.23.0",
			isOutdated: true,
		};

		beforeEach(() => {
			checkCliUpdate.mockReset();
			updateCli.mockReset();
			(globalThis as { electronAPI?: unknown }).electronAPI = { checkCliUpdate, updateCli };
		});
		afterEach(() => {
			(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
		});

		it("flags an outdated hermes, updates it and reads the doctor again", async () => {
			mockFetchStatus.mockResolvedValue({ ok: true, data: { status: status() } });
			checkCliUpdate.mockResolvedValue(outdated);
			updateCli.mockResolvedValue({
				tool: "hermes",
				success: true,
				method: "self",
				status: { ...outdated, version: "0.23.0", isOutdated: false },
			});
			renderBadge();
			expect(await screen.findByText("common:update")).toBeInTheDocument();
			expect(screen.getByText(/0\.21\.1/)).toBeInTheDocument();
			openPopover();
			expect(
				await screen.findByText("navigation:agentCli.update.availableFor"),
			).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "common:update" }));
			await waitFor(() => expect(updateCli).toHaveBeenCalledWith("hermes"));
			// The doctor caches the version per binary: it is asked to read it again.
			await waitFor(() =>
				expect(mockFetchStatus).toHaveBeenLastCalledWith(expect.anything(), true),
			);
			expect(
				await screen.findByText("navigation:agentCli.update.doneWithVersion"),
			).toBeInTheDocument();
		});

		it("checks no release for a hermes that is not installed", async () => {
			mockFetchStatus.mockResolvedValue({
				ok: true,
				data: {
					status: status({
						readiness: {
							state: "absent",
							installed: false,
							ready: false,
							degraded: false,
							home: "",
							checks: [],
						},
					}),
				},
			});
			renderBadge();
			await waitFor(() => expect(mockFetchStatus).toHaveBeenCalled());
			expect(checkCliUpdate).not.toHaveBeenCalled();
		});
	});
});
