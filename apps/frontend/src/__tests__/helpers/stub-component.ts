/**
 * A stand-in for a child component in tests of a component that composes many
 * (App mounts some sixty pages and dialogs).
 *
 * The stub renders a `<div data-testid="stub-<Name>">` around its children and
 * keeps the props of its last render, so a test can check which child is on
 * screen and call the callbacks the parent handed it:
 *
 *     vi.mock("../components/Roadmap", () => stubModule("Roadmap"));
 *     …
 *     expect(screen.getByTestId("stub-Roadmap")).toBeInTheDocument();
 *     expect(stubProps("Roadmap").projectId).toBe("p1");
 *     callStub("Roadmap", "onGoToTask", "t1");
 *
 * `stubModule` is called from a hoisted `vi.mock` factory, after this module
 * has loaded: import it before the component under test.
 */

import { createElement, type ReactNode } from "react";

type StubProps = Record<string, unknown>;

const lastProps = new Map<string, StubProps>();

export function stubComponent(name: string) {
	function Stub(props: StubProps) {
		lastProps.set(name, props);
		return createElement(
			"div",
			{ "data-testid": `stub-${name}` },
			props.children as ReactNode,
		);
	}
	Stub.displayName = `Stub(${name})`;
	return Stub;
}

/**
 * A stand-in for a hook that takes callbacks (`useNeedsYou({ onNavigate })`):
 * it keeps its options under its name, for `stubProps` and `callStub`.
 */
export function stubHook(name: string) {
	return (options?: StubProps): void => {
		lastProps.set(name, options ?? {});
	};
}

/** A module whose named exports are stubs. */
export function stubModule(...names: string[]): Record<string, unknown> {
	return Object.fromEntries(names.map((name) => [name, stubComponent(name)]));
}

/** The props of the stub's last render; throws when it never rendered. */
export function stubProps(name: string): StubProps {
	const props = lastProps.get(name);
	if (!props) throw new Error(`${name} was never rendered`);
	return props;
}

/** Call a callback the parent passed to the stub, as the real child would. */
export function callStub(
	name: string,
	prop: string,
	...args: unknown[]
): unknown {
	const callback = stubProps(name)[prop];
	if (typeof callback !== "function") {
		throw new Error(`${name} got no ${prop} callback`);
	}
	return callback(...args);
}

export function resetStubs(): void {
	lastProps.clear();
}
