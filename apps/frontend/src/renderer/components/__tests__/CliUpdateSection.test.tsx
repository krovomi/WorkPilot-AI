/**
 * The update side of a CLI badge: the check once the CLI is known to be
 * installed, the versions, the one-click update and what it said. The host
 * below wires the hook to the section and the chip as the badges do.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { CliUpdateStatus } from "../../../shared/types/cli-update";
import { CliUpdateChip, CliUpdateSection, useCliUpdate } from "../CliUpdateSection";

function Host({
	enabled = true,
	onUpdated,
}: {
	readonly enabled?: boolean;
	readonly onUpdated?: () => void;
}) {
	const state = useCliUpdate("opencode", "OpenCode", enabled, onUpdated);
	return (
		<div>
			{state.info?.isOutdated && <CliUpdateChip isUpdating={state.isUpdating} />}
			<CliUpdateSection state={state} name="OpenCode" />
		</div>
	);
}

const OUTDATED: CliUpdateStatus = {
	tool: "opencode",
	installed: true,
	version: "1.0.0",
	latest: "1.2.0",
	isOutdated: true,
};

let checkCliUpdate: ReturnType<typeof vi.fn>;
let updateCli: ReturnType<typeof vi.fn>;

function setApi(api: Record<string, unknown>) {
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
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
	checkCliUpdate = vi.fn().mockResolvedValue(OUTDATED);
	updateCli = vi.fn();
	setApi({ checkCliUpdate, updateCli });
});

afterEach(() => {
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("useCliUpdate + CliUpdateSection — the check", () => {
	it("checks only once the CLI is known to be installed, and forgets it after", async () => {
		const { rerender, container } = render(<Host enabled={false} />);
		expect(checkCliUpdate).not.toHaveBeenCalled();
		expect(container.firstChild).toBeEmptyDOMElement();

		rerender(<Host enabled />);
		expect(await screen.findByText("1.0.0")).toBeInTheDocument();
		expect(checkCliUpdate).toHaveBeenCalledWith("opencode");

		rerender(<Host enabled={false} />);
		await waitFor(() => expect(screen.queryByText("1.0.0")).not.toBeInTheDocument());
	});

	it("shows nothing without the check in the API, or when the check throws", async () => {
		setApi({});
		const first = render(<Host />);
		expect(first.container.firstChild).toBeEmptyDOMElement();
		first.unmount();

		setApi({ checkCliUpdate: vi.fn().mockRejectedValue(new Error("ipc down")) });
		const second = render(<Host />);
		await waitFor(() => expect(second.container.firstChild).toBeEmptyDOMElement());
	});

	it("shows nothing for a CLI that is not installed", async () => {
		checkCliUpdate.mockResolvedValue({ tool: "opencode", installed: false, isOutdated: false });
		const { container } = render(<Host />);
		await waitFor(() => expect(checkCliUpdate).toHaveBeenCalled());
		expect(container.firstChild).toBeEmptyDOMElement();
	});

	it("offers nothing to do for an up-to-date CLI", async () => {
		checkCliUpdate.mockResolvedValue({ ...OUTDATED, version: "1.2.0", isOutdated: false });
		render(<Host />);
		expect(await screen.findAllByText("1.2.0")).toHaveLength(2);
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.queryByText("Update")).not.toBeInTheDocument();
	});

	it("leaves the decision to the CLI's own updater when the latest release is unknown", async () => {
		checkCliUpdate.mockResolvedValue({ tool: "opencode", installed: true, isOutdated: false });
		render(<Host />);
		expect(await screen.findByRole("button", { name: "Update if needed" })).toBeInTheDocument();
		expect(screen.getAllByText("unknown")).toHaveLength(2);
	});
});

describe("useCliUpdate + CliUpdateSection — the update", () => {
	it("updates an outdated CLI, shows it working, then the version it left", async () => {
		const pending = deferred<unknown>();
		updateCli.mockReturnValue(pending.promise);
		const onUpdated = vi.fn();
		render(<Host onUpdated={onUpdated} />);
		expect(await screen.findByText("1.2.0")).toHaveClass("text-warning");
		expect(screen.getByText("Update", { selector: "span" })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		expect(await screen.findByRole("button", { name: "Updating, please wait…" })).toBeDisabled();
		expect(screen.getByText("Updating…")).toBeInTheDocument();
		expect(updateCli).toHaveBeenCalledWith("opencode");

		pending.resolve({
			tool: "opencode",
			success: true,
			status: { ...OUTDATED, version: "1.2.0", isOutdated: false },
		});
		expect(await screen.findByText("OpenCode is up to date (1.2.0).")).toBeInTheDocument();
		expect(onUpdated).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("confirms an update that reported no version", async () => {
		checkCliUpdate.mockResolvedValue({ tool: "opencode", installed: true, isOutdated: false });
		updateCli.mockResolvedValue({ tool: "opencode", success: true });
		render(<Host />);
		fireEvent.click(await screen.findByRole("button", { name: "Update if needed" }));
		expect(await screen.findByText("OpenCode is up to date.")).toBeInTheDocument();
	});

	it("says why an update did not take, with the command's output", async () => {
		updateCli.mockResolvedValue({
			tool: "opencode",
			success: false,
			error: "still_outdated",
			detail: "npm WARN global",
			status: OUTDATED,
		});
		render(<Host />);
		fireEvent.click(await screen.findByRole("button", { name: "Update" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe(
			"The update ran but OpenCode still reports 1.0.0 (latest: 1.2.0). The copy the app runs is probably managed another way; update it the way you installed it:\nnpm WARN global",
		);
		expect(screen.queryByText(/is up to date/)).not.toBeInTheDocument();
		// It can be tried again
		expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
	});

	it("falls back to « failed » for a refusal without a reason", async () => {
		updateCli.mockResolvedValue({ tool: "opencode", success: false });
		render(<Host />);
		fireEvent.click(await screen.findByRole("button", { name: "Update" }));
		expect((await screen.findByRole("alert")).textContent).toBe("Updating OpenCode failed.");
	});

	it.each([
		[new Error("spawn ENOENT"), "Updating OpenCode failed.\nspawn ENOENT"],
		["killed", "Updating OpenCode failed.\nkilled"],
	])("says what was thrown (%s)", async (thrown, message) => {
		updateCli.mockRejectedValue(thrown);
		render(<Host />);
		fireEvent.click(await screen.findByRole("button", { name: "Update" }));
		expect((await screen.findByRole("alert")).textContent).toBe(message);
	});

	it("does nothing where the API has no update (browser preview)", async () => {
		setApi({ checkCliUpdate });
		const onUpdated = vi.fn();
		render(<Host onUpdated={onUpdated} />);
		fireEvent.click(await screen.findByRole("button", { name: "Update" }));
		expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
		expect(onUpdated).not.toHaveBeenCalled();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
