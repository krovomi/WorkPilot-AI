import { screen, waitFor } from "expo-router/testing-library";
import { fakeServer, openApp, restoreFetch } from "../../../test-support/fake-server";

const mockStatusBar: string[] = [];
jest.mock("expo-status-bar", () => ({
	StatusBar: ({ style }: { style: string }) => {
		mockStatusBar.push(style);
		return null;
	},
}));

afterEach(() => {
	restoreFetch();
});

it("lights the status bar text on the dark theme the person chose on another device", async () => {
	fakeServer({ "GET /projects": [], "GET /users/me/preferences": { theme: "dark", colorTheme: "default" } });
	await openApp("/");
	expect(await screen.findByText(/No project yet/)).toBeTruthy();
	expect(mockStatusBar.at(0)).toBe("dark");
	await waitFor(() => expect(mockStatusBar.at(-1)).toBe("light"));
});
