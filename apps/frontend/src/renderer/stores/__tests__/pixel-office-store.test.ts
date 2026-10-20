import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	allocateSeats,
	NO_SEAT,
	onOfficeSignal,
	type PixelAgent,
	usePixelOfficeStore,
} from "../pixel-office-store";
import type { Terminal, TerminalStatus } from "../terminal-store";

function agent(overrides: Partial<PixelAgent> & { id: string }): PixelAgent {
	return {
		type: "terminal",
		name: overrides.id,
		fullName: overrides.id,
		characterIndex: 0,
		activity: "idle",
		seatIndex: NO_SEAT,
		isClaudeMode: false,
		...overrides,
	};
}

function terminal(
	id: string,
	status: TerminalStatus = "idle",
	extra: Partial<Terminal> = {},
): Terminal {
	return {
		id,
		title: id,
		status,
		cwd: "/repo",
		createdAt: new Date(0),
		isClaudeMode: false,
		...extra,
	};
}

describe("allocateSeats", () => {
	it("seats everyone in 0..n-1", () => {
		const agents = [agent({ id: "a" }), agent({ id: "b" }), agent({ id: "c" })];
		allocateSeats(agents);
		expect(agents.map((a) => a.seatIndex).sort()).toEqual([0, 1, 2]);
	});

	it("leaves an agent where it already sits", () => {
		const agents = [
			agent({ id: "a", seatIndex: 1 }),
			agent({ id: "b", seatIndex: 0 }),
		];
		allocateSeats(agents);
		expect(agents[0].seatIndex).toBe(1);
		expect(agents[1].seatIndex).toBe(0);
	});

	/**
	 * The old allocation only ever incremented a counter, so closing the first of
	 * three terminals left the survivors on seats 1 and 2 while the canvas drew
	 * two desks — and the agent on seat 2 was rendered nowhere and could not be
	 * clicked.
	 */
	it("pulls a seat back in range when the office shrinks", () => {
		const agents = [agent({ id: "b", seatIndex: 1 }), agent({ id: "c", seatIndex: 2 })];
		allocateSeats(agents);
		expect(agents.map((a) => a.seatIndex).sort()).toEqual([0, 1]);
	});

	it("never seats two agents at one desk", () => {
		const agents = [
			agent({ id: "a", seatIndex: 0 }),
			agent({ id: "b", seatIndex: 0 }),
			agent({ id: "c", seatIndex: 0 }),
		];
		allocateSeats(agents);
		expect(new Set(agents.map((a) => a.seatIndex)).size).toBe(3);
	});

	it("queues pending agents instead of seating them", () => {
		const agents = [
			agent({ id: "a" }),
			agent({ id: "q1", activity: "pending", seatIndex: 3 }),
			agent({ id: "q2", activity: "pending" }),
		];
		allocateSeats(agents);
		expect(agents[0].seatIndex).toBe(0);
		expect(agents[1].seatIndex).toBe(NO_SEAT);
		expect(agents[1].waitingIndex).toBe(0);
		expect(agents[2].waitingIndex).toBe(1);
	});

	it("seats an agent that stops being pending", () => {
		const agents = [agent({ id: "a", waitingIndex: 2, seatIndex: NO_SEAT })];
		allocateSeats(agents);
		expect(agents[0].seatIndex).toBe(0);
		expect(agents[0].waitingIndex).toBeUndefined();
	});
});

describe("usePixelOfficeStore.syncAll", () => {
	beforeEach(() => {
		usePixelOfficeStore.setState({
			agents: [],
			selectedAgentId: null,
			nextCharacterIndex: 0,
		});
	});

	it("drops exited terminals and recompacts the seats", () => {
		usePixelOfficeStore
			.getState()
			.syncAll([terminal("a"), terminal("b"), terminal("c")], []);
		expect(
			usePixelOfficeStore
				.getState()
				.agents.map((a) => a.seatIndex)
				.sort(),
		).toEqual([0, 1, 2]);

		usePixelOfficeStore.getState().syncAll([terminal("c")], []);
		const agents = usePixelOfficeStore.getState().agents;
		expect(agents).toHaveLength(1);
		expect(agents[0].seatIndex).toBeLessThan(1);
	});

	it("gives each terminal a distinct character", () => {
		usePixelOfficeStore
			.getState()
			.syncAll([terminal("a"), terminal("b"), terminal("c")], []);
		const indices = usePixelOfficeStore
			.getState()
			.agents.map((a) => a.characterIndex);
		expect(new Set(indices).size).toBe(3);
	});
});

describe("office signals", () => {
	beforeEach(() => {
		usePixelOfficeStore.setState({
			agents: [],
			selectedAgentId: null,
			nextCharacterIndex: 0,
		});
	});

	it("says nothing about agents it is seeing for the first time", () => {
		const heard = vi.fn();
		const off = onOfficeSignal(heard);
		usePixelOfficeStore
			.getState()
			.syncAll(
				[terminal("a", "claude-active", { isClaudeMode: true })],
				[],
			);
		off();
		expect(heard).not.toHaveBeenCalled();
	});

	it("reports an agent that starts waiting on you", () => {
		const store = usePixelOfficeStore.getState();
		store.syncAll([terminal("a", "running")], []);

		const heard = vi.fn();
		const off = onOfficeSignal(heard);
		store.syncAll(
			[terminal("a", "claude-active", { isClaudeMode: true })],
			[],
		);
		off();

		expect(heard).toHaveBeenCalledWith(
			"needs-input",
			expect.objectContaining({ id: "a" }),
		);
	});

	it("reports a turn that finished", () => {
		const store = usePixelOfficeStore.getState();
		store.syncAll([terminal("a", "running")], []);

		const heard = vi.fn();
		const off = onOfficeSignal(heard);
		store.syncAll([terminal("a", "idle")], []);
		off();

		expect(heard).toHaveBeenCalledWith(
			"turn-done",
			expect.objectContaining({ id: "a" }),
		);
	});

	it("stays quiet when nothing changed", () => {
		const store = usePixelOfficeStore.getState();
		store.syncAll([terminal("a", "running")], []);

		const heard = vi.fn();
		const off = onOfficeSignal(heard);
		store.syncAll([terminal("a", "running")], []);
		off();

		expect(heard).not.toHaveBeenCalled();
	});
});
