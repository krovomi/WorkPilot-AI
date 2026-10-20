/**
 * @vitest-environment jsdom
 */
/**
 * Tests TaskArchitectureDelta and the predicate that decides its tab exists.
 *
 * The behaviour worth pinning down is the refusals. Two states must render
 * nothing rather than "no change" — a tab that says nothing on most tasks is a
 * tab people stop opening — and `unreliable-ids` must say why instead of
 * showing a comparison built on renamed identifiers, which would be fiction.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";

import type { ArchitectureDeltaStatus } from "../../../main/architecture-visualizer-service";
import type { Task } from "../../../shared/types";
import {
	type ArchitectureDeltaEntry,
	shouldShowArchitectureDelta,
	useArchitectureDeltaStore,
} from "../../stores/architecture-delta-store";
import { TaskArchitectureDelta } from "./TaskArchitectureDelta";

const task = { id: "task-1", specsPath: "/p/.workpilot/specs/001" } as Task;

function status(
	overrides: Partial<ArchitectureDeltaStatus>,
): ArchitectureDeltaStatus {
	return {
		status: "mapped",
		reason: "",
		baselineRevision: null,
		headRevision: null,
		summary: {},
		continuity: {},
		artifact: null,
		receipt: null,
		generatedAt: "",
		hasChanges: false,
		...overrides,
	};
}

function entry(overrides: Partial<ArchitectureDeltaEntry>): ArchitectureDeltaEntry {
	return {
		status: null,
		loading: false,
		running: false,
		error: null,
		artifactUrl: null,
		progress: "",
		...overrides,
	};
}

beforeEach(() => {
	useArchitectureDeltaStore.setState({ byTask: {} });
	vi.stubGlobal("window", { ...window, electronAPI: {} });
});

describe("shouldShowArchitectureDelta", () => {
	it("hides the tab when the change was not architectural", () => {
		expect(
			shouldShowArchitectureDelta(
				entry({ status: status({ status: "not-significant" }) }),
			),
		).toBe(false);
	});

	it("hides the tab when the comparison found nothing", () => {
		// A true answer to a question nobody needs answered.
		expect(
			shouldShowArchitectureDelta(
				entry({ status: status({ status: "mapped", hasChanges: false }) }),
			),
		).toBe(false);
	});

	it("shows the tab when there is a real delta", () => {
		expect(
			shouldShowArchitectureDelta(
				entry({ status: status({ status: "mapped", hasChanges: true }) }),
			),
		).toBe(true);
	});

	it("shows the tab while a regeneration is running", () => {
		expect(shouldShowArchitectureDelta(entry({ running: true }))).toBe(true);
	});

	it("shows the tab for every state that has something to explain", () => {
		for (const state of [
			"no-baseline",
			"unreliable-ids",
			"runtime-missing",
			"failed",
		] as const) {
			expect(
				shouldShowArchitectureDelta(entry({ status: status({ status: state }) })),
			).toBe(true);
		}
	});

	it("hides the tab before anything has loaded", () => {
		expect(shouldShowArchitectureDelta(undefined)).toBe(false);
		expect(shouldShowArchitectureDelta(entry({ loading: true }))).toBe(false);
	});
});

describe("TaskArchitectureDelta", () => {
	it("renders the counts a reader takes in at a glance", () => {
		const { container } = render(
			<TaskArchitectureDelta
				task={task}
				projectPath="/p"
				entry={entry({
					status: status({
						hasChanges: true,
						summary: {
							components: { added: 2, removed: 1, changed: 0 },
							connections: { added: 3, removed: 0, changed: 0 },
						},
					}),
				})}
			/>,
		);
		expect(container.textContent).toMatch(/2 components added/);
		expect(container.textContent).toMatch(/1 component removed/);
		expect(container.textContent).toMatch(/3 connections added/);
		// Zero-valued counters are not badges.
		expect(container.textContent).not.toMatch(/0 /);
	});

	it("names the baseline revision it compared against", () => {
		const { container } = render(
			<TaskArchitectureDelta
				task={task}
				projectPath="/p"
				entry={entry({
					status: status({
						hasChanges: true,
						baselineRevision: "0123456789abcdef0123456789abcdef01234567",
						summary: { components: { added: 1 } },
					}),
				})}
			/>,
		);
		expect(container.textContent).toMatch(/0123456789ab/);
	});

	it("explains an unreliable comparison instead of showing it", () => {
		const { container } = render(
			<TaskArchitectureDelta
				task={task}
				projectPath="/p"
				entry={entry({
					artifactUrl: "file:///should-not-be-used.html",
					status: status({
						status: "unreliable-ids",
						continuity: { kept: 1, total: 8, lost: ["cache", "queue"] },
					}),
				})}
			/>,
		);
		expect(container.textContent).toMatch(/would not be trustworthy/i);
		expect(container.textContent).toMatch(/1 of 8/);
		expect(container.querySelector("webview")).toBeNull();
	});

	it("points at the Architecture page when there is no baseline", () => {
		render(
			<TaskArchitectureDelta
				task={task}
				projectPath="/p"
				entry={entry({ status: status({ status: "no-baseline" }) })}
			/>,
		);
		expect(screen.getByText(/no architecture map yet/i)).toBeInTheDocument();
	});

	it("reports a missing runtime with the doctor's own remedy", () => {
		render(
			<TaskArchitectureDelta
				task={task}
				projectPath="/p"
				entry={entry({
					status: status({
						status: "runtime-missing",
						reason: "install Node.js 18+ and reopen the app",
					}),
				})}
			/>,
		);
		expect(screen.getByText(/install Node\.js 18\+/)).toBeInTheDocument();
	});

	it("renders nothing at all when the delta is empty", () => {
		const { container } = render(
			<TaskArchitectureDelta
				task={task}
				projectPath="/p"
				entry={entry({ status: status({ hasChanges: false }) })}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing without a spec directory", () => {
		const { container } = render(
			<TaskArchitectureDelta
				task={{ id: "t" } as Task}
				projectPath="/p"
				entry={entry({ status: status({ hasChanges: true }) })}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
