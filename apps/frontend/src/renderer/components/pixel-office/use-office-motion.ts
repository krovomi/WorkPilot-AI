import { useEffect, useState } from "react";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
	return typeof globalThis.matchMedia === "function"
		? globalThis.matchMedia(REDUCED_MOTION)
		: null;
}

/**
 * Whether the office should hold still: the person turned calm mode on, or
 * their system asks for reduced motion. The system setting is followed live,
 * so turning it on while the office is open stops the animations at once.
 */
export function useOfficeCalm(calmMode: boolean): boolean {
	const [reduced, setReduced] = useState(
		() => reducedMotionQuery()?.matches ?? false,
	);

	useEffect(() => {
		const query = reducedMotionQuery();
		if (!query) return;
		const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);

	return calmMode || reduced;
}
