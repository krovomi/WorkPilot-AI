/**
 * @vitest-environment node
 *
 * The preview's element picker speaks the DevTools protocol only: it turns
 * the inspect overlay on, reads the node clicked, and never evaluates code in
 * the page. Only a `<webview>` hosted by the asking window can be pointed.
 */

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const guests = vi.hoisted(() => new Map<number, unknown>());
vi.mock("electron", () => ({ webContents: { fromId: (id: number) => guests.get(id) } }));

import { cancelPick, pickElement, resolvePreview } from "../preview-point";

class FakeDebugger extends EventEmitter {
	attached = false;
	sent: string[] = [];
	constructor(private readonly replies: Record<string, (params: unknown) => unknown>) {
		super();
	}
	isAttached() {
		return this.attached;
	}
	attach() {
		this.attached = true;
	}
	detach() {
		this.attached = false;
	}
	async sendCommand(method: string, params?: unknown) {
		this.sent.push(method);
		const reply = this.replies[method];
		return reply ? reply(params) : {};
	}
}

function guest(dbg: FakeDebugger, hostId = 1, type = "webview") {
	const emitter = new EventEmitter();
	return Object.assign(emitter, {
		id: 7,
		debugger: dbg,
		hostWebContents: { id: hostId },
		isDestroyed: () => false,
		getType: () => type,
		getURL: () => "http://localhost:3000/cart",
		capturePage: vi.fn(async () => ({ isEmpty: () => false, toPNG: () => Buffer.from("png") })),
	});
}

function pageDebugger(): FakeDebugger {
	const dbg: FakeDebugger = new FakeDebugger({
		"DOM.getDocument": () => ({ root: { nodeId: 1, nodeType: 9, localName: "" } }),
		"DOM.pushNodesByBackendIdsToFrontend": () => {
			// Chromium sends the path's nodes before the reply.
			dbg.emit("message", {}, "DOM.setChildNodes", {
				parentId: 1,
				nodes: [
					{
						nodeId: 2,
						nodeType: 1,
						localName: "html",
						children: [
							{
								nodeId: 3,
								nodeType: 1,
								localName: "main",
								attributes: ["class", "checkout"],
								children: [{ nodeId: 4, nodeType: 1, localName: "button" }],
							},
						],
					},
				],
			});
			return { nodeIds: [4] };
		},
		"DOM.describeNode": () => ({
			node: {
				nodeId: 4,
				localName: "button",
				attributes: ["data-testid", "pay", "onclick", "steal()", "class", "pay-cta"],
			},
		}),
		"DOM.getOuterHTML": () => ({ outerHTML: '<button data-testid="pay">Pay</button>' }),
		"CSS.getComputedStyleForNode": () => ({
			computedStyle: [
				{ name: "color", value: "rgb(0, 0, 0)" },
				{ name: "cursor", value: "pointer" },
			],
		}),
		"DOM.getBoxModel": () => ({ model: { border: [10, 20, 110, 20, 110, 60, 10, 60] } }),
	});
	return dbg;
}

beforeEach(() => guests.clear());

describe("preview point", () => {
	it("only resolves a webview hosted by the asking window", () => {
		const dbg = pageDebugger();
		guests.set(7, guest(dbg));
		guests.set(8, guest(dbg, 99));
		guests.set(9, guest(dbg, 1, "window"));
		const sender = { id: 1 } as Electron.WebContents;
		expect(resolvePreview(sender, 7)).not.toBeNull();
		expect(resolvePreview(sender, 8)).toBeNull(); // another window's preview
		expect(resolvePreview(sender, 9)).toBeNull(); // not a webview
		expect(resolvePreview(sender, "7")).toBeNull();
		expect(resolvePreview(sender, 1.5)).toBeNull();
		expect(resolvePreview(sender, 404)).toBeNull();
	});

	it("reads the clicked node over the protocol, without running code in the page", async () => {
		const dbg = pageDebugger();
		const view = guest(dbg);
		const picking = pickElement(view as unknown as Electron.WebContents);
		await vi.waitFor(() => expect(dbg.sent).toContain("Overlay.setInspectMode"));
		dbg.emit("message", {}, "Overlay.inspectNodeRequested", { backendNodeId: 42 });
		const picked = await picking;
		expect(picked?.node).toMatchObject({
			tag: "button",
			attributes: { "data-testid": "pay", class: "pay-cta" },
			path: ["main.checkout", "html"],
			styles: { color: "rgb(0, 0, 0)" },
			url: "http://localhost:3000/cart",
		});
		expect(picked?.node.attributes).not.toHaveProperty("onclick");
		expect(picked?.image?.toString()).toBe("png");
		expect(view.capturePage).toHaveBeenCalledWith({ x: 6, y: 16, width: 108, height: 48 });
		expect(dbg.sent.some((m) => m.startsWith("Runtime."))).toBe(false);
		expect(dbg.attached).toBe(false);
	});

	it("lets the page go when cancelled, and refuses when DevTools hold it", async () => {
		const dbg = pageDebugger();
		const view = guest(dbg) as unknown as Electron.WebContents;
		const picking = pickElement(view);
		await vi.waitFor(() => expect(dbg.sent).toContain("Overlay.setInspectMode"));
		await expect(pickElement(view)).rejects.toThrow("pick_in_progress");
		expect(cancelPick(7)).toBe(true);
		expect(await picking).toBeNull();
		expect(dbg.attached).toBe(false);
		dbg.attached = true; // the person opened the preview's DevTools
		await expect(pickElement(view)).rejects.toThrow("devtools_open");
	});

	it("gives up after its timeout", async () => {
		const dbg = pageDebugger();
		expect(await pickElement(guest(dbg) as unknown as Electron.WebContents, 10)).toBeNull();
		expect(dbg.attached).toBe(false);
	});
});
