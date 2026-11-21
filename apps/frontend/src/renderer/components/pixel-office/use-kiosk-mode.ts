import { type RefObject, useCallback, useEffect, useState } from "react";

/** How often TV mode reads the tasks and incidents again, in ms. */
export const KIOSK_REFRESH_MS = 60_000;

/**
 * TV mode: the office alone, full screen, for a screen the team looks at.
 *
 * The state is ours, the full screen is best effort: where the Fullscreen API
 * refuses (or is missing), the office still switches to its TV layout inside
 * the window. Esc, or leaving full screen by any other way, leaves TV mode
 * too. While it is on, `onRefresh` runs every minute, since nobody is there to
 * click.
 */
export function useKioskMode(
	target: RefObject<HTMLElement | null>,
	onRefresh: () => void,
) {
	const [active, setActive] = useState(false);

	useEffect(() => {
		if (!active) return;
		const onChange = () => {
			if (!document.fullscreenElement) setActive(false);
		};
		// Esc leaves a real full screen by itself; in the window, it is ours to read.
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !document.fullscreenElement) setActive(false);
		};
		document.addEventListener("fullscreenchange", onChange);
		globalThis.addEventListener("keydown", onKey);
		const timer = setInterval(onRefresh, KIOSK_REFRESH_MS);
		return () => {
			document.removeEventListener("fullscreenchange", onChange);
			globalThis.removeEventListener("keydown", onKey);
			clearInterval(timer);
		};
	}, [active, onRefresh]);

	const enter = useCallback(() => {
		setActive(true);
		const el = target.current;
		if (typeof el?.requestFullscreen === "function") {
			el.requestFullscreen().catch(() => {
				// Refused (no user gesture, policy): TV mode stays on in the window.
			});
		}
	}, [target]);

	const exit = useCallback(() => {
		setActive(false);
		if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
			document.exitFullscreen().catch(() => {
				// Already left: nothing to undo.
			});
		}
	}, []);

	return { active, enter, exit };
}
