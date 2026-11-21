import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOfficeCalm } from "../use-office-motion";

type Listener = (event: { matches: boolean }) => void;

function stubMatchMedia(matches: boolean) {
	const listeners = new Set<Listener>();
	const query = {
		matches,
		addEventListener: vi.fn((_: string, l: Listener) => listeners.add(l)),
		removeEventListener: vi.fn((_: string, l: Listener) => listeners.delete(l)),
	};
	vi.stubGlobal("matchMedia", vi.fn(() => query));
	return { query, fire: (next: boolean) => listeners.forEach((l) => l({ matches: next })) };
}

describe("useOfficeCalm", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("follows calm mode where the system says nothing", () => {
		vi.stubGlobal("matchMedia", undefined);
		const { result, rerender } = renderHook(({ calm }) => useOfficeCalm(calm), {
			initialProps: { calm: false },
		});
		expect(result.current).toBe(false);
		rerender({ calm: true });
		expect(result.current).toBe(true);
	});

	it("holds still while the system asks for reduced motion, live", () => {
		const media = stubMatchMedia(true);
		const { result, unmount } = renderHook(() => useOfficeCalm(false));
		expect(result.current).toBe(true);
		act(() => media.fire(false));
		expect(result.current).toBe(false);
		unmount();
		expect(media.query.removeEventListener).toHaveBeenCalled();
	});
});
