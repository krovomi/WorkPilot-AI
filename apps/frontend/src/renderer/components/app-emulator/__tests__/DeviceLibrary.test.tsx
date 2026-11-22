/**
 * @vitest-environment jsdom
 */
/**
 * The device matrix's custom devices, sessions and breakpoint scan (#383):
 * a device is described once and checked before it reaches the main; the
 * session is blank, the preview's or a persona saved by the main, of which
 * only the name and the count are shown; the breakpoint scan says, width by
 * width, what the page does around its own breakpoints.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_PRESETS } from "../../../../shared/constants/device-presets";
import type { DevicePreset } from "../../../../shared/types/device-matrix";
import { useDeviceLibraryStore } from "../../../stores/device-library-store";
import { useDeviceMatrixStore } from "../../../stores/device-matrix-store";
import { BreakpointScanPanel, DEFAULT_SCAN_DEVICE_ID } from "../BreakpointScanPanel";
import { CustomDevices } from "../CustomDevices";
import { SessionChoice } from "../SessionChoice";

const api = {
	saveEmulatorCustomDevice: vi.fn(),
	deleteEmulatorCustomDevice: vi.fn(),
	saveEmulatorPersona: vi.fn(),
	deleteEmulatorPersona: vi.fn(),
	scanEmulatorBreakpoints: vi.fn(),
};
Object.defineProperty(window, "electronAPI", { value: api, writable: true });

const kiosk = {
	id: "custom-11111111-2222-4333-8444-555555555555",
	name: "Kiosk",
	category: "desktop" as const,
	width: 1366,
	height: 768,
	deviceScaleFactor: 1,
	mobile: false,
	touch: true,
	userAgent: "UA",
};
const admin = {
	id: "persona-11111111-2222-4333-8444-555555555555",
	name: "Admin",
	host: "http://localhost",
	cookieCount: 2,
	savedAt: Date.UTC(2026, 10, 2, 12),
};
const dimensions = (device: Pick<DevicePreset, "width" | "height">) => `${device.width}x${device.height}`;

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	useDeviceLibraryStore.setState({ customDevices: [], personas: [], loaded: true, saving: false, problem: null });
	useDeviceMatrixStore.setState({ previewSession: false, persona: null, scan: null, running: false, exporting: false });
});

describe("CustomDevices", () => {
	it("lists the custom devices to check, and removes one through the main", async () => {
		useDeviceLibraryStore.setState({ customDevices: [kiosk] });
		const onToggle = vi.fn();
		api.deleteEmulatorCustomDevice.mockResolvedValueOnce({ success: true, data: [] });
		render(<CustomDevices selected={[kiosk.id]} disabled={false} onToggle={onToggle} dimensions={dimensions} />);
		expect(screen.getByText("1366x768")).toBeInTheDocument();
		const box = screen.getByRole("checkbox", { name: /Kiosk/ });
		expect(box).toBeChecked();
		fireEvent.click(box);
		expect(onToggle).toHaveBeenCalledWith(kiosk.id);
		fireEvent.click(screen.getByRole("button", { name: "Remove Kiosk" }));
		await waitFor(() => expect(screen.queryByText("Kiosk")).not.toBeInTheDocument());
		expect(api.deleteEmulatorCustomDevice).toHaveBeenCalledWith(kiosk.id);
	});

	it("sends a described device to the main, and starts again with an empty name", async () => {
		api.saveEmulatorCustomDevice.mockResolvedValueOnce({ success: true, data: [kiosk] });
		render(<CustomDevices selected={[]} disabled={false} onToggle={vi.fn()} dimensions={dimensions} />);
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Kiosk" } });
		fireEvent.change(screen.getByLabelText("Width (CSS px)"), { target: { value: "1366" } });
		fireEvent.change(screen.getByLabelText("Height (CSS px)"), { target: { value: "768" } });
		fireEvent.change(screen.getByLabelText("Pixel ratio"), { target: { value: "1" } });
		fireEvent.click(screen.getByLabelText(/Mobile browser/));
		fireEvent.click(screen.getByLabelText("Touch screen"));
		fireEvent.click(screen.getByLabelText("Touch screen"));
		const desktop = DEVICE_PRESETS.find((device) => device.id === "desktop-1080p") as DevicePreset;
		fireEvent.change(screen.getByLabelText("Start from the browser of"), { target: { value: "desktop-1080p" } });
		expect(screen.getByLabelText("User agent")).toHaveValue(desktop.userAgent);
		fireEvent.change(screen.getByLabelText("Start from the browser of"), { target: { value: "not-a-device" } });
		fireEvent.change(screen.getByLabelText("User agent"), { target: { value: "Kiosk UA" } });
		fireEvent.click(screen.getByRole("button", { name: "Add this device" }));
		await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue(""));
		expect(api.saveEmulatorCustomDevice).toHaveBeenCalledWith({
			name: "Kiosk",
			width: 1366,
			height: 768,
			deviceScaleFactor: 1,
			mobile: false,
			touch: true,
			userAgent: "Kiosk UA",
		});
	});

	it("says what is out of bounds before asking, and what the main refused", async () => {
		api.saveEmulatorCustomDevice.mockResolvedValueOnce({ success: false, error: "too-many" });
		render(<CustomDevices selected={[]} disabled={false} onToggle={vi.fn()} dimensions={dimensions} />);
		fireEvent.click(screen.getByRole("button", { name: "Add this device" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/Check the fields/);
		expect(api.saveEmulatorCustomDevice).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Phone" } });
		fireEvent.click(screen.getByRole("button", { name: "Add this device" }));
		expect(await screen.findByText("20 devices at most: remove one first.")).toHaveAttribute("role", "alert");
		expect(screen.getByLabelText("Name")).toHaveValue("Phone");
	});
});

describe("SessionChoice", () => {
	it("chooses a blank session, the preview's, or a persona, one at a time", () => {
		useDeviceLibraryStore.setState({ personas: [admin] });
		render(<SessionChoice disabled={false} />);
		const select = screen.getByLabelText("Session");
		expect(select).toHaveValue("blank");
		fireEvent.change(select, { target: { value: "preview" } });
		expect(useDeviceMatrixStore.getState()).toMatchObject({ previewSession: true, persona: null });
		expect(screen.getByText(/The cookies the preview sends to this server are lent/)).toBeInTheDocument();
		fireEvent.change(select, { target: { value: admin.id } });
		expect(useDeviceMatrixStore.getState()).toMatchObject({ previewSession: false, persona: admin.id });
		expect(screen.getByText(/2 cookies saved for http:\/\/localhost on 11\/2\/2026/)).toBeInTheDocument();
		fireEvent.change(select, { target: { value: "blank" } });
		expect(useDeviceMatrixStore.getState()).toMatchObject({ previewSession: false, persona: null });
	});

	it("saves the preview's session under a name, then uses it", async () => {
		api.saveEmulatorPersona.mockResolvedValueOnce({ success: true, data: [admin] });
		render(<SessionChoice disabled={false} />);
		const save = screen.getByRole("button", { name: "Save the persona" });
		expect(save).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Persona name"), { target: { value: "Admin" } });
		fireEvent.click(save);
		await waitFor(() => expect(useDeviceMatrixStore.getState().persona).toBe(admin.id));
		expect(api.saveEmulatorPersona).toHaveBeenCalledWith("Admin");
		expect(screen.getByLabelText("Persona name")).toHaveValue("");
		expect(screen.getByLabelText("Session")).toHaveValue(admin.id);
	});

	it("says why a persona was not saved, and keeps the name typed", async () => {
		api.saveEmulatorPersona.mockResolvedValueOnce({ success: false, error: "no-cookies" });
		render(<SessionChoice disabled={false} />);
		fireEvent.change(screen.getByLabelText("Persona name"), { target: { value: "Admin" } });
		fireEvent.click(screen.getByRole("button", { name: "Save the persona" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/sends no cookie to this server/);
		expect(screen.getByLabelText("Persona name")).toHaveValue("Admin");
	});

	it("deletes the persona chosen, and falls back to a blank session", async () => {
		useDeviceLibraryStore.setState({ personas: [admin] });
		useDeviceMatrixStore.setState({ persona: admin.id });
		api.deleteEmulatorPersona.mockResolvedValueOnce({ success: false, error: "write-failed" });
		render(<SessionChoice disabled={false} />);
		fireEvent.click(screen.getByRole("button", { name: "Delete this persona" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The personas could not be saved.");
		expect(useDeviceMatrixStore.getState().persona).toBe(admin.id);
		api.deleteEmulatorPersona.mockResolvedValueOnce({ success: true, data: [] });
		fireEvent.click(screen.getByRole("button", { name: "Delete this persona" }));
		await waitFor(() => expect(useDeviceMatrixStore.getState().persona).toBeNull());
		expect(screen.getByLabelText("Session")).toHaveValue("blank");
	});
});

describe("BreakpointScanPanel", () => {
	const devices = [...DEVICE_PRESETS, kiosk];
	const name = (device: DevicePreset) => device.name ?? device.id;

	it("reads the page on a desktop by default, or the device picked", async () => {
		api.scanEmulatorBreakpoints.mockResolvedValue({ success: false, error: "not-running" });
		render(<BreakpointScanPanel path="/pricing" devices={devices} disabled={false} deviceName={name} />);
		expect(screen.getByLabelText("Device")).toHaveValue(DEFAULT_SCAN_DEVICE_ID);
		fireEvent.change(screen.getByLabelText("Device"), { target: { value: kiosk.id } });
		fireEvent.click(screen.getByRole("button", { name: "Read the breakpoints" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The emulator's server is not running");
		expect(api.scanEmulatorBreakpoints).toHaveBeenCalledWith({
			deviceId: kiosk.id,
			path: "/pricing",
			previewSession: false,
			persona: null,
		});
	});

	it("shows each width, what overflowed and which bugs the reading found", () => {
		useDeviceMatrixStore.setState({
			scan: {
				status: "done",
				scan: {
					deviceId: "desktop-1080p",
					url: "http://localhost:5173/",
					breakpoints: [768],
					steps: [
						{ width: 767, scrollWidth: 900, truncated: true, issues: [{ kind: "horizontal-overflow", count: 2 }] },
						{ width: 1280, scrollWidth: 1280, truncated: false, issues: [] },
					],
				},
			},
		});
		render(<BreakpointScanPanel path="/" devices={devices} disabled={false} deviceName={name} />);
		expect(screen.getByText("Breakpoints declared: 768 px")).toBeInTheDocument();
		const narrow = within(document.querySelector('tr[data-width="767"]') as HTMLElement);
		expect(narrow.getByText("767 px")).toHaveClass("font-semibold");
		expect(narrow.getByText("Next to a breakpoint")).toBeInTheDocument();
		expect(narrow.getByText("133 px")).toBeInTheDocument();
		expect(narrow.getByText("2 elements go past the edge of the screen")).toBeInTheDocument();
		expect(narrow.getByText("Partial reading")).toBeInTheDocument();
		const wide = within(document.querySelector('tr[data-width="1280"]') as HTMLElement);
		expect(wide.getAllByText("None")).toHaveLength(2);
		expect(wide.queryByText("Next to a breakpoint")).not.toBeInTheDocument();
	});

	it("says when the page declares no breakpoint, and waits while reading", () => {
		useDeviceMatrixStore.setState({
			scan: { status: "done", scan: { deviceId: "desktop-1080p", url: "http://x/", breakpoints: [], steps: [] } },
		});
		const { rerender } = render(<BreakpointScanPanel path="/" devices={devices} disabled={false} deviceName={name} />);
		expect(screen.getByText("No width breakpoint in the style sheets the page can read.")).toBeInTheDocument();
		useDeviceMatrixStore.setState({ scan: { status: "running", deviceId: "desktop-1080p" } });
		rerender(<BreakpointScanPanel path="/" devices={devices} disabled={false} deviceName={name} />);
		expect(screen.getByRole("button", { name: "Reading the page at each width…" })).toBeDisabled();
		expect(screen.getByLabelText("Device")).toBeDisabled();
	});
});
