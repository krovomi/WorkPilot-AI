import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { Api } from "../api/endpoints";
import type { SteeringMessage } from "../api/types";
import "../i18n";
import { SteeringSection } from "../card/SteeringSection";

const delivered: SteeringMessage = {
	id: "a",
	text: "Keep the old route",
	createdAt: "2026-11-06T10:00:00+00:00",
	source: "mobile",
	targetSubtaskId: null,
	deliveredAt: "2026-11-06T10:05:00+00:00",
	deliveredSession: 3,
	deliveredSubtaskId: "subtask-1",
};

const mockApi = {
	steering: jest.fn(async () => [delivered]),
	steer: jest.fn(async () => [delivered, { ...delivered, id: "b", text: "And log it", deliveredAt: null }]),
} as unknown as Api & { steering: jest.Mock; steer: jest.Mock };
jest.mock("../auth/session", () => ({ useApi: () => mockApi }));

describe("SteeringSection", () => {
	beforeEach(() => {
		mockApi.steering.mockClear();
		mockApi.steer.mockClear();
	});

	it("shows which session received a message and sends a new one", async () => {
		await render(<SteeringSection projectId="p1" cardId="004-x" canSend working={false} />);
		expect(await screen.findByText("Keep the old route")).toBeTruthy();
		expect(screen.getByText(/Delivered to session 3/)).toBeTruthy();
		const send = screen.getByRole("button", { name: "Send" });
		expect(send).toBeDisabled();
		await fireEvent.changeText(screen.getByLabelText("Message for the next session"), "And log it");
		await fireEvent.press(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(mockApi.steer).toHaveBeenCalledWith("p1", "004-x", "And log it"));
		expect(await screen.findByText("Waiting for the next session")).toBeTruthy();
	});

	it("keeps the message and says why it was not sent", async () => {
		mockApi.steer.mockRejectedValueOnce(new Error("The card is not running"));
		await render(<SteeringSection projectId="p1" cardId="004-x" canSend working />);
		await fireEvent.changeText(await screen.findByLabelText("Message for the next session"), "Stop there");
		await fireEvent.press(screen.getByRole("button", { name: "Send" }));
		expect(await screen.findByText(/The card is not running/)).toBeTruthy();
		expect(screen.getByLabelText("Message for the next session").props.value).toBe("Stop there");
	});

	it("reads the messages again while the card works, and stops when the screen leaves", async () => {
		jest.useFakeTimers();
		try {
			const view = await render(<SteeringSection projectId="p1" cardId="004-x" canSend working />);
			expect(mockApi.steering).toHaveBeenCalledTimes(1);
			await act(async () => {
				jest.advanceTimersByTime(10_000);
			});
			expect(mockApi.steering).toHaveBeenCalledTimes(2);
			await view.unmount();
			await act(async () => {
				jest.advanceTimersByTime(30_000);
			});
			expect(mockApi.steering).toHaveBeenCalledTimes(2);
		} finally {
			jest.useRealTimers();
		}
	});

	it("offers no composer without agent.execute", async () => {
		await render(<SteeringSection projectId="p1" cardId="004-x" canSend={false} working={false} />);
		expect(await screen.findByText("Keep the old route")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
	});
});
