/**
 * @vitest-environment jsdom
 *
 * The menu's right edge, driven like a person would: dragging it, folding
 * and unfolding by dragging, Escape, double-click, the keyboard. A small
 * harness stands in for the settings store.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SIDEBAR_DEFAULT_WIDTH,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
	SIDEBAR_RAIL_WIDTH,
} from "../sidebar-width";
import { SidebarResizeHandle } from "../SidebarResizeHandle";
import { type SidebarLayoutPatch, useSidebarResize } from "../use-sidebar-resize";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: { width?: number }) =>
			opts?.width === undefined ? key : `${key}:${opts.width}`,
	}),
}));

interface HarnessProps {
	readonly initialWidth?: number;
	readonly initialCollapsed?: boolean;
	readonly onCommit: (patch: SidebarLayoutPatch) => void;
	/** Saves are held until the test settles them (an IPC round trip). */
	readonly deferred?: { resolve: (() => void)[] };
}

function Harness({ initialWidth, initialCollapsed = false, onCommit, deferred }: HarnessProps) {
	const [stored, setStored] = useState<number | undefined>(initialWidth);
	const [collapsed, setCollapsed] = useState(initialCollapsed);
	const resize = useSidebarResize({
		storedWidth: stored,
		isCollapsed: collapsed,
		onCommit: (patch) => {
			onCommit(patch);
			const apply = () => {
				if (patch.sidebarWidth !== undefined) setStored(patch.sidebarWidth);
				if (patch.sidebarCollapsed !== undefined) setCollapsed(patch.sidebarCollapsed);
			};
			if (!deferred) {
				apply();
				return Promise.resolve(true);
			}
			return new Promise<void>((resolve) =>
				deferred.resolve.push(() => {
					apply();
					resolve();
				}),
			);
		},
	});
	return (
		<div data-testid="menu" data-width={resize.width} data-folded={resize.folded}>
			{!resize.folded && <div id="panel" data-testid="panel" />}
			<SidebarResizeHandle
				controls="panel"
				width={resize.width}
				maxWidth={resize.maxWidth}
				folded={resize.folded}
				isResizing={resize.isResizing}
				isDragging={resize.isDragging}
				{...resize.handlers}
			/>
			<button type="button" onClick={() => setStored(360)}>
				elsewhere
			</button>
		</div>
	);
}

const handle = () => screen.getByRole("separator");
const menuWidth = () => Number(screen.getByTestId("menu").dataset.width);
const isFolded = () => screen.getByTestId("menu").dataset.folded === "true";

function drag(fromX: number, toX: number, release = true) {
	fireEvent.pointerDown(handle(), { button: 0, clientX: fromX, pointerId: 1 });
	fireEvent.pointerMove(window, { clientX: toX, pointerId: 1 });
	if (release) fireEvent.pointerUp(window, { clientX: toX, pointerId: 1 });
}

let innerWidth: number;
beforeEach(() => {
	innerWidth = window.innerWidth;
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 1920 });
});
afterEach(() => {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: innerWidth });
	document.body.style.cursor = "";
	document.body.style.userSelect = "";
});

describe("the handle", () => {
	it("is a focusable vertical separator that says how wide the menu is", () => {
		render(<Harness onCommit={vi.fn()} />);
		const edge = handle();
		expect(edge).toHaveAttribute("aria-orientation", "vertical");
		expect(edge).toHaveAttribute("aria-controls", "panel");
		expect(edge).toHaveAttribute("aria-label", "resize.label");
		expect(edge).toHaveAttribute("title", "resize.hint");
		expect(edge).toHaveAttribute("tabindex", "0");
		expect(edge).toHaveAttribute("aria-valuemin", String(SIDEBAR_RAIL_WIDTH));
		expect(edge).toHaveAttribute("aria-valuemax", String(SIDEBAR_MAX_WIDTH));
		expect(edge).toHaveAttribute("aria-valuenow", String(SIDEBAR_DEFAULT_WIDTH));
		expect(edge).toHaveAttribute("aria-valuetext", `resize.width:${SIDEBAR_DEFAULT_WIDTH}`);
	});

	it("says the menu is folded when it is", () => {
		render(<Harness initialCollapsed onCommit={vi.fn()} />);
		expect(handle()).toHaveAttribute("aria-valuetext", "resize.folded");
		expect(menuWidth()).toBe(SIDEBAR_RAIL_WIDTH);
	});

	it("follows a width saved elsewhere, and a smaller window", () => {
		render(<Harness initialWidth={300} onCommit={vi.fn()} />);
		expect(menuWidth()).toBe(300);
		fireEvent.click(screen.getByText("elsewhere"));
		expect(menuWidth()).toBe(360);
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 860 });
		act(() => {
			window.dispatchEvent(new Event("resize"));
		});
		expect(menuWidth()).toBe(300);
		expect(handle()).toHaveAttribute("aria-valuemax", "300");
	});
});

describe("dragging", () => {
	it("previews the width while dragging and saves it once, on release", () => {
		const onCommit = vi.fn();
		render(<Harness onCommit={onCommit} />);
		drag(296, 380, false);
		expect(menuWidth()).toBe(380);
		expect(handle()).toHaveAttribute("data-resizing", "true");
		expect(document.body.style.cursor).toBe("col-resize");
		expect(document.body.style.userSelect).toBe("none");
		expect(onCommit).not.toHaveBeenCalled();
		fireEvent.pointerUp(window, { clientX: 380, pointerId: 1 });
		expect(onCommit).toHaveBeenCalledExactlyOnceWith({ sidebarWidth: 380 });
		expect(menuWidth()).toBe(380);
		expect(document.body.style.cursor).toBe("");
		expect(handle()).toHaveAttribute("data-resizing", "false");
	});

	it("keeps the width between its bounds", () => {
		const onCommit = vi.fn();
		render(<Harness onCommit={onCommit} />);
		drag(296, 2000);
		expect(menuWidth()).toBe(SIDEBAR_MAX_WIDTH);
		drag(480, 200);
		expect(menuWidth()).toBe(SIDEBAR_MIN_WIDTH);
		expect(onCommit.mock.calls).toEqual([
			[{ sidebarWidth: SIDEBAR_MAX_WIDTH }],
			[{ sidebarWidth: SIDEBAR_MIN_WIDTH }],
		]);
	});

	it("covers the window while the pointer moves, so web views never catch it", () => {
		const { container } = render(<Harness onCommit={vi.fn()} />);
		fireEvent.pointerDown(handle(), { button: 0, clientX: 296, pointerId: 1 });
		expect(container.querySelector(".fixed.inset-0")).toBeNull();
		fireEvent.pointerMove(window, { clientX: 300, pointerId: 1 });
		expect(container.querySelector(".fixed.inset-0")).not.toBeNull();
		fireEvent.pointerUp(window, { pointerId: 1 });
		expect(container.querySelector(".fixed.inset-0")).toBeNull();
	});

	it("captures the pointer when the platform can", () => {
		const capture = vi.fn();
		render(<Harness onCommit={vi.fn()} />);
		(handle() as HTMLElement & { setPointerCapture: unknown }).setPointerCapture = capture;
		drag(296, 300);
		expect(capture).toHaveBeenCalledWith(1);
	});

	it("saves nothing for a press without a move, nor for another button", () => {
		const onCommit = vi.fn();
		render(<Harness onCommit={onCommit} />);
		fireEvent.pointerDown(handle(), { button: 0, clientX: 296, pointerId: 1 });
		fireEvent.pointerUp(window, { pointerId: 1 });
		fireEvent.pointerDown(handle(), { button: 2, clientX: 296, pointerId: 1 });
		fireEvent.pointerMove(window, { clientX: 400, pointerId: 1 });
		fireEvent.pointerUp(window, { pointerId: 1 });
		expect(onCommit).not.toHaveBeenCalled();
		expect(menuWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
	});

	it("saves nothing when released where it started", () => {
		const onCommit = vi.fn();
		render(<Harness initialWidth={300} onCommit={onCommit} />);
		drag(300, 330, false);
		fireEvent.pointerMove(window, { clientX: 300, pointerId: 1 });
		fireEvent.pointerUp(window, { pointerId: 1 });
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("cancels with Escape, back to the width it had", () => {
		const onCommit = vi.fn();
		render(<Harness onCommit={onCommit} />);
		drag(296, 420, false);
		fireEvent.keyDown(window, { key: "Shift" });
		expect(menuWidth()).toBe(420);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(menuWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
		fireEvent.pointerUp(window, { pointerId: 1 });
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("ends a cancelled pointer like a release", () => {
		const onCommit = vi.fn();
		render(<Harness onCommit={onCommit} />);
		drag(296, 320, false);
		fireEvent.pointerCancel(window, { pointerId: 1 });
		expect(onCommit).toHaveBeenCalledWith({ sidebarWidth: 320 });
	});

	it("leaves no listener behind when the menu goes away mid-drag", () => {
		const onCommit = vi.fn();
		const { unmount } = render(<Harness onCommit={onCommit} />);
		drag(296, 320, false);
		unmount();
		expect(document.body.style.cursor).toBe("");
		fireEvent.pointerUp(window, { pointerId: 1 });
		expect(onCommit).not.toHaveBeenCalled();
	});
});

describe("folding by dragging", () => {
	it("folds the panel when dragged well under the minimum, keeping the saved width", () => {
		const onCommit = vi.fn();
		render(<Harness initialWidth={320} onCommit={onCommit} />);
		drag(320, 60, false);
		expect(isFolded()).toBe(true);
		expect(screen.queryByTestId("panel")).toBeNull();
		fireEvent.pointerUp(window, { pointerId: 1 });
		expect(onCommit).toHaveBeenCalledExactlyOnceWith({ sidebarCollapsed: true });
		expect(menuWidth()).toBe(SIDEBAR_RAIL_WIDTH);
	});

	it("unfolds a folded menu dragged to the right, at the width it was dragged to", () => {
		const onCommit = vi.fn();
		render(<Harness initialWidth={320} initialCollapsed onCommit={onCommit} />);
		drag(SIDEBAR_RAIL_WIDTH, 400);
		expect(onCommit).toHaveBeenCalledExactlyOnceWith({
			sidebarWidth: 400,
			sidebarCollapsed: false,
		});
		expect(isFolded()).toBe(false);
		expect(menuWidth()).toBe(400);
	});

	it("only unfolds when the width dragged to is the saved one", () => {
		const onCommit = vi.fn();
		render(<Harness initialWidth={320} initialCollapsed onCommit={onCommit} />);
		drag(SIDEBAR_RAIL_WIDTH, 320);
		expect(onCommit).toHaveBeenCalledExactlyOnceWith({ sidebarCollapsed: false });
	});

	it("saves nothing when a folded menu is dragged but stays folded", () => {
		const onCommit = vi.fn();
		render(<Harness initialCollapsed onCommit={onCommit} />);
		drag(SIDEBAR_RAIL_WIDTH, 100);
		expect(onCommit).not.toHaveBeenCalled();
		expect(isFolded()).toBe(true);
	});

	it("shows the fold asked for until the save settles", () => {
		const deferred = { resolve: [] as (() => void)[] };
		render(<Harness initialWidth={320} onCommit={vi.fn()} deferred={deferred} />);
		drag(320, 40);
		expect(isFolded()).toBe(true);
		act(() => deferred.resolve.forEach((settle) => settle()));
		expect(isFolded()).toBe(true);
	});
});

describe("double-click", () => {
	it("brings the menu back to its default width", () => {
		const onCommit = vi.fn();
		render(<Harness initialWidth={450} onCommit={onCommit} />);
		fireEvent.doubleClick(handle());
		expect(onCommit).toHaveBeenCalledWith({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH });
		expect(menuWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
	});

	it("unfolds a folded menu at the default width", () => {
		const onCommit = vi.fn();
		render(<Harness initialWidth={450} initialCollapsed onCommit={onCommit} />);
		fireEvent.doubleClick(handle());
		expect(onCommit).toHaveBeenCalledWith({
			sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
			sidebarCollapsed: false,
		});
		expect(isFolded()).toBe(false);
	});
});

describe("keyboard", () => {
	it("resizes with the arrows and saves once the key is released", () => {
		const onCommit = vi.fn();
		render(<Harness onCommit={onCommit} />);
		fireEvent.keyDown(handle(), { key: "ArrowRight" });
		fireEvent.keyDown(handle(), { key: "ArrowRight" });
		expect(menuWidth()).toBe(SIDEBAR_DEFAULT_WIDTH + 32);
		expect(onCommit).not.toHaveBeenCalled();
		fireEvent.keyUp(handle(), { key: "ArrowRight" });
		expect(onCommit).toHaveBeenCalledExactlyOnceWith({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH + 32 });
		fireEvent.keyUp(handle(), { key: "ArrowRight" });
		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it("saves nothing when the keys bring it back where it was", () => {
		const onCommit = vi.fn();
		render(<Harness onCommit={onCommit} />);
		fireEvent.keyDown(handle(), { key: "ArrowRight" });
		fireEvent.keyDown(handle(), { key: "ArrowLeft" });
		fireEvent.keyUp(handle(), { key: "ArrowLeft" });
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("goes to the bounds with Home and End", () => {
		render(<Harness onCommit={vi.fn()} />);
		fireEvent.keyDown(handle(), { key: "End" });
		expect(menuWidth()).toBe(SIDEBAR_MAX_WIDTH);
		fireEvent.keyDown(handle(), { key: "Home" });
		expect(menuWidth()).toBe(SIDEBAR_MIN_WIDTH);
	});

	it("folds and unfolds with Enter, unfolds with the right arrow", () => {
		const onCommit = vi.fn();
		render(<Harness onCommit={onCommit} />);
		fireEvent.keyDown(handle(), { key: "Enter" });
		expect(isFolded()).toBe(true);
		fireEvent.keyDown(handle(), { key: "Enter" });
		expect(isFolded()).toBe(false);
		fireEvent.keyDown(handle(), { key: "Enter" });
		fireEvent.keyDown(handle(), { key: "ArrowRight" });
		expect(isFolded()).toBe(false);
		expect(onCommit.mock.calls).toEqual([
			[{ sidebarCollapsed: true }],
			[{ sidebarCollapsed: false }],
			[{ sidebarCollapsed: true }],
			[{ sidebarCollapsed: false }],
		]);
	});

	it("ignores other keys", () => {
		const onCommit = vi.fn();
		render(<Harness onCommit={onCommit} />);
		fireEvent.keyDown(handle(), { key: "a" });
		fireEvent.keyUp(handle(), { key: "a" });
		expect(onCommit).not.toHaveBeenCalled();
		expect(menuWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
	});
});
