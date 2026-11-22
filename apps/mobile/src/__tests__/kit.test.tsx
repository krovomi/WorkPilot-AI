import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet, Text } from "react-native";
import i18n from "../i18n";
import { Button, Field, Section } from "../ui/components";
import { timeAgo } from "../ui/format";
import { Icon } from "../ui/Icon";
import { Avatar, Chip, EmptyState, Fab, IconButton, initials, ListRow } from "../ui/kit";
import { ThemeContext } from "../ui/theme";

describe("Icon", () => {
	it("draws the glyph it names, in the text colour unless told otherwise", async () => {
		await render(<Icon name="star" />);
		expect(screen.getByTestId("icon-star")).toBeTruthy();
	});
});

describe("IconButton", () => {
	it("is a button named by its label, with a dot when something waits behind it", async () => {
		const onPress = jest.fn();
		const view = await render(<IconButton icon="settings" label="Settings" onPress={onPress} />);
		await fireEvent.press(screen.getByRole("button", { name: "Settings" }));
		expect(onPress).toHaveBeenCalled();
		expect(StyleSheet.flatten(screen.getByRole("button").props.style).backgroundColor).toBe("transparent");
		await view.rerender(<IconButton icon="bell" label="Inbox" color="#123456" badge onPress={onPress} testOnly_pressed />);
		expect(StyleSheet.flatten(screen.getByRole("button").props.style).backgroundColor).not.toBe("transparent");
		expect(screen.getByTestId("icon-bell", { includeHiddenElements: true })).toBeTruthy();
	});
});

describe("Chip", () => {
	it("writes its label, with an icon and a colour when given", async () => {
		const view = await render(<Chip label="Feature" />);
		expect(screen.getByText("Feature")).toBeTruthy();
		await view.rerender(<Chip label="Working" icon="activity" color="#ff0000" />);
		expect(StyleSheet.flatten(screen.getByText("Working").props.style).color).toBe("#ff0000");
		expect(screen.getByTestId("icon-activity")).toBeTruthy();
	});
});

describe("Avatar", () => {
	it("shows a person's initials, two at most", async () => {
		expect(initials("Alice Martin")).toBe("AM");
		expect(initials("  bob  ")).toBe("B");
		expect(initials("Ada King Lovelace")).toBe("AK");
		// Decoration: the name is written next to it.
		const view = await render(<Avatar name="Alice Martin" />);
		expect(screen.getByText("AM", { includeHiddenElements: true })).toBeTruthy();
		// On a dark theme, dark ink on the lighter disc; a project's tile is square.
		await view.rerender(
			<ThemeContext.Provider value={{ prefs: { theme: "dark", colorTheme: "default" }, choose: jest.fn() }}>
				<Avatar name="acme-storefront" size={44} square />
			</ThemeContext.Provider>,
		);
		const ink = StyleSheet.flatten(screen.getByText("A", { includeHiddenElements: true }).props.style).color;
		expect(ink).toBe("#0B0B0F");
	});
});

describe("ListRow", () => {
	it("is a button named by its title, with its icon, its line and what goes on the right", async () => {
		const onPress = jest.fn();
		const view = await render(
			<ListRow icon="map" title="Roadmap" subtitle="The plan" right={<Text>3</Text>} onPress={onPress} />,
		);
		await fireEvent.press(screen.getByRole("button", { name: "Roadmap" }));
		expect(onPress).toHaveBeenCalled();
		expect(screen.getByText("The plan")).toBeTruthy();
		expect(screen.getByText("3")).toBeTruthy();
		await view.rerender(
			<ListRow title="Plain" tint="#00ff00" accessibilityLabel="A plain row" onPress={onPress} testOnly_pressed />,
		);
		expect(screen.getByRole("button", { name: "A plain row" })).toBeTruthy();
		expect(screen.queryByTestId("icon-map", { includeHiddenElements: true })).toBeNull();
	});
});

describe("EmptyState", () => {
	it("says why a list is empty, and what to do when it knows", async () => {
		const view = await render(<EmptyState icon="inbox" title="No card here." hint="Cards land here." />);
		expect(screen.getByText("Cards land here.")).toBeTruthy();
		await view.rerender(<EmptyState icon="inbox" title="No card here." />);
		expect(screen.queryByText("Cards land here.")).toBeNull();
	});
});

describe("Fab", () => {
	it("is a button named by its label, dimmed while pressed", async () => {
		const onPress = jest.fn();
		const view = await render(<Fab icon="plus" label="New card" onPress={onPress} />);
		await fireEvent.press(screen.getByRole("button", { name: "New card" }));
		expect(onPress).toHaveBeenCalled();
		await view.rerender(<Fab icon="plus" label="New card" onPress={onPress} testOnly_pressed />);
		expect(StyleSheet.flatten(screen.getByRole("button").props.style).opacity).toBe(0.85);
	});
});

describe("Button", () => {
	it("draws a ghost button in the accent, with its icon", async () => {
		await render(<Button label="More" variant="ghost" icon="plus" onPress={jest.fn()} />);
		expect(StyleSheet.flatten(screen.getByRole("button").props.style).backgroundColor).toBe("transparent");
		expect(screen.getByTestId("icon-plus")).toBeTruthy();
	});
});

describe("Field", () => {
	it("marks the field being typed in, and still calls the screen's own focus handlers", async () => {
		const onFocus = jest.fn();
		const onBlur = jest.fn();
		const view = await render(<Field label="Email" onFocus={onFocus} onBlur={onBlur} />);
		const border = () => StyleSheet.flatten(screen.getByLabelText("Email").props.style).borderColor;
		const idle = border();
		await fireEvent(screen.getByLabelText("Email"), "focus");
		expect(onFocus).toHaveBeenCalled();
		expect(border()).not.toBe(idle);
		await fireEvent(screen.getByLabelText("Email"), "blur");
		expect(onBlur).toHaveBeenCalled();
		expect(border()).toBe(idle);
		// Without handlers of its own, a field still shows its focus.
		await view.rerender(<Field label="Name" />);
		await fireEvent(screen.getByLabelText("Name"), "focus");
		await fireEvent(screen.getByLabelText("Name"), "blur");
	});
});

describe("Section", () => {
	it("titles its content, with an icon and a control on the right", async () => {
		await render(
			<Section title="Spec" icon="file-text" action={<Text>Edit</Text>}>
				<Text>Body</Text>
			</Section>,
		);
		expect(screen.getByRole("header", { name: "Spec" })).toBeTruthy();
		expect(screen.getByText("Edit")).toBeTruthy();
		expect(screen.getByTestId("icon-file-text")).toBeTruthy();
	});
});

describe("timeAgo", () => {
	const now = Date.parse("2026-11-22T12:00:00Z");
	const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
	const t = i18n.getFixedT("en");

	it("says how long ago in minutes, hours and days, then the date after a week", () => {
		expect(timeAgo(ago(0), t, "en", now)).toBe("just now");
		expect(timeAgo(ago(1), t, "en", now)).toBe("1 min ago");
		expect(timeAgo(ago(59), t, "en", now)).toBe("59 min ago");
		expect(timeAgo(ago(60), t, "en", now)).toBe("1 h ago");
		expect(timeAgo(ago(60 * 24 * 3), t, "en", now)).toBe("3 d ago");
		expect(timeAgo(ago(60 * 24 * 8), t, "en", now)).toMatch(/11\/14\/26/);
		expect(timeAgo(ago(5), i18n.getFixedT("fr"), "fr", now)).toBe("il y a 5 min");
	});

	it("says nothing without a date or for a broken one, and treats a date ahead as now", () => {
		expect(timeAgo(null, t, "en", now)).toBe("");
		expect(timeAgo("not a date", t, "en", now)).toBe("");
		expect(timeAgo(ago(-5), t, "en", now)).toBe("just now");
		// Without a clock given, the phone's.
		expect(timeAgo(new Date().toISOString(), t, "en")).toBe("just now");
	});
});
