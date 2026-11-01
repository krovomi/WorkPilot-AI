import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { Text } from "react-native";
import "../i18n";
import { PALETTES } from "../ui/palettes";
import { paletteFor, type Theme, useTheme } from "../ui/theme";
import { COLOR_THEME_IDS, parsePrefs } from "../ui/theme-ids";
import { loadPrefs, savePrefs } from "../ui/theme-store";
import { type PrefsApi, pushPrefs, syncPrefs } from "../ui/theme-sync";
import { ThemeProvider } from "../ui/ThemeProvider";
import { ThemeSection } from "../ui/ThemeSection";

const mockSession: { status: string; api: PrefsApi | null; user: { id: string } | null; permissions: null } = {
	status: "signedOut",
	api: null,
	user: null,
	permissions: null,
};
jest.mock("../auth/session", () => ({ useSession: () => mockSession }));

const mockScheme = { value: "light" as "light" | "dark" };
jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({
	__esModule: true,
	default: () => mockScheme.value,
}));

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const KEY = "workpilot.uiPrefs";

function luminance(hex: string): number {
	const channel = (i: number) => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

function fakeApi(remote: unknown = { theme: null, colorTheme: null }): jest.Mocked<PrefsApi> {
	return {
		preferences: jest.fn(async () => remote),
		setPreferences: jest.fn(async (prefs) => prefs),
	};
}

function Probe() {
	const theme: Theme = useTheme();
	return <Text testID="probe">{`${theme.background}|${theme.accent}`}</Text>;
}

beforeEach(() => {
	store.clear();
	mockScheme.value = "light";
	Object.assign(mockSession, { status: "signedOut", api: null, user: null });
});

describe("palettes", () => {
	it("has a light and a dark palette for each of the desktop's themes", () => {
		expect(Object.keys(PALETTES).sort()).toEqual([...COLOR_THEME_IDS].sort());
		for (const id of COLOR_THEME_IDS) {
			expect(PALETTES[id].light.dark).toBe(false);
			expect(PALETTES[id].dark.dark).toBe(true);
			for (const value of Object.values(PALETTES[id].light).concat(Object.values(PALETTES[id].dark))) {
				if (typeof value === "string") expect(value).toMatch(/^#[0-9A-F]{6}$/);
			}
		}
	});

	it("takes the desktop's own colours", () => {
		expect(PALETTES.ocean.light.background).toBe("#E0F2FE");
		expect(PALETTES.ocean.light.accent).toBe("#0284C7");
		expect(PALETTES.forest.dark.background).toBe("#052E16");
		expect(PALETTES.neo.dark.accent).toBe("#F0ABFC");
		// Default light keeps the phone's darker accent, white text on it.
		expect(PALETTES.default.light.accent).toBe("#8E8F5A");
		expect(PALETTES.default.light.onAccent).toBe("#FFFFFF");
	});

	it.each(COLOR_THEME_IDS.flatMap((id) => [`${id}.light`, `${id}.dark`]))("keeps %s readable", (name) => {
		const [id, shade] = name.split(".") as [keyof typeof PALETTES, "light" | "dark"];
		const p = PALETTES[id][shade];
		for (const color of [p.accent, p.success, p.warning, p.danger]) {
			expect(contrast(color, p.background)).toBeGreaterThanOrEqual(3);
			expect(contrast(color, p.surface)).toBeGreaterThanOrEqual(3);
		}
		expect(contrast(p.danger, p.dangerSoft)).toBeGreaterThanOrEqual(3);
		expect(contrast(p.onAccent, p.accent)).toBeGreaterThanOrEqual(3);
		expect(contrast(p.text, p.background)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(p.text, p.surface)).toBeGreaterThanOrEqual(4.5);
	});

	it("follows the device in system mode, and a fixed mode otherwise", () => {
		expect(paletteFor("lime", "system", "dark")).toBe(PALETTES.lime.dark);
		expect(paletteFor("lime", "system", "light")).toBe(PALETTES.lime.light);
		expect(paletteFor("lime", "system", null)).toBe(PALETTES.lime.light);
		expect(paletteFor("lime", "dark", "light")).toBe(PALETTES.lime.dark);
		expect(paletteFor("lime", "light", "dark")).toBe(PALETTES.lime.light);
	});

	it("accepts only the closed lists", () => {
		expect(parsePrefs({ theme: "dark", colorTheme: "retro" })).toEqual({ theme: "dark", colorTheme: "retro" });
		expect(parsePrefs({ theme: "sepia", colorTheme: "retro" })).toBeNull();
		expect(parsePrefs({ theme: "dark", colorTheme: "solarized" })).toBeNull();
		expect(parsePrefs({ theme: null, colorTheme: null })).toBeNull();
		expect(parsePrefs("dark")).toBeNull();
	});
});

describe("the phone's copy", () => {
	it("reads back what it kept, and nothing from a broken entry", async () => {
		await savePrefs({ theme: "dark", colorTheme: "neo", pending: true });
		expect(await loadPrefs()).toEqual({ theme: "dark", colorTheme: "neo", pending: true });
		store.set(KEY, "{not json");
		expect(await loadPrefs()).toBeNull();
		store.set(KEY, JSON.stringify({ theme: "dark", colorTheme: "evil" }));
		expect(await loadPrefs()).toBeNull();
	});
});

describe("sync with the server", () => {
	it("lets the server's choice win over the phone's copy", async () => {
		const api = fakeApi({ theme: "dark", colorTheme: "ocean" });
		const next = await syncPrefs(api, { theme: "light", colorTheme: "lime", pending: false });
		expect(next).toEqual({ theme: "dark", colorTheme: "ocean", pending: false });
		expect(api.setPreferences).not.toHaveBeenCalled();
	});

	it("sends a choice made offline before reading the server's", async () => {
		const api = fakeApi({ theme: "dark", colorTheme: "ocean" });
		const next = await syncPrefs(api, { theme: "light", colorTheme: "lime", pending: true });
		expect(api.setPreferences).toHaveBeenCalledWith({ theme: "light", colorTheme: "lime" });
		expect(api.preferences).not.toHaveBeenCalled();
		expect(next).toEqual({ theme: "light", colorTheme: "lime", pending: false });
	});

	it("gives the phone's copy to a server that has none", async () => {
		const api = fakeApi();
		expect(await syncPrefs(api, { theme: "dark", colorTheme: "retro", pending: false })).toBeNull();
		expect(api.setPreferences).toHaveBeenCalledWith({ theme: "dark", colorTheme: "retro" });
	});

	it("keeps the phone's copy when the server cannot be reached", async () => {
		const api = fakeApi();
		api.preferences.mockRejectedValue(new Error("network"));
		api.setPreferences.mockRejectedValue(new Error("network"));
		expect(await syncPrefs(api, { theme: "dark", colorTheme: "retro", pending: false })).toBeNull();
		expect(await syncPrefs(api, { theme: "dark", colorTheme: "retro", pending: true })).toBeNull();
		expect(await pushPrefs(api, { theme: "dark", colorTheme: "retro" })).toBe(true);
	});
});

describe("theme provider and settings section", () => {
	it("applies the phone's copy at launch, then the account's once signed in", async () => {
		store.set(KEY, JSON.stringify({ theme: "light", colorTheme: "forest", pending: false }));
		const view = await render(
			<ThemeProvider>
				<Probe />
			</ThemeProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("#DCFCE7|#16A34A"));
		const api = fakeApi({ theme: "dark", colorTheme: "ocean" });
		Object.assign(mockSession, { status: "signedIn", api, user: { id: "u1" } });
		await view.rerender(
			<ThemeProvider>
				<Probe />
			</ThemeProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("#082F49|#38BDF8"));
		expect(JSON.parse(store.get(KEY) ?? "{}")).toEqual({ theme: "dark", colorTheme: "ocean", pending: false });
	});

	it("shows the modes and the seven themes, and a choice applies, is kept and sent", async () => {
		const api = fakeApi({ theme: null, colorTheme: null });
		Object.assign(mockSession, { status: "signedIn", api, user: { id: "u1" } });
		await render(
			<ThemeProvider>
				<Probe />
				<ThemeSection />
			</ThemeProvider>,
		);
		for (const name of ["System", "Light", "Dark", "Default", "Dusk", "Lime", "Ocean", "Retro", "Neo", "Forest"]) {
			expect(screen.getByRole("radio", { name })).toBeTruthy();
		}
		expect(screen.getByRole("radio", { name: "System" })).toBeSelected();
		await fireEvent.press(screen.getByRole("radio", { name: "Retro" }));
		await fireEvent.press(screen.getByRole("radio", { name: "Dark" }));
		expect(screen.getByTestId("probe")).toHaveTextContent(
			`${PALETTES.retro.dark.background}|${PALETTES.retro.dark.accent}`,
		);
		expect(screen.getByRole("radio", { name: "Retro" })).toBeSelected();
		await waitFor(() => expect(api.setPreferences).toHaveBeenLastCalledWith({ theme: "dark", colorTheme: "retro" }));
		await waitFor(() =>
			expect(JSON.parse(store.get(KEY) ?? "{}")).toEqual({ theme: "dark", colorTheme: "retro", pending: false }),
		);
	});

	it("keeps an offline choice on screen and pending for the next sync", async () => {
		const api = fakeApi();
		api.preferences.mockRejectedValue(new Error("network"));
		api.setPreferences.mockRejectedValue(new Error("network"));
		Object.assign(mockSession, { status: "signedIn", api, user: { id: "u1" } });
		await render(
			<ThemeProvider>
				<Probe />
				<ThemeSection />
			</ThemeProvider>,
		);
		await act(async () => {
			await fireEvent.press(screen.getByRole("radio", { name: "Lime" }));
		});
		expect(screen.getByTestId("probe")).toHaveTextContent(`${PALETTES.lime.light.background}|${PALETTES.lime.light.accent}`);
		await waitFor(() => expect(api.setPreferences).toHaveBeenCalled());
		expect(JSON.parse(store.get(KEY) ?? "{}")).toEqual({ theme: "system", colorTheme: "lime", pending: true });
	});
});
