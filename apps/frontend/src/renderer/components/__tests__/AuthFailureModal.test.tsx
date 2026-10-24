/**
 * A 401 from Claude opens this modal through the auth store. It was mounted
 * nowhere until lot M8, so an expired token showed nothing at all.
 *
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

import { useAuthStore } from "../../stores/auth-store";
import { AuthFailureModal } from "../AuthFailureModal";

function failAuth() {
	act(() =>
		useAuthStore.getState().authFailure_show({
			profileId: "p1",
			profileName: "Work",
			failureType: "expired",
			message: "token expired",
			detectedAt: new Date(0),
		}),
	);
}

describe("AuthFailureModal", () => {
	beforeEach(() => {
		act(() => useAuthStore.getState().authFailure_clear());
	});

	it("shows nothing until an authentication fails", () => {
		render(<AuthFailureModal />);
		expect(screen.queryByText("auth.failure.title")).toBeNull();
	});

	it("opens on a failure and leads to the settings", () => {
		const onOpenSettings = vi.fn();
		render(<AuthFailureModal onOpenSettings={onOpenSettings} />);
		failAuth();
		expect(screen.getByText("auth.failure.title")).toBeTruthy();
		expect(screen.getByText("auth.failure.tokenExpired")).toBeTruthy();
		fireEvent.click(screen.getByText("auth.failure.goToSettings"));
		expect(onOpenSettings).toHaveBeenCalledOnce();
		expect(useAuthStore.getState().authFailure_isModalOpen).toBe(false);
	});
});

describe("App", () => {
	it("mounts the modals that useIpc opens", () => {
		const app = readFileSync(
			path.resolve(__dirname, "../../App.tsx"),
			"utf-8",
		);
		for (const modal of [
			"RateLimitModal",
			"SDKRateLimitModal",
			"AuthFailureModal",
		]) {
			expect(app, modal).toMatch(new RegExp(`<${modal}[\\s/>]`));
		}
	});
});
