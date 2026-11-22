/**
 * The office canvas: what each agent looks like at its desk, when the room is
 * redrawn, and which agent a click lands on.
 */
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type PixelAgent,
	usePixelOfficeStore,
} from "../../../stores/pixel-office-store";
import {
	CHAR_OFFSET_Y,
	computeOfficeLayout,
	computeViewport,
	DESK_W,
	seatPosition,
} from "../office-layout";
import { PixelOfficeCanvas } from "../PixelOfficeCanvas";
import { TILE_SIZE } from "../pixel-sprites";
import {
	CHAR_WIDTH,
	type CanvasCall,
	type FakeContext,
	installFakeCanvas,
	removeCanvasContext,
} from "./fake-canvas";

const ZOOM = 3;
const WIDTH = 800;
const HEIGHT = 500;

let contextOf: (canvas: HTMLCanvasElement) => FakeContext;
let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
const initialStore = usePixelOfficeStore.getState();

function agent(overrides: Partial<PixelAgent>): PixelAgent {
	return {
		id: "a",
		type: "terminal",
		name: "Agent",
		fullName: "Agent",
		characterIndex: 0,
		activity: "idle",
		seatIndex: 0,
		isClaudeMode: false,
		...overrides,
	};
}

function seat(agents: PixelAgent[], selectedAgentId: string | null = null, showGrid = false) {
	usePixelOfficeStore.setState({
		agents,
		selectedAgentId,
		settings: { ...initialStore.settings, zoom: ZOOM, showGrid },
	});
}

function mount(onAgentClick?: (id: string, x: number, y: number) => void) {
	const view = render(
		<PixelOfficeCanvas
			width={WIDTH}
			height={HEIGHT}
			emptyDeskLabel="free"
			onAgentClick={onAgentClick}
		/>,
	);
	const canvas = view.container.querySelector("canvas") as HTMLCanvasElement;
	return { ...view, canvas, calls: () => contextOf(canvas).calls };
}

/** Run the pending animation frame at `timestamp`. */
function tick(timestamp: number) {
	const pending = [...frames.values()];
	frames.clear();
	for (const cb of pending) cb(timestamp);
}

/** Draw one frame and return only what that frame drew. */
function drawFrame(calls: () => CanvasCall[], timestamp = 1000): CanvasCall[] {
	const before = calls().length;
	tick(timestamp);
	return calls().slice(before);
}

const texts = (calls: CanvasCall[]) =>
	calls.filter((c) => c.name === "fillText").map((c) => c.args[0]);

/** drawImage calls of a sprite of the given size (the character is 16×24). */
const imagesOf = (calls: CanvasCall[], w: number, h: number) =>
	calls.filter((c) => {
		if (c.name !== "drawImage") return false;
		const img = c.args[0] as HTMLCanvasElement;
		return img.width === w && img.height === h;
	});

beforeEach(() => {
	contextOf = installFakeCanvas();
	frames = new Map();
	nextFrameId = 0;
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		nextFrameId += 1;
		frames.set(nextFrameId, cb);
		return nextFrameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	usePixelOfficeStore.setState(initialStore, true);
});

describe("PixelOfficeCanvas drawing", () => {
	it("writes each agent's name under its desk and the caption on the free ones", () => {
		seat([agent({ id: "t1", fullName: "Fix login", activity: "typing" })]);
		const { calls } = mount();
		const drawn = drawFrame(calls);
		expect(texts(drawn)).toEqual(["Fix login", "free", "free", "free"]);
	});

	it("wraps a long name over three lines at most and cuts a word wider than the desk", () => {
		const longWord = "x".repeat(40);
		seat([
			agent({ id: "a", fullName: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen" }),
			agent({ id: "b", seatIndex: 1, fullName: `${longWord} end` }),
		]);
		const { calls } = mount();
		const labels = texts(drawFrame(calls)).filter((t) => t !== "free");
		const maxChars = (36 * ZOOM) / CHAR_WIDTH;
		expect(labels.slice(0, 3)).toEqual([
			"one two three four five six",
			"seven eight nine ten eleven",
			"twelve thirteen fourteen",
		]);
		expect(labels.slice(3)).toEqual(["x".repeat(maxChars), "end"]);
	});

	it("writes no label for an agent without a name", () => {
		seat([agent({ fullName: "" })]);
		const { calls } = mount();
		expect(texts(drawFrame(calls))).toEqual(["free", "free", "free"]);
	});

	it("dims an idle agent and a closed session; neither gets an icon, the closed one no Claude aura", () => {
		seat([
			agent({ id: "busy", activity: "typing", isClaudeMode: true }),
			agent({ id: "idle", seatIndex: 1, activity: "idle", isClaudeMode: true }),
			agent({ id: "ghost", seatIndex: 2, activity: "exited", isClaudeMode: true }),
		]);
		const { calls } = mount();
		const drawn = drawFrame(calls);
		expect(imagesOf(drawn, 16, 24).map((c) => c.globalAlpha)).toEqual([1, 0.55, 0.32]);
		// One activity icon, the busy agent's; the Claude aura on both live sessions.
		expect(imagesOf(drawn, 12, 12)).toHaveLength(1);
		expect(drawn.filter((c) => c.name === "arc").map((c) => c.fillStyle)).toEqual([
			"#D97706",
			"#D97706",
		]);
	});

	it("draws an icon over every working activity and a glow under it", () => {
		seat(
			(["typing", "running", "reading", "waiting"] as const).map((activity, i) =>
				agent({ id: activity, seatIndex: i, activity }),
			),
		);
		const { calls } = mount();
		const drawn = drawFrame(calls);
		expect(imagesOf(drawn, 12, 12)).toHaveLength(4);
		expect(drawn.filter((c) => c.name === "ellipse")).toHaveLength(4);
		// The monitor lights up only for an agent that is working, not waiting.
		expect(drawn.filter((c) => c.name === "roundRect")).toHaveLength(3);
	});

	it("draws a progress gauge, clamped to the desk, and none on a closed session", () => {
		const gaugeWidths = (progress: number, activity: PixelAgent["activity"] = "waiting") => {
			seat([agent({ activity, progress })]);
			const view = mount();
			const widths = drawFrame(view.calls)
				.filter((c) => c.name === "roundRect")
				.map((c) => c.args[2]);
			view.unmount();
			return widths;
		};
		expect(gaugeWidths(0)).toEqual([DESK_W * ZOOM]);
		expect(gaugeWidths(50)).toEqual([DESK_W * ZOOM, (DESK_W * ZOOM) / 2]);
		expect(gaugeWidths(250)).toEqual([DESK_W * ZOOM, DESK_W * ZOOM]);
		expect(gaugeWidths(1)).toEqual([DESK_W * ZOOM, 2.5 * ZOOM]);
		expect(gaugeWidths(50, "exited")).toEqual([]);
	});

	it("rings the selected agent and writes its name in gold, an idle one in grey", () => {
		seat(
			[
				agent({ id: "sel", fullName: "Selected", activity: "typing" }),
				agent({ id: "other", seatIndex: 1, fullName: "Resting" }),
				agent({ id: "busy", seatIndex: 2, fullName: "Busy", activity: "running" }),
			],
			"sel",
		);
		const { calls } = mount();
		const drawn = drawFrame(calls);
		const colourOf = (name: string) =>
			drawn.find((c) => c.name === "fillText" && c.args[0] === name)?.fillStyle;
		expect(colourOf("Selected")).toBe("#FFD700");
		expect(colourOf("Resting")).toBe("#808080");
		expect(colourOf("Busy")).toBe("#1ABC9C");
		expect(drawn.filter((c) => c.name === "strokeRect" && c.strokeStyle === "#FFD700")).toHaveLength(1);
	});

	it("dresses an agent in its provider's colour", () => {
		seat([agent({ providerFamily: "openai" })]);
		const { calls } = mount();
		const [character] = imagesOf(drawFrame(calls), 16, 24);
		const sprite = character.args[0] as HTMLCanvasElement;
		expect(contextOf(sprite).calls.map((c) => c.fillStyle)).toContain("#10A37F");
	});

	it("dresses every agent in the skin chosen", () => {
		seat([agent({ providerFamily: "openai" })]);
		const view = render(
			<PixelOfficeCanvas width={WIDTH} height={HEIGHT} emptyDeskLabel="free" skin="neon" />,
		);
		const canvas = view.container.querySelector("canvas") as HTMLCanvasElement;
		const [character] = imagesOf(drawFrame(() => contextOf(canvas).calls), 16, 24);
		const shirts = contextOf(character.args[0] as HTMLCanvasElement).calls.map((c) => c.fillStyle);
		expect(shirts).toContain("#FF2E97");
		expect(shirts).not.toContain("#10A37F");
	});

	it("draws the decor the seasons earned, and none by default", () => {
		seat([agent({})]);
		const plain = mount();
		const neon = (calls: CanvasCall[]) => calls.some((c) => c.fillStyle === "#F472B6");
		expect(neon(drawFrame(plain.calls))).toBe(false);
		plain.unmount();

		const view = render(
			<PixelOfficeCanvas width={WIDTH} height={HEIGHT} emptyDeskLabel="free" decor={["neon-sign"]} />,
		);
		const canvas = view.container.querySelector("canvas") as HTMLCanvasElement;
		expect(neon(drawFrame(() => contextOf(canvas).calls))).toBe(true);
	});

	it("draws the tile grid only when it is switched on", () => {
		seat([agent({})]);
		const off = mount();
		expect(drawFrame(off.calls).some((c) => c.name === "lineTo")).toBe(false);
		off.unmount();

		seat([agent({})], null, true);
		const on = mount();
		const layout = computeOfficeLayout(1, WIDTH, ZOOM);
		expect(drawFrame(on.calls).filter((c) => c.name === "lineTo")).toHaveLength(
			layout.cols + 1 + layout.rows + 1,
		);
	});

	it("follows the store between frames without restarting the loop", () => {
		seat([agent({ fullName: "Before" })]);
		const { calls } = mount();
		expect(texts(drawFrame(calls, 1000))).toContain("Before");
		act(() => seat([agent({ fullName: "After" })]));
		expect(texts(drawFrame(calls, 2000))).toContain("After");
		expect(frames.size).toBe(1);
	});
});

describe("PixelOfficeCanvas loop", () => {
	it("caps the frame rate", () => {
		seat([agent({})]);
		const { calls } = mount();
		const clears = (drawn: CanvasCall[]) => drawn.filter((c) => c.name === "clearRect").length;
		expect(clears(drawFrame(calls, 1000))).toBe(1);
		expect(clears(drawFrame(calls, 1010))).toBe(0);
		expect(clears(drawFrame(calls, 1040))).toBe(1);
	});

	it("draws nothing while the view is hidden, and resumes when it shows", () => {
		seat([agent({})]);
		const { calls } = mount();
		const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
		expect(drawFrame(calls, 1000)).toEqual([]);
		hidden.mockReturnValue(false);
		expect(drawFrame(calls, 2000).some((c) => c.name === "clearRect")).toBe(true);
	});

	it("stops animating when it unmounts", () => {
		seat([agent({})]);
		const { unmount } = mount();
		expect(frames.size).toBe(1);
		unmount();
		expect(frames.size).toBe(0);
	});

	it("schedules nothing and does not throw without a 2D context", () => {
		removeCanvasContext();
		seat([agent({})]);
		const { canvas } = mount();
		expect(frames.size).toBe(0);
		expect(canvas.width).toBe(WIDTH);
	});
});

describe("PixelOfficeCanvas sizing", () => {
	it("sizes the backing store for the screen's pixel ratio and draws in CSS pixels", () => {
		vi.stubGlobal("devicePixelRatio", 2);
		const { canvas, calls } = mount();
		expect([canvas.width, canvas.height]).toEqual([WIDTH * 2, HEIGHT * 2]);
		expect([canvas.style.width, canvas.style.height]).toEqual(["800px", "500px"]);
		expect(calls().find((c) => c.name === "setTransform")?.args).toEqual([2, 0, 0, 2, 0, 0]);
	});

	it("falls back to one device pixel per CSS pixel, and never to an empty canvas", () => {
		vi.stubGlobal("devicePixelRatio", 0);
		const view = render(<PixelOfficeCanvas width={0} height={HEIGHT} emptyDeskLabel="free" />);
		const canvas = view.container.querySelector("canvas") as HTMLCanvasElement;
		expect([canvas.width, canvas.height]).toEqual([1, HEIGHT]);
	});
});

describe("PixelOfficeCanvas clicks", () => {
	const layout = computeOfficeLayout(2, WIDTH, ZOOM);
	const viewport = computeViewport(layout, ZOOM, WIDTH, HEIGHT);

	/** Screen point at the middle of a desk, a few pixels below its top. */
	function deskPoint(seatIndex: number) {
		const pos = seatPosition(layout, seatIndex);
		const officeX = pos.x * TILE_SIZE * ZOOM + (DESK_W * ZOOM) / 2;
		const officeY = pos.y * TILE_SIZE * ZOOM + 5;
		return {
			clientX: 10 + officeX * viewport.scale + viewport.offsetX,
			clientY: 20 + officeY * viewport.scale + viewport.offsetY,
		};
	}

	function mountAt(onAgentClick?: (id: string, x: number, y: number) => void) {
		seat([agent({ id: "first" }), agent({ id: "second", seatIndex: 1 })]);
		const view = mount(onAgentClick);
		vi.spyOn(view.canvas, "getBoundingClientRect").mockReturnValue({
			left: 10,
			top: 20,
			width: WIDTH,
			height: HEIGHT,
		} as DOMRect);
		return view;
	}

	it("reports the agent under the click, anchored at its head", () => {
		const onAgentClick = vi.fn();
		const { canvas } = mountAt(onAgentClick);
		const point = deskPoint(1);
		fireEvent.click(canvas, point);
		const pos = seatPosition(layout, 1);
		const headY = (pos.y * TILE_SIZE * ZOOM + CHAR_OFFSET_Y * TILE_SIZE * ZOOM) * viewport.scale;
		expect(onAgentClick).toHaveBeenCalledWith("second", point.clientX - 10, headY + viewport.offsetY);
	});

	it("reports no agent for a click on the floor or a free desk", () => {
		const onAgentClick = vi.fn();
		const { canvas } = mountAt(onAgentClick);
		fireEvent.click(canvas, { clientX: 12, clientY: 22 });
		fireEvent.click(canvas, deskPoint(3));
		expect(onAgentClick.mock.calls).toEqual([
			["", 0, 0],
			["", 0, 0],
		]);
	});

	it("ignores clicks when nobody listens", () => {
		const { canvas } = mountAt();
		expect(() => {
			fireEvent.click(canvas, deskPoint(0));
			fireEvent.click(canvas, { clientX: 12, clientY: 22 });
		}).not.toThrow();
	});
});
