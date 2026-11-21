/**
 * What an import side panel keeps in the browser storage: its width, and the
 * last list of work items read for a project (five minutes). Storage that is
 * full, refused or holds something else reads as nothing saved.
 */

export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 800;
export const PANEL_DEFAULT_WIDTH = 384;
export const CACHE_DURATION_MS = 5 * 60 * 1000;

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// A width or a list that cannot be kept is read again next time.
	}
}

/** The saved width, when it is one the panel can take. */
export function readPanelWidth(key: string): number | null {
	const width = Number.parseInt(read(key) ?? "", 10);
	return width >= PANEL_MIN_WIDTH && width <= PANEL_MAX_WIDTH ? width : null;
}

export function writePanelWidth(key: string, width: number): void {
	write(key, String(width));
}

export interface CachedItems<T> {
	readonly items: T[];
	readonly time: number;
}

/** The list saved under `key`, if it was saved less than five minutes ago. */
export function readCachedItems<T>(key: string, now = Date.now()): CachedItems<T> | null {
	const time = Number.parseInt(read(`${key}-time`) ?? "", 10);
	if (!(now - time < CACHE_DURATION_MS)) return null;
	try {
		const items: unknown = JSON.parse(read(key) ?? "");
		return Array.isArray(items) ? { items: items as T[], time } : null;
	} catch {
		return null;
	}
}

export function writeCachedItems<T>(key: string, items: T[], time: number): void {
	write(key, JSON.stringify(items));
	write(`${key}-time`, String(time));
}
