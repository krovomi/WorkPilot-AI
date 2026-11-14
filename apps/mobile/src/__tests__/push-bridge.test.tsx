import { render } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import "../i18n";
import { PushBridge } from "../push/PushBridge";

const mockPush = jest.fn();
const mockSession: { api: object | null; user: object | null } = { api: null, user: null };
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("../auth/session", () => ({ useSession: () => mockSession }));

const tap = {
	actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
	notification: { request: { identifier: "n1", content: { data: { type: "run_finished", projectId: "p1", cardId: "007-search" } } } },
};

beforeEach(() => {
	jest.clearAllMocks();
	(Notifications.useLastNotificationResponse as jest.Mock).mockReturnValue(tap);
});
afterEach(() => (Notifications.useLastNotificationResponse as jest.Mock).mockReturnValue(null));

describe("PushBridge", () => {
	it("waits for a session before registering or opening anything", async () => {
		Object.assign(mockSession, { api: null, user: null });
		await render(<PushBridge />);
		expect(Notifications.setNotificationCategoryAsync).not.toHaveBeenCalled();
		expect(mockPush).not.toHaveBeenCalled();
	});

	it("opens a tapped card once, however often the screen draws again", async () => {
		Object.assign(mockSession, { api: {}, user: { id: "u1" } });
		const view = await render(<PushBridge />);
		// A new session object for the same tap (a token refresh) runs the effect again.
		Object.assign(mockSession, { api: {} });
		await view.rerender(<PushBridge />);
		expect(mockPush).toHaveBeenCalledTimes(1);
		expect(mockPush).toHaveBeenCalledWith({
			pathname: "/projects/[projectId]/cards/[cardId]",
			params: { projectId: "p1", cardId: "007-search" },
		});
	});
});
