/** @vitest-environment jsdom */
/**
 * The « Outils CLI » panel lists installed CLIs first, then missing ones, each
 * group alphabetical, and moves a badge without remounting it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import type { CliPresence } from "./cli-tool-order";

const presence: Record<string, CliPresence | null> = {};
const reporters: Record<string, (p: CliPresence) => void> = {};
const mounts: Record<string, number> = {};

function Stub({ id, onPresenceChange }: { id: string; onPresenceChange?: (p: CliPresence) => void }) {
	useEffect(() => {
		mounts[id] = (mounts[id] ?? 0) + 1;
	}, [id]);
	useEffect(() => {
		if (onPresenceChange) reporters[id] = onPresenceChange;
		const p = presence[id];
		if (p) onPresenceChange?.(p);
	}, [id, onPresenceChange]);
	return <div data-testid="cli-badge">{id}</div>;
}

vi.mock("./ClaudeCodeStatusBadge", () => ({
	ClaudeCodeStatusBadge: (p: { onPresenceChange?: (x: CliPresence) => void }) => (
		<Stub id="claude-code" {...p} />
	),
}));
vi.mock("./CopilotCliStatusBadge", () => ({
	CopilotCliStatusBadge: (p: { onPresenceChange?: (x: CliPresence) => void }) => (
		<Stub id="copilot" {...p} />
	),
}));
vi.mock("./CodexCliStatusBadge", () => ({
	CodexCliStatusBadge: (p: { onPresenceChange?: (x: CliPresence) => void }) => (
		<Stub id="codex" {...p} />
	),
}));
vi.mock("./HermesStatusBadge", () => ({
	HermesStatusBadge: (p: { onPresenceChange?: (x: CliPresence) => void }) => (
		<Stub id="hermes" {...p} />
	),
}));
vi.mock("./AgentCliStatusBadge", () => ({
	AgentCliStatusBadge: (p: { tool: string; onPresenceChange?: (x: CliPresence) => void }) => (
		<Stub id={p.tool} onPresenceChange={p.onPresenceChange} />
	),
}));

import { CliToolBadges } from "./CliToolBadges";

const shown = () => screen.getAllByTestId("cli-badge").map((el) => el.textContent);

afterEach(() => {
	cleanup();
	for (const record of [presence, reporters, mounts]) {
		for (const key of Object.keys(record)) delete record[key];
	}
});

describe("CliToolBadges", () => {
	it("lists installed CLIs alphabetically, then the missing ones", () => {
		Object.assign(presence, {
			"claude-code": "installed",
			copilot: "installed",
			codex: "installed",
			opencode: "installed",
			antigravity: "missing",
			pi: "missing",
			"gemini-cli": "missing",
			hermes: "installed",
		});
		render(<CliToolBadges isCollapsed={false} onNavigateToTerminals={vi.fn()} />);
		expect(shown()).toEqual([
			"claude-code",
			"codex",
			"copilot",
			"hermes",
			"opencode",
			"antigravity",
			"gemini-cli",
			"pi",
		]);
	});

	it("moves a CLI up once installed, without remounting it", () => {
		Object.assign(presence, { antigravity: "missing", codex: "installed" });
		render(<CliToolBadges isCollapsed={false} onNavigateToTerminals={vi.fn()} />);
		expect(shown().at(-1)).toBe("antigravity");

		act(() => reporters.antigravity("installed"));

		expect(shown()[0]).toBe("antigravity");
		expect(mounts.antigravity).toBe(1);
	});
});
