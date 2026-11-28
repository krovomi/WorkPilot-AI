import { render, screen, waitFor } from "@testing-library/react-native";
import { UsageNoticeGate } from "../usage/UsageNoticeGate";

const session = { api: null as unknown, permissions: null as unknown };
jest.mock("../auth/session", () => ({ useSession: () => session }));

const NOTICE = {
	due: true,
	measured: ["tokens"],
	page_activity: false,
	usage_retention_days: 365,
	page_activity_retention_days: 183,
	visible_to: ["Owner"],
};

describe("UsageNoticeGate", () => {
	it("asks nothing before a session or an organization", async () => {
		const usageNotice = jest.fn();
		await render(<UsageNoticeGate />);
		session.api = { usageNotice };
		await render(<UsageNoticeGate />);
		expect(usageNotice).not.toHaveBeenCalled();
		expect(screen.queryByText("What this server measures about you")).toBeNull();
	});

	it("drops a notice that arrives once the gate is gone", async () => {
		let answer: (value: unknown) => void = () => undefined;
		const usageNotice = jest.fn(() => new Promise((resolve) => (answer = resolve)));
		session.api = { usageNotice };
		session.permissions = { org_id: "org-a" };
		const { unmount } = await render(<UsageNoticeGate />);
		await waitFor(() => expect(usageNotice).toHaveBeenCalled());
		await unmount();
		answer(NOTICE);
		await Promise.resolve();
	});
});
