/**
 * The voice assistant's keyboard shortcut, stored as an Electron accelerator
 * (`CommandOrControl+Shift+Space`) so the same string serves the in-app
 * listener (renderer) and the opt-in system-wide registration (main).
 *
 * The default, Ctrl+Shift+Space (⌘⇧Space on macOS), is used by no shortcut of
 * the app, of Electron's default menu, of the terminal (xterm) or of the
 * Kanban. `shortcutConflict` refuses the combinations the app already uses,
 * so a custom choice cannot silently shadow one of them.
 */

export const DEFAULT_VOICE_SHORTCUT = "CommandOrControl+Shift+Space";

export interface ParsedShortcut {
	/** Cmd on macOS, Ctrl elsewhere. */
	mod: boolean;
	/** Control itself (macOS only: elsewhere `mod` is Control). */
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
	/** Super / Windows key outside macOS. */
	meta: boolean;
	key: string;
}

const PUNCTUATION = new Set([",", ".", "/", ";", "'", "[", "]", "\\", "-", "=", "`"]);

/** A key name an accelerator may end with: A-Z, 0-9, F1-F24, Space, Enter or punctuation. */
export function isShortcutKey(key: string): boolean {
	return (
		/^[A-Z0-9]$/.test(key) ||
		/^F([1-9]|1[0-9]|2[0-4])$/.test(key) ||
		key === "Space" ||
		key === "Enter" ||
		PUNCTUATION.has(key)
	);
}

/** The accelerator's parts, or null when it is not one this module writes. */
export function parseAccelerator(accelerator: unknown): ParsedShortcut | null {
	if (typeof accelerator !== "string" || accelerator.length > 64) return null;
	// "+" is never a key here (its key is "="), so a plain split is safe.
	const parts = accelerator.split("+");
	const key = parts.pop() ?? "";
	if (!isShortcutKey(key)) return null;
	const parsed: ParsedShortcut = {
		mod: false,
		ctrl: false,
		alt: false,
		shift: false,
		meta: false,
		key,
	};
	for (const part of parts) {
		switch (part) {
			case "CommandOrControl":
			case "CmdOrCtrl":
				parsed.mod = true;
				break;
			case "Control":
			case "Ctrl":
				parsed.ctrl = true;
				break;
			case "Alt":
			case "Option":
				parsed.alt = true;
				break;
			case "Shift":
				parsed.shift = true;
				break;
			case "Super":
			case "Meta":
				parsed.meta = true;
				break;
			default:
				return null;
		}
	}
	// A bare letter or Shift+letter is typing, not a shortcut.
	if (!parsed.mod && !parsed.ctrl && !parsed.alt && !parsed.meta) return null;
	return parsed;
}

/** The accelerator for these parts (modifiers in a fixed order). */
export function toAccelerator(parsed: ParsedShortcut): string {
	const parts: string[] = [];
	if (parsed.mod) parts.push("CommandOrControl");
	if (parsed.ctrl) parts.push("Control");
	if (parsed.alt) parts.push("Alt");
	if (parsed.shift) parts.push("Shift");
	if (parsed.meta) parts.push("Super");
	parts.push(parsed.key);
	return parts.join("+");
}

/** What a person reads: `⌘⇧Space` on macOS, `Ctrl+Shift+Space` elsewhere. */
export function formatShortcut(accelerator: string, mac: boolean): string {
	const parsed = parseAccelerator(accelerator);
	if (!parsed) return accelerator;
	if (mac) {
		return [
			parsed.ctrl ? "⌃" : "",
			parsed.alt ? "⌥" : "",
			parsed.shift ? "⇧" : "",
			parsed.mod || parsed.meta ? "⌘" : "",
			parsed.key,
		].join("");
	}
	const parts: string[] = [];
	if (parsed.mod || parsed.ctrl) parts.push("Ctrl");
	if (parsed.alt) parts.push("Alt");
	if (parsed.shift) parts.push("Shift");
	if (parsed.meta) parts.push("Win");
	parts.push(parsed.key);
	return parts.join("+");
}

/** The keyboard event fields the shortcut is read from. */
export interface ShortcutKeyEvent {
	key: string;
	code: string;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	metaKey: boolean;
}

/**
 * The key an event names, in accelerator spelling, or null for a modifier
 * alone or a key the shortcut cannot use. Letters and digits come from the
 * character the layout produces (an AZERTY « A » is `A`), and from the
 * physical key when a modifier turned the character into something else
 * (Option+V on macOS types « √ »).
 */
export function eventKeyName(event: ShortcutKeyEvent): string | null {
	if (event.code === "Space" || event.key === " ") return "Space";
	if (event.key === "Enter") return "Enter";
	if (/^F\d{1,2}$/.test(event.key)) return isShortcutKey(event.key) ? event.key : null;
	if (/^[a-zA-Z0-9]$/.test(event.key)) return event.key.toUpperCase();
	if (PUNCTUATION.has(event.key)) return event.key;
	const fromCode = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code);
	if (fromCode) return fromCode[1] ?? fromCode[2] ?? null;
	return null;
}

/** The accelerator a key press makes, or null when it is not a usable shortcut. */
export function acceleratorFromEvent(event: ShortcutKeyEvent, mac: boolean): string | null {
	const key = eventKeyName(event);
	if (!key) return null;
	const parsed: ParsedShortcut = {
		mod: mac ? event.metaKey : event.ctrlKey,
		ctrl: mac ? event.ctrlKey : false,
		alt: event.altKey,
		shift: event.shiftKey,
		meta: mac ? false : event.metaKey,
		key,
	};
	return parseAccelerator(toAccelerator(parsed)) ? toAccelerator(parsed) : null;
}

/** Whether this key press is the shortcut. */
export function matchesShortcut(
	event: ShortcutKeyEvent,
	accelerator: string,
	mac: boolean,
): boolean {
	const parsed = parseAccelerator(accelerator);
	if (!parsed) return false;
	const wantsCtrl = mac ? parsed.ctrl : parsed.mod || parsed.ctrl;
	const wantsMeta = mac ? parsed.mod || parsed.meta : parsed.meta;
	return (
		event.ctrlKey === wantsCtrl &&
		event.metaKey === wantsMeta &&
		event.altKey === parsed.alt &&
		event.shiftKey === parsed.shift &&
		eventKeyName(event) === parsed.key
	);
}

/**
 * Combinations the app (or the OS, or Electron's menu) already answers, keyed
 * `mod+shift+alt+key` with every Ctrl / Cmd folded into `mod`. The value is
 * what the refusal shows.
 */
const RESERVED: Readonly<Record<string, string>> = {
	"mod+K": "Ctrl+K",
	"mod+/": "Ctrl+/",
	"mod+N": "Ctrl+N",
	"mod+,": "Ctrl+,",
	"mod+T": "Ctrl+T",
	"mod+shift+T": "Ctrl+Shift+T",
	"mod+W": "Ctrl+W",
	"mod+C": "Ctrl+C",
	"mod+V": "Ctrl+V",
	"mod+X": "Ctrl+X",
	"mod+A": "Ctrl+A",
	"mod+Z": "Ctrl+Z",
	"mod+shift+Z": "Ctrl+Shift+Z",
	"mod+Y": "Ctrl+Y",
	"mod+shift+C": "Ctrl+Shift+C",
	"mod+shift+V": "Ctrl+Shift+V",
	"mod+shift+I": "Ctrl+Shift+I",
	"mod+R": "Ctrl+R",
	"mod+shift+R": "Ctrl+Shift+R",
	"mod+F": "Ctrl+F",
	"mod+S": "Ctrl+S",
	"mod+Q": "Ctrl+Q",
	"mod+M": "Ctrl+M",
	"mod+H": "Ctrl+H",
	"mod+=": "Ctrl+=",
	"mod+-": "Ctrl+-",
	"mod+0": "Ctrl+0",
	"mod+Enter": "Ctrl+Enter",
	"mod+shift+Enter": "Ctrl+Shift+Enter",
	"mod+Space": "Ctrl+Space",
	"alt+F4": "Alt+F4",
	"mod+F4": "Ctrl+F4",
};

/**
 * Why this accelerator cannot be the assistant's, or null when it can:
 * `invalid`, `altgr` (Ctrl+Alt types « @ », « € », « [ » on many European
 * layouts), or the existing shortcut it would shadow (`Ctrl+K`).
 */
export function shortcutConflict(accelerator: string): string | null {
	const parsed = parseAccelerator(accelerator);
	if (!parsed) return "invalid";
	const mod = parsed.mod || parsed.ctrl || parsed.meta;
	if ((parsed.mod || parsed.ctrl) && parsed.alt && !parsed.meta) return "altgr";
	// Ctrl/Cmd + 1-9 switch views and project tabs.
	if (mod && !parsed.alt && !parsed.shift && /^[1-9]$/.test(parsed.key)) return "Ctrl+1…9";
	const id = [mod ? "mod" : "", parsed.shift ? "shift" : "", parsed.alt ? "alt" : "", parsed.key]
		.filter(Boolean)
		.join("+");
	return RESERVED[id] ?? null;
}
