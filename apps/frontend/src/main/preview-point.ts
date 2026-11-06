/**
 * Point an element of the task preview, over the DevTools protocol (F10).
 *
 * The preview is a `<webview>` without preload, sandboxed, without Node
 * (`security/webview-policy.ts`): no WorkPilot script ever runs in the page,
 * and none is added here. The main process attaches the guest's debugger,
 * turns on the inspect overlay (`Overlay.setInspectMode`, the DevTools
 * element picker) and reads the node the person clicked: its attributes, DOM
 * path, outer HTML, a few computed styles, and an image of its box. No
 * `Runtime` command is sent: nothing is evaluated in the page.
 *
 * Only a `<webview>` hosted by the window that asks can be pointed: the
 * renderer passes an id, the main checks what it names (rule S6).
 */

import { type WebContents, webContents } from "electron";
import { type PointedNode, pickStyles, selectorOf } from "../shared/utils/element-sources";

/** The overlay waits this long for a click, then lets the page go. */
export const PICK_TIMEOUT_MS = 120_000;
const MAX_PATH = 8;
const MAX_ATTRIBUTE = 300;
const MAX_HTML = 4000;
const MAX_SHOT_SIDE = 1600;

export interface PickedElement {
	node: PointedNode;
	/** PNG of the element's box, null when the page gave no image. */
	image: Buffer | null;
}

interface CdpNode {
	nodeId: number;
	nodeType?: number;
	localName?: string;
	nodeName?: string;
	attributes?: string[];
	children?: CdpNode[];
}

/** Pickers in progress, by the guest's id: one at a time per preview. */
const active = new Map<number, () => void>();

/** The guest `<webview>` this window hosts with this id, or null. */
export function resolvePreview(sender: WebContents, id: unknown): WebContents | null {
	if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
	const guest = webContents.fromId(id);
	if (!guest || guest.isDestroyed() || guest.getType() !== "webview") return null;
	if (guest.hostWebContents?.id !== sender.id) return null;
	return guest;
}

function attributesOf(raw: readonly string[] | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; raw && i + 1 < raw.length; i += 2) {
		const name = String(raw[i]).toLowerCase();
		if (name.startsWith("on")) continue; // an inline handler is code, not a marker
		out[name] = String(raw[i + 1]).slice(0, MAX_ATTRIBUTE);
	}
	return out;
}

/** Stop a picker in progress on this guest; true when there was one. */
export function cancelPick(guestId: number): boolean {
	const stop = active.get(guestId);
	if (!stop) return false;
	stop();
	return true;
}

/**
 * Wait for the person to click an element of the guest, and describe it.
 * Resolves null when cancelled, timed out or the page went away. Throws
 * `Error("pick_in_progress")` while another pick waits on this preview, and
 * `Error("devtools_open")` when a debugger is already attached (the
 * preview's DevTools are open).
 */
export async function pickElement(
	guest: WebContents,
	timeoutMs = PICK_TIMEOUT_MS,
): Promise<PickedElement | null> {
	const dbg = guest.debugger;
	if (active.has(guest.id)) throw new Error("pick_in_progress");
	if (dbg.isAttached()) throw new Error("devtools_open");
	dbg.attach("1.3");
	const parents = new Map<number, number>();
	const nodes = new Map<number, CdpNode>();
	const index = (node: CdpNode, parentId: number | null) => {
		nodes.set(node.nodeId, node);
		if (parentId !== null) parents.set(node.nodeId, parentId);
		for (const child of node.children ?? []) index(child, node.nodeId);
	};
	let settle: (backendNodeId: number | null) => void = () => undefined;
	const picked = new Promise<number | null>((resolve) => {
		settle = resolve;
	});
	const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
		if (method === "Overlay.inspectNodeRequested") {
			settle(typeof params.backendNodeId === "number" ? params.backendNodeId : null);
		} else if (method === "DOM.setChildNodes" && Array.isArray(params.nodes)) {
			for (const node of params.nodes as CdpNode[]) index(node, Number(params.parentId));
		}
	};
	const onDetach = () => settle(null);
	const timer = setTimeout(() => settle(null), timeoutMs);
	dbg.on("message", onMessage);
	dbg.on("detach", onDetach);
	guest.once("destroyed", onDetach);
	active.set(guest.id, () => settle(null));
	const send = <T>(method: string, params?: Record<string, unknown>) =>
		dbg.sendCommand(method, params) as Promise<T>;
	try {
		await send("DOM.enable");
		await send("CSS.enable");
		await send("Overlay.enable");
		await send("Overlay.setInspectMode", {
			mode: "searchForNode",
			highlightConfig: {
				showInfo: true,
				contentColor: { r: 111, g: 168, b: 220, a: 0.5 },
				borderColor: { r: 37, g: 99, b: 235, a: 0.9 },
			},
		});
		const backendNodeId = await picked;
		if (backendNodeId === null || guest.isDestroyed()) return null;
		await send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} });
		const doc = await send<{ root: CdpNode }>("DOM.getDocument", { depth: 0 });
		index(doc.root, null);
		const { nodeIds } = await send<{ nodeIds: number[] }>(
			"DOM.pushNodesByBackendIdsToFrontend",
			{ backendNodeIds: [backendNodeId] },
		);
		const nodeId = nodeIds[0];
		if (!nodeId) return null;
		// The path's nodes arrive as `DOM.setChildNodes` before the reply; let them land.
		await new Promise((resolve) => setImmediate(resolve));
		const { node } = await send<{ node: CdpNode }>("DOM.describeNode", { nodeId });
		const tag = node.localName || node.nodeName?.toLowerCase() || "node";
		const { outerHTML } = await send<{ outerHTML: string }>("DOM.getOuterHTML", { nodeId });
		const styles = await computedStyles(send, nodeId);
		const image = await shotOf(send, guest, nodeId);
		return {
			node: {
				tag,
				attributes: attributesOf(node.attributes),
				path: pathOf(nodeId, parents, nodes),
				outerHtml: String(outerHTML ?? "").slice(0, MAX_HTML),
				styles,
				url: guest.getURL(),
			},
			image,
		};
	} finally {
		clearTimeout(timer);
		active.delete(guest.id);
		dbg.removeListener("message", onMessage);
		dbg.removeListener("detach", onDetach);
		if (!guest.isDestroyed()) {
			guest.removeListener("destroyed", onDetach);
			try {
				await send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} });
			} catch {
				// the page navigated or closed: nothing left to turn off
			}
			if (dbg.isAttached()) dbg.detach();
		}
	}
}

function pathOf(
	nodeId: number,
	parents: ReadonlyMap<number, number>,
	nodes: ReadonlyMap<number, CdpNode>,
): string[] {
	const path: string[] = [];
	let current = parents.get(nodeId);
	while (current !== undefined && path.length < MAX_PATH) {
		const node = nodes.get(current);
		if (node?.nodeType !== 1) break; // the document or a shadow root ends it
		path.push(selectorOf(node.localName || "node", attributesOf(node.attributes)));
		current = parents.get(current);
	}
	return path;
}

type Send = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

async function computedStyles(send: Send, nodeId: number): Promise<Record<string, string>> {
	try {
		const { computedStyle } = await send<{
			computedStyle: Array<{ name: string; value: string }>;
		}>("CSS.getComputedStyleForNode", { nodeId });
		const all: Record<string, string> = {};
		for (const { name, value } of computedStyle ?? []) if (value) all[name] = String(value);
		return pickStyles(all);
	} catch {
		return {}; // a text node or an SVG part has no computed style to give
	}
}

async function shotOf(send: Send, guest: WebContents, nodeId: number): Promise<Buffer | null> {
	try {
		const { model } = await send<{ model: { border: number[] } }>("DOM.getBoxModel", {
			nodeId,
		});
		const xs = [model.border[0], model.border[2], model.border[4], model.border[6]];
		const ys = [model.border[1], model.border[3], model.border[5], model.border[7]];
		const x = Math.max(0, Math.floor(Math.min(...xs)) - 4);
		const y = Math.max(0, Math.floor(Math.min(...ys)) - 4);
		const width = Math.min(MAX_SHOT_SIDE, Math.ceil(Math.max(...xs)) + 4 - x);
		const height = Math.min(MAX_SHOT_SIDE, Math.ceil(Math.max(...ys)) + 4 - y);
		if (width <= 0 || height <= 0) return null;
		const image = await guest.capturePage({ x, y, width, height });
		return image.isEmpty() ? null : image.toPNG();
	} catch {
		return null; // a node without a box (display: none) has no image
	}
}
