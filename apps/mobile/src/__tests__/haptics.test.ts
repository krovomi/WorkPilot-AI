import * as Haptics from "expo-haptics";
import { done, failed, press, tick } from "../ui/haptics";

afterEach(() => jest.restoreAllMocks());

describe("haptics", () => {
	it("touches lightly for each moment, and never fails without a motor", async () => {
		const selection = jest.spyOn(Haptics, "selectionAsync").mockRejectedValue(new Error("web"));
		const impact = jest.spyOn(Haptics, "impactAsync").mockResolvedValue();
		const notification = jest.spyOn(Haptics, "notificationAsync").mockResolvedValue();
		tick();
		press();
		done();
		failed();
		await Promise.resolve();
		expect(selection).toHaveBeenCalled();
		expect(impact).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
		expect(notification).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
		expect(notification).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Error);
	});
});
