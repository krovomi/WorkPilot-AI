/**
 * The dynamic accessibility scan: the running app, as a keyboard and a screen
 * reader meet it (#391).
 *
 * The page (the App Emulator's URL, or one the person typed, always on this
 * computer: `validateScanUrl`) is loaded in a hidden window with no preload,
 * no Node, a sandbox and an in-memory session, and may not navigate to
 * another origin or open windows. Through the Chrome DevTools Protocol the
 * scan reads the accessibility tree, presses Tab and notes where the focus
 * lands, and measures the rendered colours. Everything the page answers is
 * data, reshaped by `sanitizeTrace` before any rule reads it.
 */
import { BrowserWindow, session } from "electron";
import type { A11yViolation, WcagLevel } from "../../shared/types/accessibility";
import { analyseTrace, sanitizeTrace, validateScanUrl } from "./dynamic-checks";

const LOAD_TIMEOUT_MS = 20_000;
const MAX_TABS = 60;
const PARTITION = "a11y-scan";

/** Runs in the page: describes the focused element. */
const FOCUS_PROBE = `(() => {
	const el = document.activeElement;
	if (!el || el === document.body) return null;
	const r = el.getBoundingClientRect();
	const cs = getComputedStyle(el);
	const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
	const ring = cs.boxShadow && cs.boxShadow !== "none";
	const label = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || el.getAttribute("alt") || "").slice(0, 80);
	return {
		tag: el.tagName, label, top: r.top + scrollY, left: r.left + scrollX, width: r.width, height: r.height,
		outlineVisible: Boolean(outline || ring), href: el.getAttribute("href") || "",
		inDialog: Boolean(el.closest('[role="dialog"],[role="alertdialog"],dialog[open]')),
		key: el.tagName + "|" + Math.round(r.top) + "|" + Math.round(r.left) + "|" + label,
	};
})()`;

/** Runs in the page: language, title, skip target, text colours, open dialogs. */
const PAGE_PROBE = `(() => {
	const samples = [];
	const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
	const seen = new Set();
	const bgOf = (node) => {
		for (let el = node; el; el = el.parentElement) {
			const cs = getComputedStyle(el);
			if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
			const bg = cs.backgroundColor;
			if (bg && !/rgba\\([^)]*,\\s*0\\)$/.test(bg) && bg !== "transparent") return bg;
		}
		return "rgb(255, 255, 255)";
	};
	while (walker.nextNode() && samples.length < 400) {
		const text = walker.currentNode.textContent.trim();
		const el = walker.currentNode.parentElement;
		if (!text || !el || seen.has(el)) continue;
		seen.add(el);
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.opacity === "0") continue;
		const cls = typeof el.className === "string" ? el.className.trim().split(/\\s+/).slice(0, 3).join(".") : "";
		samples.push({
			text: text.slice(0, 60), color: cs.color, background: bgOf(el),
			fontSizePx: parseFloat(cs.fontSize), fontWeight: parseInt(cs.fontWeight, 10) || 400,
			selector: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (cls ? "." + cls : ""),
		});
	}
	const first = document.querySelector("a[href^='#']");
	const target = first ? first.getAttribute("href").slice(1) : "";
	return {
		lang: document.documentElement.getAttribute("lang") || "",
		title: document.title || "",
		skipTargetExists: Boolean(target && document.getElementById(target)),
		samples,
	};
})()`;

/** Runs in the page: the open modal dialogs, focus put on their first control. */
const DIALOG_PROBE = `(() => {
	const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"],[role="alertdialog"],dialog[open]')]
		.filter((d) => d.getBoundingClientRect().width > 0).slice(0, 5);
	return dialogs.map((d, i) => { d.setAttribute("data-wp-a11y-dialog", String(i)); return (d.getAttribute("aria-label") || d.querySelector("h1,h2,h3")?.innerText || "dialog").slice(0, 80); });
})()`;

const focusDialog = (i: number) => `(() => {
	const d = document.querySelector('[data-wp-a11y-dialog="${i}"]');
	const f = d && d.querySelector('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])');
	if (f) f.focus();
	return Boolean(f);
})()`;
const inDialog = (i: number) =>
	`Boolean(document.activeElement && document.activeElement.closest('[data-wp-a11y-dialog="${i}"]'))`;

export interface DynamicScanResult {
	readonly url: string;
	readonly violations: A11yViolation[];
	readonly focusStops: number;
}

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

async function evaluate(send: Send, expression: string): Promise<unknown> {
	const answer = (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false })) as {
		result?: { value?: unknown };
	};
	return answer?.result?.value;
}

async function pressTab(send: Send): Promise<void> {
	const key = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
	await send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
	await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

async function collect(send: Send): Promise<Record<string, unknown>> {
	await send("Accessibility.enable");
	const tree = (await send("Accessibility.getFullAXTree")) as { nodes?: unknown[] };
	const ax = (tree?.nodes ?? []).slice(0, 5000).map((node) => {
		const n = node as { role?: { value?: unknown }; name?: { value?: unknown }; ignored?: unknown };
		return { role: n.role?.value, name: n.name?.value, ignored: n.ignored === true };
	});
	const page = ((await evaluate(send, PAGE_PROBE)) ?? {}) as Record<string, unknown>;

	const focus: unknown[] = [];
	const keys = new Set<string>();
	await evaluate(send, "document.activeElement && document.activeElement.blur && document.activeElement.blur()");
	for (let i = 0; i < MAX_TABS; i += 1) {
		await pressTab(send);
		const stop = (await evaluate(send, FOCUS_PROBE)) as { key?: unknown } | null;
		if (!stop) continue;
		const key = String(stop.key ?? "");
		if (keys.has(key)) break; // back to the start: the cycle is complete
		keys.add(key);
		focus.push(stop);
	}

	const labels = ((await evaluate(send, DIALOG_PROBE)) ?? []) as unknown[];
	const dialogs: unknown[] = [];
	for (let i = 0; i < Math.min(labels.length, 5); i += 1) {
		if (!(await evaluate(send, focusDialog(i)))) continue;
		let stayed = true;
		for (let k = 0; k < 15 && stayed; k += 1) {
			await pressTab(send);
			stayed = (await evaluate(send, inDialog(i))) === true;
		}
		dialogs.push({ label: labels[i], stayedInside: stayed });
	}
	return { ...page, ax, focus, dialogs };
}

/** Scan the page at `rawUrl`; throws a short, person-readable error. */
export async function runDynamicScan(rawUrl: unknown, level: WcagLevel): Promise<DynamicScanResult> {
	const url = validateScanUrl(rawUrl);
	if (!url) throw new Error("Only an app running on this computer (localhost) can be scanned.");
	const origin = new URL(url).origin;
	const scanSession = session.fromPartition(PARTITION, { cache: false });
	scanSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
	const win = new BrowserWindow({
		show: false,
		width: 1280,
		height: 900,
		webPreferences: {
			session: scanSession,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: false,
			spellcheck: false,
		},
	});
	const wc = win.webContents;
	wc.setWindowOpenHandler(() => ({ action: "deny" }));
	const stayOnOrigin = (event: { preventDefault: () => void }, target: string) => {
		try {
			if (new URL(target).origin !== origin) event.preventDefault();
		} catch {
			event.preventDefault();
		}
	};
	wc.on("will-navigate", (event, target) => stayOnOrigin(event, target));
	wc.on("will-redirect", (event, target) => stayOnOrigin(event, target));
	try {
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			wc.loadURL(url),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("The page did not load in time.")), LOAD_TIMEOUT_MS);
			}),
		]).finally(() => clearTimeout(timer));
		wc.debugger.attach("1.3");
		const send: Send = (method, params) => wc.debugger.sendCommand(method, params);
		const raw = await collect(send);
		const trace = sanitizeTrace(raw, wc.getURL() || url);
		return { url: trace.url, violations: analyseTrace(trace, level), focusStops: trace.focus.length };
	} finally {
		try {
			if (wc.debugger.isAttached()) wc.debugger.detach();
		} catch {
			// already gone with the window
		}
		win.destroy();
		await scanSession.clearStorageData().catch(() => undefined);
	}
}
