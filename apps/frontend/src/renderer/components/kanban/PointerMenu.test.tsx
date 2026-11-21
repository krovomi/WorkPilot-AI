/**
 * Right-click menus: where they open, and which events a card or a column
 * takes as its own (not the ones bubbling up from its portals).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	contextMenuPoint,
	isFromPortal,
	useContextMenuAt,
	withoutPortalEvents,
} from "./PointerMenu";

describe("contextMenuPoint", () => {
	const element = {
		getBoundingClientRect: () => ({ left: 100, top: 50 }) as DOMRect,
	} as Element;

	it("opens at the pointer", () => {
		expect(contextMenuPoint({ clientX: 3, clientY: 0 }, element)).toEqual({ x: 3, y: 0 });
		expect(contextMenuPoint({ clientX: 0, clientY: 7 }, element)).toEqual({ x: 0, y: 7 });
	});

	it("opens near the element's corner from the keyboard", () => {
		expect(contextMenuPoint({ clientX: 0, clientY: 0 }, element)).toEqual({
			x: 108,
			y: 74,
		});
		expect(contextMenuPoint({ clientX: 0, clientY: 0 }, null)).toEqual({ x: 0, y: 0 });
	});
});

function Fenced({ onClick }: { onClick: (fromPortal: boolean) => void }) {
	return (
		<button type="button" onClick={(e) => onClick(isFromPortal(e))}>
			<span>inside</span>
			{createPortal(<span>portal</span>, document.body)}
		</button>
	);
}

describe("isFromPortal", () => {
	it("tells an event from inside from one bubbling up from a portal", () => {
		const onClick = vi.fn();
		render(<Fenced onClick={onClick} />);
		fireEvent.click(screen.getByText("inside"));
		fireEvent.click(screen.getByText("portal"));
		expect(onClick.mock.calls).toEqual([[false], [true]]);
	});
});

describe("withoutPortalEvents", () => {
	it("passes the element's own events and drops the portal's", () => {
		const onPointerDown = vi.fn();
		const own = withoutPortalEvents({ onPointerDown });
		const inside = document.createElement("div");
		const child = document.createElement("span");
		inside.append(child);
		const outside = document.createElement("span");
		own.onPointerDown({ currentTarget: inside, target: child } as unknown as SyntheticEvent);
		own.onPointerDown({ currentTarget: inside, target: outside } as unknown as SyntheticEvent);
		expect(onPointerDown).toHaveBeenCalledTimes(1);
	});

	it("has nothing to pass without listeners", () => {
		expect(withoutPortalEvents(undefined)).toEqual({});
	});
});

function Area({ enabled }: { enabled: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	const { at, close } = useContextMenuAt(ref, enabled, ".skip");
	return (
		<div ref={ref} data-testid="area">
			<span className="skip">skipped</span>
			<span>plain</span>
			{at && (
				<button type="button" onClick={close}>
					{`${at.x},${at.y}`}
				</button>
			)}
		</div>
	);
}

describe("useContextMenuAt", () => {
	it("records the point of a right-click, not on an ignored target", () => {
		render(<Area enabled />);
		expect(fireEvent.contextMenu(screen.getByText("skipped"), { clientX: 1, clientY: 1 })).toBe(
			true,
		);
		expect(screen.queryByRole("button")).toBeNull();
		// Handled: the default menu is cancelled.
		expect(fireEvent.contextMenu(screen.getByText("plain"), { clientX: 5, clientY: 9 })).toBe(
			false,
		);
		fireEvent.click(screen.getByRole("button", { name: "5,9" }));
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("listens to nothing without an element", () => {
		function Detached() {
			const { at } = useContextMenuAt({ current: null }, true, ".skip");
			return <span>{at ? "open" : "closed"}</span>;
		}
		render(<Detached />);
		fireEvent.contextMenu(screen.getByText("closed"), { clientX: 5, clientY: 9 });
		expect(screen.getByText("closed")).toBeInTheDocument();
	});

	it("listens to nothing while disabled", () => {
		render(<Area enabled={false} />);
		fireEvent.contextMenu(screen.getByText("plain"), { clientX: 5, clientY: 9 });
		expect(screen.queryByRole("button")).toBeNull();
	});
});
