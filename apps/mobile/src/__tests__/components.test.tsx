import { render, screen } from "@testing-library/react-native";
import { Platform, StyleSheet, Text } from "react-native";
import { ApiError } from "../api/client";
import "../i18n";
import { Button, ErrorBanner, KeyboardAvoiding, rowOpacity } from "../ui/components";

describe("Button", () => {
	it("dims while pressed, and more when it cannot be pressed", async () => {
		const view = await render(<Button label="Go" onPress={jest.fn()} />);
		const opacity = () => StyleSheet.flatten(screen.getByRole("button").props.style).opacity;
		expect(opacity()).toBe(1);
		// React Native's own switch for the pressed look in tests.
		await view.rerender(<Button label="Go" onPress={jest.fn()} testOnly_pressed />);
		expect(opacity()).toBe(0.8);
		await view.rerender(<Button label="Go" onPress={jest.fn()} disabled />);
		expect(opacity()).toBe(0.5);
	});
});

describe("ErrorBanner", () => {
	it("says a failure in the person's words, and a message before it", async () => {
		const view = await render(<ErrorBanner error={new ApiError(403, "no")} />);
		expect(screen.getByText("You don't have the rights for this action.")).toBeTruthy();
		await view.rerender(<ErrorBanner message="Saving failed." error={new ApiError(403, "no")} />);
		expect(screen.getByText("Saving failed.")).toBeTruthy();
		expect(screen.queryByText("You don't have the rights for this action.")).toBeNull();
	});

	it("shows nothing without a message or a failure", async () => {
		await render(<ErrorBanner error={null} />);
		expect(screen.toJSON()).toBeNull();
	});
});

describe("rowOpacity", () => {
	it("dims a row only while it is pressed", () => {
		expect(rowOpacity(true)).toBe(0.85);
		expect(rowOpacity(false)).toBe(1);
	});
});

describe("KeyboardAvoiding", () => {
	const os = Platform.OS;
	afterEach(() => Object.defineProperty(Platform, "OS", { value: os, configurable: true }));

	// iOS pads the bottom by the keyboard's height; Android resizes the window, so no padding.
	it.each([
		["ios", true],
		["android", false],
	])("on %s pads the form: %s", async (platform, padded) => {
		Object.defineProperty(Platform, "OS", { value: platform, configurable: true });
		await render(
			<KeyboardAvoiding>
				<Text>form</Text>
			</KeyboardAvoiding>,
		);
		const root = screen.toJSON() as unknown as { props: { style: object } };
		expect("paddingBottom" in (StyleSheet.flatten(root.props.style) as object)).toBe(padded);
		expect(screen.getByText("form")).toBeTruthy();
	});
});
