/**
 * @vitest-environment jsdom
 */
/**
 * The device matrix (#383): pick devices, capture them through the main,
 * see them side by side with what the reading found, and keep one for the
 * visual review. The preview keeps its `<webview>` mounted behind it.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import type { ResponsiveReport } from "../../../../shared/types/device-matrix";
import { useDeviceMatrixStore } from "../../../stores/device-matrix-store";
import { DeviceMatrix, matrixPath } from "../DeviceMatrix";
import { ResponsivePreview } from "../ResponsivePreview";

const captureEmulatorDevice = vi.fn();
Object.defineProperty(window, "electronAPI", { value: { captureEmulatorDevice }, writable: true });

const done = (deviceId: string, report: ResponsiveReport | null) => ({
	status: "done" as const,
	capture: { deviceId, url: `http://localhost:5173/cart#${deviceId}`, image: "data:image/png;base64,AA==", report },
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
	useDeviceMatrixStore.setState({ selected: ["iphone-15"], entries, running: false, stopRequested: false });
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
		expect(captureEmulatorDevice).toHaveBeenCalledWith({ deviceId: "iphone-15", path: "/cart" });
		expect(captureEmulatorDevice).toHaveBeenCalledWith({ deviceId: "pixel-8", path: "/cart" });
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
});
