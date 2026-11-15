/**
 * The child stand-in keeps the props of its last render, renders its
 * children, and says plainly when a test reads a stub that never rendered.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	callStub,
	resetStubs,
	stubComponent,
	stubHook,
	stubModule,
	stubProps,
} from "./stub-component";

afterEach(() => resetStubs());

describe("stub components", () => {
	it("render their children and keep their last props", () => {
		const { Panel } = stubModule("Panel") as {
			Panel: ReturnType<typeof stubComponent>;
		};
		const onClose = vi.fn(() => "closed");
		const { rerender } = render(<Panel open={false} onClose={onClose} />);
		rerender(
			<Panel open onClose={onClose}>
				<span>inside</span>
			</Panel>,
		);
		expect(screen.getByTestId("stub-Panel")).toHaveTextContent("inside");
		expect(stubProps("Panel").open).toBe(true);
		expect(callStub("Panel", "onClose", "now")).toBe("closed");
		expect(onClose).toHaveBeenCalledWith("now");
		expect(Panel.displayName).toBe("Stub(Panel)");
	});

	it("a hook stand-in keeps the options it was called with", () => {
		const useThing = stubHook("useThing");
		useThing();
		expect(stubProps("useThing")).toEqual({});
		const onNavigate = vi.fn();
		useThing({ onNavigate });
		callStub("useThing", "onNavigate", "kanban");
		expect(onNavigate).toHaveBeenCalledWith("kanban");
	});

	it("refuse a stub that never rendered and a callback that was not given", () => {
		const Panel = stubComponent("Panel");
		expect(() => stubProps("Panel")).toThrow("Panel was never rendered");
		render(<Panel open />);
		expect(() => callStub("Panel", "open")).toThrow("Panel got no open callback");
		resetStubs();
		expect(() => stubProps("Panel")).toThrow("never rendered");
	});
});
