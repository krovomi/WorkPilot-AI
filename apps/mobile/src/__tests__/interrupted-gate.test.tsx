import { render, screen, waitFor } from "@testing-library/react-native";
import { InterruptedRunsGate } from "../interrupted/InterruptedRunsGate";
import { selectedByDefault, stepOf } from "../interrupted/types";

const session = { api: null as unknown, permissions: null as unknown };
jest.mock("../auth/session", () => ({ useSession: () => session }));

describe("InterruptedRunsGate", () => {
	it("asks nothing before a session or an organization", async () => {
		const interruptedRuns = jest.fn();
		await render(<InterruptedRunsGate />);
		session.api = { interruptedRuns };
		await render(<InterruptedRunsGate />);
		expect(interruptedRuns).not.toHaveBeenCalled();
		expect(screen.queryByText("Later")).toBeNull();
	});

	it("drops a list that arrives once the gate is gone", async () => {
		let answer: (value: unknown) => void = () => undefined;
		const interruptedRuns = jest.fn(() => new Promise((resolve) => (answer = resolve)));
		session.api = { interruptedRuns };
		session.permissions = { org_id: "org-a" };
		const { unmount } = await render(<InterruptedRunsGate />);
		await waitFor(() => expect(interruptedRuns).toHaveBeenCalled());
		await unmount();
		answer([{ run_id: "r1" }]);
		await Promise.resolve();
	});

	it("ignores a server that cannot answer", async () => {
		const interruptedRuns = jest.fn(async () => {
			throw new Error("network");
		});
		session.api = { interruptedRuns };
		session.permissions = { org_id: "org-a" };
		await render(<InterruptedRunsGate />);
		await waitFor(() => expect(interruptedRuns).toHaveBeenCalled());
		expect(screen.queryByText("Later")).toBeNull();
	});
});

describe("an interrupted run", () => {
	const base = { mine: true, blocker: null, phase: "qa_review" } as const;
	it("is ticked only when it is one's own and nothing is in the way", () => {
		expect(selectedByDefault(base as never)).toBe(true);
		expect(selectedByDefault({ ...base, mine: false } as never)).toBe(false);
		expect(selectedByDefault({ ...base, blocker: "spec_missing" } as never)).toBe(false);
	});

	it("reads its QA phase as the QA step", () => {
		expect(stepOf(base as never)).toBe("qa");
		expect(stepOf({ ...base, phase: "spec" } as never)).toBe("spec");
	});
});
