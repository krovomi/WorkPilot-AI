import { beforeEach, describe, expect, it } from "vitest";
import type { MobileDevice, MobilePlan } from "../../shared/types/mobile";
import {
	preferredDevice,
	preferredPlatform,
	useMobileStore,
} from "./mobile-store";

function device(overrides: Partial<MobileDevice> = {}): MobileDevice {
	return {
		id: "avd-1",
		name: "Pixel 8",
		platform: "android",
		kind: "emulator",
		state: "shutdown",
		runtime: "",
		isBooted: false,
		...overrides,
	};
}

function plan(overrides: Partial<MobilePlan> = {}): MobilePlan {
	return {
		success: true,
		isMobile: true,
		stack: {
			framework: "flutter",
			platforms: ["android", "ios"],
			projectDir: "/repo",
			packageId: "",
			evidence: ["pubspec.yaml"],
			notes: "",
			isCrossPlatform: true,
			commands: {},
		},
		platforms: {
			android: { platform: "android", ok: true, blocker: "", checks: [] },
			ios: {
				platform: "ios",
				ok: false,
				blocker: "iOS cannot be built on this machine",
				checks: [],
			},
		},
		devices: [device()],
		unavailable: {},
		...overrides,
	};
}

describe("preferredDevice", () => {
	it("prefers a device that is already booted", () => {
		// Preselecting a shut-down emulator means the first click on Run spends a
		// minute booting one while a booted one sits next to it in the list.
		const booted = device({ id: "emulator-5554", isBooted: true });
		expect(preferredDevice([device(), booted], "android")).toBe(booted);
	});

	it("never offers a device from the other platform", () => {
		const simulator = device({ id: "udid", platform: "ios", isBooted: true });
		expect(preferredDevice([simulator], "android")).toBeNull();
	});

	it("falls back to the first device when none is booted", () => {
		const first = device({ id: "a" });
		expect(preferredDevice([first, device({ id: "b" })], "android")).toBe(first);
	});
});

describe("preferredPlatform", () => {
	it("opens on a platform this machine can actually build", () => {
		// Opening on iOS off macOS shows a blocker before the user chose anything.
		expect(preferredPlatform(plan())).toBe("android");
	});

	it("falls back to the first declared platform when none is buildable", () => {
		expect(
			preferredPlatform(
				plan({
					platforms: {
						android: {
							platform: "android",
							ok: false,
							blocker: "no SDK",
							checks: [],
						},
						ios: { platform: "ios", ok: false, blocker: "not macOS", checks: [] },
					},
				}),
			),
		).toBe("android");
	});

	it("is null when the project is not a mobile one", () => {
		expect(preferredPlatform(null)).toBeNull();
	});
});

describe("useMobileStore", () => {
	beforeEach(() => {
		useMobileStore.getState().reset();
	});

	it("preselects a buildable platform and its device", () => {
		useMobileStore.getState().setPlan(plan());
		expect(useMobileStore.getState().platform).toBe("android");
		expect(useMobileStore.getState().device?.id).toBe("avd-1");
	});

	it("keeps the selected device across a refresh that still lists it", () => {
		const store = useMobileStore.getState();
		store.setPlan(plan({ devices: [device({ id: "a" }), device({ id: "b" })] }));
		store.selectDevice(device({ id: "b" }));
		// A device list refresh must not silently move the selection elsewhere.
		useMobileStore
			.getState()
			.setPlan(plan({ devices: [device({ id: "a" }), device({ id: "b" })] }));
		expect(useMobileStore.getState().device?.id).toBe("b");
	});

	it("drops the frame when the platform changes", () => {
		const store = useMobileStore.getState();
		store.setPlan(plan());
		store.setScreenshot("data:image/png;base64,AAA");
		useMobileStore.getState().selectPlatform("ios");
		// The frame on screen belonged to the platform being left.
		expect(useMobileStore.getState().screenshot).toBeNull();
	});

	it("caps the log buffer rather than growing without bound", () => {
		const store = useMobileStore.getState();
		for (let i = 0; i < 500; i += 1) {
			useMobileStore.getState().appendOutput(`line ${i}`);
		}
		const lines = useMobileStore.getState().output.split("\n");
		expect(lines.length).toBeLessThanOrEqual(400);
		expect(lines.at(-1)).toBe("line 499");
		expect(store).toBeDefined();
	});
});
