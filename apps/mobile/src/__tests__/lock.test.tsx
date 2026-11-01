import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { AppState, Platform, Text } from "react-native";
import "../i18n";
import {
	authenticate,
	confirmSensitive,
	DEFAULT_LOCK,
	loadLockSettings,
	RELOCK_AFTER_MS,
	saveLockSettings,
} from "../auth/lock";
import { LockGate } from "../auth/LockGate";
import { LockSection } from "../auth/LockSection";

const authenticateAsync = LocalAuthentication.authenticateAsync as jest.Mock;
const enrolledLevel = LocalAuthentication.getEnrolledLevelAsync as jest.Mock;
const store: Map<string, string> = jest.requireMock("expo-secure-store").__store;

const realOs = Platform.OS;
beforeEach(() => {
	Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
	store.clear();
	jest.clearAllMocks();
	// A value queued by one test never answers in the next.
	authenticateAsync.mockReset().mockResolvedValue({ success: true });
	enrolledLevel.mockReset().mockResolvedValue(LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG);
	// The Jest preset's AppState hands back no subscription.
	jest
		.spyOn(AppState, "addEventListener")
		.mockReturnValue({ remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>);
});
afterAll(() => {
	Object.defineProperty(Platform, "OS", { value: realOs, configurable: true });
});

describe("lock settings", () => {
	it("asks before sensitive actions and not at launch, until the person says otherwise", async () => {
		await expect(loadLockSettings()).resolves.toEqual(DEFAULT_LOCK);
		expect(DEFAULT_LOCK).toEqual({ atLaunch: false, sensitive: true });
		await saveLockSettings({ atLaunch: true, sensitive: false });
		await expect(loadLockSettings()).resolves.toEqual({ atLaunch: true, sensitive: false });
	});

	it("falls back to the defaults on a damaged entry", async () => {
		store.set("workpilot.lock", "{not json");
		await expect(loadLockSettings()).resolves.toEqual(DEFAULT_LOCK);
		store.set("workpilot.lock", JSON.stringify({ atLaunch: "yes" }));
		await expect(loadLockSettings()).resolves.toEqual(DEFAULT_LOCK);
	});
});

describe("authenticate", () => {
	it("is true only when the person is recognized", async () => {
		await expect(authenticate("Unlock", "Cancel")).resolves.toBe(true);
		expect(authenticateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ promptMessage: "Unlock", disableDeviceFallback: false }),
		);
		authenticateAsync.mockResolvedValueOnce({ success: false, error: "user_cancel" });
		await expect(authenticate("Unlock", "Cancel")).resolves.toBe(false);
	});

	it("lets everything through on a phone that cannot ask", async () => {
		enrolledLevel.mockResolvedValueOnce(LocalAuthentication.SecurityLevel.NONE);
		await expect(authenticate("Unlock", "Cancel")).resolves.toBe(true);
		expect(authenticateAsync).not.toHaveBeenCalled();
	});

	it("does not ask before a sensitive action when the person turned that off", async () => {
		await saveLockSettings({ atLaunch: false, sensitive: false });
		await expect(confirmSensitive("Confirm", "Cancel")).resolves.toBe(true);
		expect(authenticateAsync).not.toHaveBeenCalled();
		await saveLockSettings(DEFAULT_LOCK);
		authenticateAsync.mockResolvedValueOnce({ success: false, error: "user_cancel" });
		await expect(confirmSensitive("Confirm", "Cancel")).resolves.toBe(false);
	});
});

describe("LockGate", () => {
	it("shows the screens at once when the lock is off at launch", async () => {
		await render(
			<LockGate>
				<Text>Board</Text>
			</LockGate>,
		);
		await screen.findByText("Board");
		expect(screen.queryByText("WorkPilot AI is locked")).toBeNull();
		expect(authenticateAsync).not.toHaveBeenCalled();
	});

	it("covers the screens until the person is recognized", async () => {
		await saveLockSettings({ atLaunch: true, sensitive: true });
		authenticateAsync.mockResolvedValueOnce({ success: false, error: "user_cancel" });
		await render(
			<LockGate>
				<Text>Board</Text>
			</LockGate>,
		);
		await screen.findByText("Not recognized. Try again.");
		expect(screen.getByText("WorkPilot AI is locked")).toBeTruthy();
		fireEvent.press(screen.getByRole("button", { name: "Unlock" }));
		await waitFor(() => expect(screen.queryByText("WorkPilot AI is locked")).toBeNull());
		expect(screen.getByText("Board")).toBeTruthy();
	});

	it("locks again after a while in the background, not after a glance away", async () => {
		await saveLockSettings({ atLaunch: true, sensitive: true });
		const listeners = new Set<(state: string) => void>();
		jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
			const fn = listener as (state: string) => void;
			listeners.add(fn);
			return { remove: () => listeners.delete(fn) } as unknown as ReturnType<typeof AppState.addEventListener>;
		});
		const now = jest.spyOn(Date, "now");
		try {
			await render(
				<LockGate>
					<Text>Board</Text>
				</LockGate>,
			);
			await waitFor(() => expect(screen.queryByText("WorkPilot AI is locked")).toBeNull());
			const emit = (state: string) => act(() => {
					for (const listener of listeners) listener(state);
				});

			now.mockReturnValue(1_000);
			await emit("background");
			now.mockReturnValue(1_000 + RELOCK_AFTER_MS - 1);
			await emit("active");
			expect(screen.queryByText("WorkPilot AI is locked")).toBeNull();

			authenticateAsync.mockResolvedValueOnce({ success: false, error: "user_cancel" });
			now.mockReturnValue(5_000);
			await emit("background");
			now.mockReturnValue(5_000 + RELOCK_AFTER_MS);
			await emit("active");
			await screen.findByText("WorkPilot AI is locked");
			expect(authenticateAsync).toHaveBeenCalledTimes(2);
		} finally {
			now.mockRestore();
		}
	});
});

describe("LockSection", () => {
	const renderSection = () =>
		render(
			<LockGate>
				<LockSection />
			</LockGate>,
		);

	it("asks for the lock before turning it off", async () => {
		await renderSection();
		const sensitive = await screen.findByLabelText(/Ask before merging/);
		authenticateAsync.mockResolvedValueOnce({ success: false, error: "user_cancel" });
		fireEvent(sensitive, "valueChange", false);
		await waitFor(() => expect(authenticateAsync).toHaveBeenCalledTimes(1));
		await expect(loadLockSettings()).resolves.toEqual(DEFAULT_LOCK);

		fireEvent(sensitive, "valueChange", false);
		await waitFor(() => expect(screen.getByLabelText(/Ask before merging/).props.value).toBe(false));
		await expect(loadLockSettings()).resolves.toEqual({ atLaunch: false, sensitive: false });
	});

	it("cannot be turned on where the phone has no lock", async () => {
		enrolledLevel.mockResolvedValue(LocalAuthentication.SecurityLevel.NONE);
		await renderSection();
		await screen.findByText("Set a passcode or biometrics on this phone to use the lock.");
		// The Jest preset's Switch takes `disabled` as is, not as an accessibility state.
		expect(screen.getByLabelText("Ask when the app opens").props.disabled).toBe(true);
	});
});
