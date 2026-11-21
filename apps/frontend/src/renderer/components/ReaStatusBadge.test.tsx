/** @vitest-environment jsdom */
/**
 * REA in the « Outils CLI » panel: the pinned release or nothing. Another
 * installed version is offered the pinned one, never an `@latest` update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { REA_PIN, type ReaInstallResult, type ReaStatus } from "../../shared/types/rea";
import { ReaStatusBadge } from "./ReaStatusBadge";
import { TooltipProvider } from "./ui/tooltip";

const checkRea = vi.fn();
const installRea = vi.fn();
const pinned = REA_PIN.version;
const ranges = REA_PIN.node.join(" || ");

function renderBadge(onPresenceChange = vi.fn(), isCollapsed = false) {
	render(
		<TooltipProvider>
			<ReaStatusBadge onPresenceChange={onPresenceChange} isCollapsed={isCollapsed} />
		</TooltipProvider>,
	);
	return onPresenceChange;
}

const trigger = () => screen.findByRole("button", { name: /^REA/ });

async function openPopover() {
	fireEvent.click(await trigger());
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	checkRea.mockReset();
	installRea.mockReset();
	(globalThis as { electronAPI?: unknown }).electronAPI = { checkRea, installRea };
});
afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("ReaStatusBadge", () => {
	it("shows the pinned release when it is installed, with nothing to install", async () => {
		checkRea.mockResolvedValue({ state: "ready", pinned, installedVersion: pinned });
		const presence = renderBadge();
		expect(await screen.findByText(`REA (${pinned})`)).toBeInTheDocument();
		expect(screen.queryByText("Install")).not.toBeInTheDocument();
		await waitFor(() => expect(presence).toHaveBeenLastCalledWith("installed"));
		await openPopover();
		expect(await screen.findByText(`Release ${pinned} installed`)).toBeInTheDocument();
		expect(
			screen.getByText("REA runs without your credentials, from a folder of its own, and only reads files."),
		).toBeInTheDocument();
	});

	it("installs the pinned release when rea is absent", async () => {
		checkRea.mockResolvedValue({ state: "absent", pinned });
		const pending = deferred<ReaInstallResult>();
		installRea.mockReturnValue(pending.promise);
		const presence = renderBadge();
		await screen.findByText("Install");
		await waitFor(() => expect(presence).toHaveBeenLastCalledWith("missing"));
		await openPopover();
		expect(screen.getByText(/WorkPilot fetches release 6\.9\.0 with npx/)).toBeInTheDocument();
		expect(screen.getByText(`npm install -g --ignore-scripts rea-agents@${pinned}`)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: `Install REA ${pinned}` }));
		await waitFor(() => expect(installRea).toHaveBeenCalledWith());
		// Working: the button and the chip say so, and nothing else can start
		expect(await screen.findByRole("button", { name: "Installing, please wait…" })).toBeDisabled();
		expect(screen.getByText("Installing…")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
		pending.resolve({ success: true, status: { state: "ready", pinned } });
		expect(await screen.findByText(`REA (${pinned})`)).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("offers the pinned release in place of another version", async () => {
		checkRea.mockResolvedValue({ state: "other_version", pinned, installedVersion: "7.0.0" });
		const presence = renderBadge();
		await screen.findByText("Install");
		await waitFor(() => expect(presence).toHaveBeenLastCalledWith("installed"));
		await openPopover();
		expect(
			screen.getByText(`rea on your PATH is 7.0.0; WorkPilot only runs ${pinned}. Installing replaces it with ${pinned}.`),
		).toBeInTheDocument();
		expect(screen.getAllByText("Another version is installed").length).toBeGreaterThan(0);
	});

	it("says another rea is on PATH even when its version cannot be read", async () => {
		checkRea.mockResolvedValue({ state: "other_version", pinned });
		renderBadge();
		await openPopover();
		expect(
			await screen.findByText(/rea on your PATH is not the rea-agents release WorkPilot runs/),
		).toBeInTheDocument();
	});

	it("offers no install without a Node.js the release accepts", async () => {
		checkRea.mockResolvedValue({ state: "node_too_old", pinned, nodeVersion: "20.0.0" });
		const presence = renderBadge();
		await openPopover();
		expect(
			await screen.findByText(/the one on PATH is 20\.0\.0/),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: `Install REA ${pinned}` })).toBeNull();
		await waitFor(() => expect(presence).toHaveBeenLastCalledWith("missing"));
	});

	it("says a Node.js is too old even when its version is unknown", async () => {
		checkRea.mockResolvedValue({ state: "node_too_old", pinned });
		renderBadge();
		await openPopover();
		expect(await screen.findByText(/the one on PATH is ,/)).toBeInTheDocument();
	});

	it("asks for a Node.js when there is none", async () => {
		checkRea.mockResolvedValue({ state: "node_missing", pinned });
		renderBadge();
		await openPopover();
		expect(
			await screen.findByText(`REA needs Node.js ${ranges}. Install Node.js (nodejs.org), then refresh.`),
		).toBeInTheDocument();
	});

	it("names the version manager whose Node.js REA runs with", async () => {
		checkRea.mockResolvedValue({
			state: "ready",
			pinned,
			installedVersion: pinned,
			nodeVersion: "27.0.0",
			nodeManager: "nvm",
		});
		renderBadge();
		await openPopover();
		expect(
			await screen.findByText("Node.js 27.0.0 from nvm: the one on PATH is too old or missing."),
		).toBeInTheDocument();
	});

	it("opens the documentation, and says so when the link does not open", async () => {
		const openExternal = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("Unable to open"))
			.mockRejectedValueOnce("no browser");
		(globalThis as { electronAPI?: unknown }).electronAPI = { checkRea, installRea, openExternal };
		checkRea.mockResolvedValue({ state: "absent", pinned });
		renderBadge();
		await openPopover();
		const link = screen.getByRole("button", { name: /View REA documentation/ });
		fireEvent.click(link);
		await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://github.com/morluto/rea"));
		expect(screen.queryByRole("alert")).toBeNull();
		fireEvent.click(link);
		expect(await screen.findByRole("alert")).toHaveTextContent("The link did not open: Unable to open");
		fireEvent.click(link);
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("The link did not open: no browser"),
		);
	});

	it("shows why an install failed, with npm's output", async () => {
		checkRea.mockResolvedValue({ state: "absent", pinned });
		installRea.mockResolvedValue({ success: false, error: "failed", detail: "network down" });
		renderBadge();
		await screen.findByText("Install");
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: `Install REA ${pinned}` }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe(`Installing REA ${pinned} failed.\nnetwork down`);
		// Without a status in the answer, the check is run again
		await waitFor(() => expect(checkRea).toHaveBeenCalledTimes(2));
	});

	it("keeps the status the install reports, and its reason, without checking again", async () => {
		checkRea.mockResolvedValue({ state: "absent", pinned });
		installRea.mockResolvedValue({
			success: false,
			error: "not_on_path",
			status: { state: "other_version", pinned, installedVersion: "7.0.0" },
		});
		renderBadge();
		await openPopover();
		fireEvent.click(await screen.findByRole("button", { name: `Install REA ${pinned}` }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			`REA was installed but rea on your PATH still does not lead to ${pinned}. Restart WorkPilot, then refresh.`,
		);
		expect(screen.getByText(/rea on your PATH is 7\.0\.0/)).toBeInTheDocument();
		expect(checkRea).toHaveBeenCalledOnce();
	});

	it.each([
		[new Error("ipc down"), `Installing REA ${pinned} failed.\nipc down`],
		["killed", `Installing REA ${pinned} failed.\nkilled`],
	])("says what the install threw (%s)", async (thrown, message) => {
		checkRea.mockResolvedValue({ state: "absent", pinned });
		installRea.mockRejectedValue(thrown);
		renderBadge();
		await openPopover();
		fireEvent.click(await screen.findByRole("button", { name: `Install REA ${pinned}` }));
		expect((await screen.findByRole("alert")).textContent).toBe(message);
	});

	it("names a refusal without a reason as a failure", async () => {
		checkRea.mockResolvedValue({ state: "absent", pinned });
		installRea.mockResolvedValue({ success: false, status: { state: "absent", pinned } });
		renderBadge();
		await openPopover();
		fireEvent.click(await screen.findByRole("button", { name: `Install REA ${pinned}` }));
		expect((await screen.findByRole("alert")).textContent).toBe(`Installing REA ${pinned} failed.`);
	});

	it("reads as absent when the check throws, and says why", async () => {
		checkRea.mockRejectedValueOnce(new Error("ipc down")).mockRejectedValueOnce("odd");
		const presence = renderBadge();
		await waitFor(() => expect(presence).toHaveBeenLastCalledWith("missing"));
		await openPopover();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The check did not complete: ipc down",
		);
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("The check did not complete: odd"),
		);
	});

	it("shows the reason the main process gives for a check that failed", async () => {
		checkRea.mockResolvedValue({ state: "absent", pinned, error: "npm ls timed out" } satisfies ReaStatus);
		renderBadge();
		await openPopover();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The check did not complete: npm ls timed out",
		);
	});

	it("checks again on refresh, spinning meanwhile", async () => {
		checkRea.mockResolvedValueOnce({ state: "absent", pinned });
		const pending = deferred<ReaStatus>();
		checkRea.mockReturnValueOnce(pending.promise);
		renderBadge();
		await openPopover();
		const refresh = await screen.findByRole("button", { name: "Refresh" });
		fireEvent.click(refresh);
		await waitFor(() => expect(refresh).toBeDisabled());
		expect(screen.getAllByText("Checking...").length).toBeGreaterThan(0);
		pending.resolve({ state: "ready", pinned });
		expect(await screen.findByText(`REA (${pinned})`)).toBeInTheDocument();
	});

	it("offers no install where the API has none, and reads absent without a check", async () => {
		(globalThis as { electronAPI?: unknown }).electronAPI = {};
		const presence = renderBadge();
		await waitFor(() => expect(presence).toHaveBeenLastCalledWith("missing"));
		expect(screen.queryByText("Install")).toBeNull();
		await openPopover();
		expect(screen.queryByRole("button", { name: `Install REA ${pinned}` })).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows the icon alone in a collapsed sidebar", async () => {
		checkRea.mockResolvedValue({ state: "absent", pinned });
		renderBadge(vi.fn(), true);
		await waitFor(() => expect(checkRea).toHaveBeenCalled());
		const button = screen.getByRole("button", { name: "REA" });
		expect(button).not.toHaveTextContent("REA");
		expect(screen.queryByText("Install")).toBeNull();
	});
});
