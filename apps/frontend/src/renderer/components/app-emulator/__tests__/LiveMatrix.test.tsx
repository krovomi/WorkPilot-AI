/**
 * @vitest-environment jsdom
 */
/**
 * The live views of the device matrix (#383): one `<webview>` per checked
 * device on the emulator's server, emulated by the main once it is ready;
 * navigating one leads the others to the same page of that server, scrolling
 * one scrolls the others to the same share, and a reload of the preview
 * reloads them all.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_PRESETS, findDevicePreset } from "../../../../shared/constants/device-presets";
import type { DevicePreset } from "../../../../shared/types/device-matrix";
import { useDeviceLibraryStore } from "../../../stores/device-library-store";
import { useDeviceMatrixStore } from "../../../stores/device-matrix-store";
import { DeviceMatrix } from "../DeviceMatrix";
import { LiveMatrix, SCROLL_SYNC_MS } from "../LiveMatrix";

const api = {
	emulateEmulatorLiveView: vi.fn(),
	readEmulatorLiveScroll: vi.fn(),
	setEmulatorLiveScroll: vi.fn(),
	listEmulatorCustomDevices: vi.fn(async () => ({ success: true, data: [] })),
	listEmulatorPersonas: vi.fn(async () => ({ success: true, data: [] })),
};
Object.defineProperty(window, "electronAPI", { value: api, writable: true });

const device = (id: string) => findDevicePreset(id) as DevicePreset;
const name = (preset: DevicePreset) => preset.id;

type FakeView = HTMLElement & {
	getWebContentsId: () => number;
	loadURL: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	getURL: () => string;
};

/** Gives each rendered `<webview>` the guest methods Electron adds, with ids from 100. */
function wire(): FakeView[] {
	const views = [...document.querySelectorAll("webview")] as FakeView[];
	views.forEach((view, index) => {
		let url = view.getAttribute("src") ?? "";
		view.getWebContentsId = () => 100 + index;
		view.loadURL = vi.fn(async (next: string) => {
			url = next;
		});
		view.reload = vi.fn();
		view.getURL = () => url;
	});
	return views;
}

const navigate = (view: HTMLElement, url: string, type = "did-navigate") =>
	view.dispatchEvent(Object.assign(new Event(type), { url }));

beforeEach(() => {
	for (const fn of [api.emulateEmulatorLiveView, api.readEmulatorLiveScroll, api.setEmulatorLiveScroll]) fn.mockReset();
	api.emulateEmulatorLiveView.mockResolvedValue({ success: true, data: { reloaded: false } });
	api.setEmulatorLiveScroll.mockResolvedValue({ success: true, data: { x: 0, y: 0 } });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("LiveMatrix", () => {
	it("shows each device live on the server's page, scaled to its tile, and has the main emulate it", async () => {
		render(
			<LiveMatrix
				serverUrl="http://localhost:5173/"
				path="/cart"
				devices={[device("iphone-15"), device("desktop-1080p")]}
				orientation="landscape"
				deviceName={name}
			/>,
		);
		const [phone, desktop] = wire();
		expect(phone).toHaveAttribute("src", "http://localhost:5173/cart");
		expect(phone.style.width).toBe("852px");
		expect(desktop.style.transform).toBe(`scale(${360 / 1920})`);
		act(() => {
			phone.dispatchEvent(new Event("dom-ready"));
		});
		expect(api.emulateEmulatorLiveView).toHaveBeenCalledWith({
			webContentsId: 100,
			deviceId: "iphone-15",
			orientation: "landscape",
		});
	});

	it("says when the main could not emulate a view, and clears it once it could", async () => {
		api.emulateEmulatorLiveView.mockResolvedValueOnce({ success: false, error: "elsewhere" });
		render(
			<LiveMatrix serverUrl="http://localhost:5173" path="/" devices={[device("pixel-8")]} orientation="portrait" deviceName={name} />,
		);
		const [view] = wire();
		await act(async () => {
			view.dispatchEvent(new Event("dom-ready"));
		});
		expect(screen.getByRole("alert")).toHaveTextContent("This view left the emulator's server");
		api.emulateEmulatorLiveView.mockRejectedValueOnce(new Error("bridge gone"));
		await act(async () => {
			view.dispatchEvent(new Event("dom-ready"));
		});
		expect(screen.getByRole("alert")).toHaveTextContent("The device could not be emulated in this view.");
		await act(async () => {
			view.dispatchEvent(new Event("dom-ready"));
		});
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		// A view not attached yet is not named to the main.
		view.getWebContentsId = () => {
			throw new Error("not attached");
		};
		view.dispatchEvent(new Event("dom-ready"));
		expect(api.emulateEmulatorLiveView).toHaveBeenCalledTimes(3);
	});

	it("leads the other views to a page of the same server, and only there", () => {
		render(
			<LiveMatrix
				serverUrl="http://localhost:5173"
				path="/"
				devices={[device("iphone-15"), device("pixel-8"), device("ipad-mini")]}
				orientation="portrait"
				deviceName={name}
			/>,
		);
		const [first, second, third] = wire();
		// A view that cannot load says so itself (`did-fail-load`): the others still follow.
		second.loadURL.mockRejectedValueOnce(new Error("ERR_ABORTED"));
		navigate(first, "http://localhost:5173/account");
		expect(second.loadURL).toHaveBeenCalledWith("http://localhost:5173/account");
		expect(third.loadURL).toHaveBeenCalledWith("http://localhost:5173/account");
		expect(first.loadURL).not.toHaveBeenCalled();
		// The followers announce the same page: nothing goes round again.
		navigate(second, "http://localhost:5173/account");
		expect(first.loadURL).not.toHaveBeenCalled();
		navigate(third, "http://localhost:5173/account#tab", "did-navigate-in-page");
		expect(first.loadURL).toHaveBeenCalledWith("http://localhost:5173/account#tab");
		expect(third.loadURL).toHaveBeenCalledTimes(1);
		navigate(first, "https://elsewhere.example/");
		navigate(first, 42 as never);
		expect(second.loadURL).toHaveBeenCalledTimes(2);
		fireEvent.click(screen.getByLabelText("Navigate and scroll together"));
		navigate(first, "http://localhost:5173/settings");
		expect(second.loadURL).toHaveBeenCalledTimes(2);
	});

	it("scrolls the others to the share of the view under the pointer", async () => {
		vi.useFakeTimers();
		api.readEmulatorLiveScroll.mockResolvedValue({ success: true, data: { x: 0, y: 0.5 } });
		render(
			<LiveMatrix
				serverUrl="http://localhost:5173"
				path="/"
				devices={[device("iphone-15"), device("pixel-8")]}
				orientation="portrait"
				deviceName={name}
			/>,
		);
		const [first, second] = wire();
		second.dispatchEvent(new Event("mouseenter"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SCROLL_SYNC_MS);
		});
		expect(api.readEmulatorLiveScroll).toHaveBeenCalledWith(101);
		expect(api.setEmulatorLiveScroll).toHaveBeenCalledWith({ webContentsIds: [100], x: 0, y: 0.5 });
		// The same share is not sent again.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SCROLL_SYNC_MS);
		});
		expect(api.setEmulatorLiveScroll).toHaveBeenCalledTimes(1);
		first.dispatchEvent(new Event("focus"));
		api.readEmulatorLiveScroll.mockResolvedValueOnce({ success: false, error: "unknown-view" });
		api.readEmulatorLiveScroll.mockRejectedValueOnce(new Error("bridge gone"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SCROLL_SYNC_MS * 2);
		});
		expect(api.readEmulatorLiveScroll).toHaveBeenLastCalledWith(100);
		expect(api.setEmulatorLiveScroll).toHaveBeenCalledTimes(1);
	});

	it("reads nothing with a single view or views not attached yet", async () => {
		vi.useFakeTimers();
		const { unmount } = render(
			<LiveMatrix serverUrl="http://localhost:5173" path="/" devices={[device("pixel-8")]} orientation="portrait" deviceName={name} />,
		);
		wire();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SCROLL_SYNC_MS * 2);
		});
		unmount();
		render(
			<LiveMatrix
				serverUrl="http://localhost:5173"
				path="/"
				devices={[device("iphone-15"), device("pixel-8")]}
				orientation="portrait"
				deviceName={name}
			/>,
		);
		const views = wire();
		for (const view of views) {
			view.getWebContentsId = () => Number.NaN as never;
			(view as unknown as { getWebContentsId: () => unknown }).getWebContentsId = () => "100";
		}
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SCROLL_SYNC_MS * 2);
		});
		expect(api.readEmulatorLiveScroll).not.toHaveBeenCalled();
	});

	it("reloads every view when the preview reloads, and caps the number of views", () => {
		const props = {
			serverUrl: "not a url",
			path: "/",
			devices: DEVICE_PRESETS,
			orientation: "portrait" as const,
			deviceName: name,
		};
		const { rerender } = render(<LiveMatrix {...props} refreshKey={0} />);
		const views = wire();
		expect(views).toHaveLength(6);
		expect(views[0]).toHaveAttribute("src", "not a url");
		expect(screen.getByRole("status")).toHaveTextContent("6 live views at most");
		rerender(<LiveMatrix {...props} refreshKey={0} />);
		expect(views[0].reload).not.toHaveBeenCalled();
		rerender(<LiveMatrix {...props} refreshKey={1} />);
		for (const view of views) expect(view.reload).toHaveBeenCalledTimes(1);
	});

	it("asks for devices when none is checked", () => {
		render(<LiveMatrix serverUrl="http://localhost:5173" path="/" devices={[]} orientation="portrait" deviceName={name} />);
		expect(screen.getByText("Check devices to see them live, side by side.")).toBeInTheDocument();
	});
});

describe("DeviceMatrix live mode", () => {
	it("switches between the captures and the live views of the checked devices", () => {
		useDeviceLibraryStore.setState({ customDevices: [], personas: [], loaded: true });
		useDeviceMatrixStore.setState({ selected: ["pixel-8"], entries: {}, running: false, scan: null, orientation: "portrait" });
		render(<DeviceMatrix serverUrl="http://localhost:5173" currentUrl="http://localhost:5173/cart" />);
		const captures = screen.getByRole("button", { name: "Captures" });
		expect(captures).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(screen.getByRole("button", { name: "Live views" }));
		expect(screen.getByRole("button", { name: "Live views" })).toHaveAttribute("aria-pressed", "true");
		expect(document.querySelector("figure[data-live-device='pixel-8'] webview")).toHaveAttribute(
			"src",
			"http://localhost:5173/cart",
		);
		fireEvent.click(captures);
		expect(document.querySelector("webview")).toBeNull();
	});
});
