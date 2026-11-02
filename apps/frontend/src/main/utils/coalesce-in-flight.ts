/**
 * One run at a time: while `run` is in flight, every caller gets that same
 * promise instead of starting another. Each caller after it settles starts a
 * fresh run, so nothing is cached. For checks the renderer fires from several
 * places at once on launch (status contexts, banners, React StrictMode's
 * double effects in development), which would otherwise run, and log, twice.
 */
export function coalesceInFlight<T>(run: () => Promise<T>): () => Promise<T> {
	let inFlight: Promise<T> | null = null;
	return () => {
		inFlight ??= run().finally(() => {
			inFlight = null;
		});
		return inFlight;
	};
}
