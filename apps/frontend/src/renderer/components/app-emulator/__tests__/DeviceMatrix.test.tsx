/**
 * @vitest-environment jsdom
 */
/**
 * The device matrix (#383): pick devices, capture them through the main,
 * see them side by side with what the reading found, and keep one for the
 * visual review. Throttling and orientation are picked from closed lists, the
 * preview's session is a yes or no; faulty elements are boxed on the capture;
 * the grid exports through the main as a PNG or a PDF. The preview keeps its
 * `<webview>` mounted behind it.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { DeviceCapture, ResponsiveReport } from "../../../../shared/types/device-matrix";
import { useDeviceMatrixStore } from "../../../stores/device-matrix-store";
import { DeviceMatrix, matrixPath } from "../DeviceMatrix";
import { ResponsivePreview } from "../ResponsivePreview";

const captureEmulatorDevice = vi.fn();
const exportEmulatorDeviceGrid = vi.fn();
Object.defineProperty(window, "electronAPI", {
	value: { captureEmulatorDevice, exportEmulatorDeviceGrid },
	writable: true,
});

const done = (deviceId: string, report: ResponsiveReport | null, conditions: Partial<DeviceCapture> = {}) => ({
	status: "done" as const,
	capture: {
		deviceId,
		url: `http://localhost:5173/cart#${deviceId}`,
		image: "data:image/png;base64,AA==",
		report,
		network: "none" as const,
		cpu: "1x" as const,
		loadMs: 1234,
		orientation: "portrait" as const,
		width: 393,
		height: 852,
		previewSession: false,
		...conditions,
	},
});

const report = (overrides: Partial<ResponsiveReport>): ResponsiveReport => ({
	viewportWidth: 393,
	scrollWidth: 393,
	scanned: 120,
	truncated: false,
	issues: [],
	...overrides,
});

function reset(entries = {}) {
	useDeviceMatrixStore.setState({
		selected: ["iphone-15"],
		entries,
		running: false,
		stopRequested: false,
		network: "none",
		cpu: "1x",
		orientation: "portrait",
		previewSession: false,
		showMarkers: true,
		autoCaptured: [],
		exporting: false,
		exportStatus: null,
	});
}

describe("matrixPath", () => {
	it("keeps the shown page when it is on the emulator's server", () => {
		expect(matrixPath("http://localhost:5173", "http://localhost:5173/cart?x=1#top")).toEqual({
			path: "/cart?x=1#top",
			sameServer: true,
		});
	});

	it("falls back to the root for another origin or an unreadable address", () => {
		expect(matrixPath("http://localhost:5173", "https://example.com/cart")).toEqual({ path: "/", sameServer: false });
		expect(matrixPath("http://localhost:5173", "about blank")).toEqual({ path: "/", sameServer: false });
	});
});

describe("DeviceMatrix", () => {
	beforeEach(() => {
		captureEmulatorDevice.mockReset();
		reset();
	});

	it("captures the checked devices on the shown path", async () => {
		captureEmulatorDevice.mockResolvedValue({ success: false, error: "not-running" });
		render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/cart" />);
		expect(screen.getByText(/renders \/cart/)).toBeInTheDocument();
		expect(screen.getByText("Check devices, then capture: each one appears here side by side.")).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText(/Pixel 8/));
		fireEvent.click(screen.getByRole("button", { name: "Capture 2 devices" }));
		await waitFor(() =>
			expect(screen.getAllByText("The emulator's server is not running: start it, then capture again.")).toHaveLength(2),
		);
		const plain = { network: "none", cpu: "1x", orientation: "portrait", previewSession: false };
		expect(captureEmulatorDevice).toHaveBeenCalledWith({ deviceId: "iphone-15", path: "/cart", ...plain });
		expect(captureEmulatorDevice).toHaveBeenCalledWith({ deviceId: "pixel-8", path: "/cart", ...plain });
	});

	it("captures under the network and CPU profiles picked from their lists", async () => {
		captureEmulatorDevice.mockResolvedValue({ success: false, error: "throttling-failed" });
		render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/" />);
		const network = screen.getByLabelText("Network");
		expect([...network.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
			"No throttling",
			"4G",
			"Fast 3G",
			"Slow 3G",
		]);
		fireEvent.change(network, { target: { value: "slow-3g" } });
		fireEvent.change(screen.getByLabelText("CPU"), { target: { value: "6x" } });
		fireEvent.click(screen.getByRole("button", { name: "Capture 1 device" }));
		await waitFor(() =>
			expect(screen.getByText("The network or CPU throttling could not be applied on this device.")).toBeInTheDocument(),
		);
		expect(captureEmulatorDevice).toHaveBeenCalledWith({
			deviceId: "iphone-15",
			path: "/",
			network: "slow-3g",
			cpu: "6x",
			orientation: "portrait",
			previewSession: false,
		});
	});

	it("captures in the orientation picked, with the preview's session when asked", async () => {
		captureEmulatorDevice.mockResolvedValue({ success: false, error: "session-failed" });
		render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/" />);
		const orientation = screen.getByLabelText("Orientation");
		expect([...orientation.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
			"Portrait",
			"Landscape",
		]);
		fireEvent.change(orientation, { target: { value: "landscape" } });
		fireEvent.click(screen.getByLabelText(/Use the preview's session/));
		fireEvent.click(screen.getByRole("button", { name: "Capture 1 device" }));
		await waitFor(() =>
			expect(screen.getByText("The preview's session could not be read: capture again without it.")).toBeInTheDocument(),
		);
		expect(captureEmulatorDevice).toHaveBeenCalledWith(
			expect.objectContaining({ orientation: "landscape", previewSession: true }),
		);
	});

	it("shows under which conditions each device rendered, in the app's language", async () => {
		reset({
			"iphone-15": done("iphone-15", report({}), { network: "slow-3g", cpu: "4x", loadMs: 4250 }),
			"pixel-8": done("pixel-8", report({})),
			// An unknown CPU id from an older main: shown as unthrottled.
			"ipad-mini": done("ipad-mini", report({}), { cpu: "9x" as never }),
		});
		const { unmount } = render(
			<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/" />,
		);
		const tiles = document.querySelectorAll("figure[data-device]");
		expect(within(tiles[0] as HTMLElement).getByText("Slow 3G · CPU 4× slower · Loaded in 4.3 s")).toBeInTheDocument();
		expect(within(tiles[0] as HTMLElement).getByText("393 × 852 @3x")).toBeInTheDocument();
		expect(within(tiles[1] as HTMLElement).getByText("Loaded in 1.2 s")).toBeInTheDocument();
		expect(within(tiles[2] as HTMLElement).getByText("Loaded in 1.2 s")).toBeInTheDocument();
		unmount();
		await i18n.changeLanguage("fr");
		try {
			render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/" />);
			expect(screen.getByText("3G lente · Processeur 4× plus lent · Chargée en 4,3 s")).toBeInTheDocument();
		} finally {
			await i18n.changeLanguage("en");
		}
	});

	it("says when a device was turned or rendered with the preview's session", () => {
		reset({
			"pixel-8": done("pixel-8", report({}), {
				orientation: "landscape",
				width: 915,
				height: 412,
				previewSession: true,
			}),
			"desktop-1080p": done("desktop-1080p", report({}), { orientation: "landscape", width: 1920, height: 1080 }),
		});
		render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/" />);
		const tiles = document.querySelectorAll("figure[data-device]");
		const pixel = within(tiles[0] as HTMLElement);
		expect(pixel.getByText("915 × 412 @2.625x")).toBeInTheDocument();
		expect(pixel.getByText("Landscape · Preview's session · Loaded in 1.2 s")).toBeInTheDocument();
		// A desktop is landscape by itself: nothing to say.
		expect(within(tiles[1] as HTMLElement).getByText("Loaded in 1.2 s")).toBeInTheDocument();
	});

	it("boxes the faulty elements on the capture, and stops when asked", () => {
		reset({
			"iphone-15": done(
				"iphone-15",
				report({
					issues: [
						{
							kind: "broken-navigation",
							count: 1,
							samples: [{ selector: "nav#main", x: 0, y: 426, width: 393, height: 85.2 }],
						},
					],
				}),
			),
		});
		render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/" />);
		expect(screen.getByText("1 navigation cannot be reached on mobile")).toBeInTheDocument();
		const marker = document.querySelector("[data-marker]") as HTMLElement;
		expect(marker).toHaveAttribute("data-marker", "broken-navigation");
		expect(marker).toHaveAttribute("title", "1 navigation cannot be reached on mobile · nav#main");
		expect(marker.style.left).toBe("0%");
		expect(marker.style.top).toBe("50%");
		expect(marker.style.width).toBe("100%");
		expect(Number.parseFloat(marker.style.height)).toBeCloseTo(10);
		fireEvent.click(screen.getByLabelText("Box the faulty elements"));
		expect(document.querySelector("[data-marker]")).toBeNull();
		expect(useDeviceMatrixStore.getState().showMarkers).toBe(false);
	});

	it("says when it was opened for the review of a task", () => {
		render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/" auto />);
		expect(screen.getByText("Shown for the review of this task: its changes touch the interface.")).toBeInTheDocument();
	});

	it("exports a PDF through the main, with the markers choice", async () => {
		reset({ "iphone-15": done("iphone-15", report({})) });
		exportEmulatorDeviceGrid.mockResolvedValueOnce({ success: true, data: { saved: true, fileName: "grid.pdf" } });
		render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/" />);
		fireEvent.click(screen.getByLabelText("Box the faulty elements"));
		fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
		expect(await screen.findByRole("status")).toHaveTextContent("Grid saved as grid.pdf.");
		expect(exportEmulatorDeviceGrid).toHaveBeenCalledWith({ deviceIds: ["iphone-15"], format: "pdf", markers: false });
	});

	it("exports the grid through the main and says how it went", async () => {
		reset({ "iphone-15": done("iphone-15", report({})), "pixel-8": { status: "failed", error: "load-failed" } });
		let finish: (value: unknown) => void = () => undefined;
		exportEmulatorDeviceGrid.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
		render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/" />);
		fireEvent.click(screen.getByRole("button", { name: "Export PNG" }));
		expect(await screen.findAllByRole("button", { name: "Exporting…" })).toHaveLength(2);
		expect(exportEmulatorDeviceGrid).toHaveBeenCalledWith({ deviceIds: ["iphone-15"], format: "png", markers: true });
		finish({ success: true, data: { saved: true, fileName: "grid.png" } });
		expect(await screen.findByRole("status")).toHaveTextContent("Grid saved as grid.png.");
		exportEmulatorDeviceGrid.mockResolvedValueOnce({ success: false, error: "nothing-to-export" });
		fireEvent.click(screen.getByRole("button", { name: "Export PNG" }));
		expect(await screen.findByText("No capture to export: capture devices first.")).toHaveAttribute("role", "alert");
	});

	it("offers no export before a device has rendered", () => {
		reset({ "iphone-15": { status: "failed", error: "load-failed" } });
		render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/" />);
		expect(screen.getByRole("button", { name: "Export PNG" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Export PDF" })).toBeDisabled();
	});

	it("selects all, none, and says when the shown page is elsewhere", () => {
		render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="https://example.com/" />);
		expect(screen.getByText(/the matrix renders the server root/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "All" }));
		expect(screen.getByRole("button", { name: "Capture 10 devices" })).toBeEnabled();
		fireEvent.click(screen.getByRole("button", { name: "None" }));
		expect(screen.getByRole("button", { name: "Capture 0 devices" })).toBeDisabled();
	});

	it("shows progress and lets the run stop after the device in progress", () => {
		reset({ "iphone-15": { status: "capturing" }, "pixel-8": { status: "pending" } });
		useDeviceMatrixStore.setState({ running: true });
		render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/" />);
		expect(screen.getByRole("status")).toHaveTextContent("Rendering on this device…");
		expect(screen.getByText("Waiting…")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Stop after this device" }));
		expect(useDeviceMatrixStore.getState().stopRequested).toBe(true);
		expect(screen.getByRole("button", { name: "Stop after this device" })).toBeDisabled();
	});

	it("shows each capture side by side with what the reading found", () => {
		const onCapture = vi.fn();
		reset({
			"iphone-15": done(
				"iphone-15",
				report({
					scrollWidth: 450,
					truncated: true,
					scanned: 4000,
					issues: [
						{
							kind: "small-touch-target",
							count: 5,
							samples: [
								{ selector: "button.icon", x: 0, y: 0, width: 24, height: 24 },
								{ selector: "a.more", x: 0, y: 40, width: 30, height: 20 },
							],
						},
						{ kind: "horizontal-overflow", count: 1, samples: [] },
						{
							kind: "overlapping-elements",
							count: 2,
							samples: [{ selector: "h1.title / button.cta", x: 0, y: 0, width: 40, height: 20 }],
						},
						{ kind: "truncated-text", count: 1, samples: [] },
					],
				}),
			),
			"pixel-8": done("pixel-8", report({})),
			"ipad-mini": done("ipad-mini", null),
		});
		render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/" onCapture={onCapture} />);
		const tiles = document.querySelectorAll("figure[data-device]");
		expect([...tiles].map((tile) => tile.getAttribute("data-device"))).toEqual(["iphone-15", "pixel-8", "ipad-mini"]);
		const iphone = within(tiles[0] as HTMLElement);
		expect(iphone.getByAltText("The page rendered on iPhone 15")).toHaveAttribute("src", "data:image/png;base64,AA==");
		expect(iphone.getByText("The page is 57 px wider than the screen: it scrolls sideways.")).toBeInTheDocument();
		expect(iphone.getByText("5 touch targets smaller than 44 × 44 px")).toBeInTheDocument();
		expect(iphone.getByText("1 element goes past the edge of the screen")).toBeInTheDocument();
		expect(iphone.getByText("button.icon")).toBeInTheDocument();
		expect(iphone.getByText("2 pairs of elements overlap")).toBeInTheDocument();
		expect(iphone.getByText("h1.title / button.cta")).toBeInTheDocument();
		expect(iphone.getByText("1 text is cut off or spills out of its box")).toBeInTheDocument();
		expect(iphone.getByText("Partial reading: the first 4000 elements only.")).toBeInTheDocument();
		expect(within(tiles[1] as HTMLElement).getByText("No responsive bug detected.")).toBeInTheDocument();
		expect(within(tiles[2] as HTMLElement).getByText("The page could not be read for responsive bugs.")).toBeInTheDocument();
		fireEvent.click(iphone.getByRole("button", { name: "Keep for the visual review" }));
		expect(onCapture).toHaveBeenCalledWith("data:image/png;base64,AA==", "http://localhost:5173/cart#iphone-15");
		fireEvent.click(screen.getByRole("button", { name: "Clear the captures" }));
		expect(document.querySelectorAll("figure[data-device]")).toHaveLength(0);
	});

	it("offers no keep button without a review to keep it for", () => {
		reset({ "iphone-15": done("iphone-15", report({})) });
		render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/" />);
		expect(screen.queryByRole("button", { name: "Keep for the visual review" })).not.toBeInTheDocument();
	});
});

describe("ResponsivePreview with the device matrix", () => {
	beforeEach(() => reset());

	it("opens the matrix over the preview and keeps the webview mounted", () => {
		render(<ResponsivePreview url="http://localhost:5173" refreshKey={0} />);
		const toggle = screen.getByRole("button", { name: "Device matrix" });
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: "Capture 1 device" })).toBeInTheDocument();
		const webview = document.querySelector("webview");
		expect(webview).not.toBeNull();
		expect(webview?.parentElement?.parentElement).toHaveClass("invisible");
		fireEvent.click(toggle);
		expect(screen.queryByRole("button", { name: "Capture 1 device" })).not.toBeInTheDocument();
		expect(webview?.parentElement?.parentElement).not.toHaveClass("invisible");
	});

	it("does not reopen the matrix for a review key already captured", () => {
		useDeviceMatrixStore.setState({ autoCaptured: ["task-1"] });
		render(<ResponsivePreview url="http://localhost:5173" refreshKey={0} autoMatrixKey="task-1" />);
		expect(screen.getByRole("button", { name: "Device matrix" })).toHaveAttribute("aria-pressed", "false");
		expect(captureEmulatorDevice).not.toHaveBeenCalled();
	});
});
