/**
 * `webviewTag: true` sans `will-attach-webview` : la faille que ces tests
 * ferment.
 *
 * La fenêtre principale est correctement configurée — `sandbox: true`,
 * `contextIsolation: true`, `nodeIntegration: false` — mais une balise
 * `<webview>` porte ses propres `webPreferences` dans ses attributs HTML.
 * Tant que personne ne reprenait cette décision, une injection DOM dans le
 * renderer posait `<webview nodeintegration preload="…">` et obtenait Node
 * dans le processus principal, par-dessus tout le reste.
 */

import { describe, expect, it } from "vitest";
import {
	enforceWebviewPreferences,
	isPermissionGranted,
	isWebviewSourceAllowed,
	WEBVIEW_ENFORCED_PREFERENCES,
} from "./webview-policy";

describe("les privilèges d'un <webview> ne viennent pas du DOM", () => {
	it("écrase ce qu'une balise injectée aurait demandé", () => {
		const injected: Record<string, unknown> = {
			nodeIntegration: true,
			nodeIntegrationInSubFrames: true,
			contextIsolation: false,
			sandbox: false,
			webSecurity: false,
			allowRunningInsecureContent: true,
			experimentalFeatures: true,
		};

		enforceWebviewPreferences(injected);

		expect(injected).toMatchObject(WEBVIEW_ENFORCED_PREFERENCES);
	});

	it("retire un preload, qui ferait exécuter du code à nous dans la page", () => {
		const injected: Record<string, unknown> = {
			preload: "file:///tmp/evil.js",
			preloadURL: "file:///tmp/evil.js",
		};

		enforceWebviewPreferences(injected);

		expect(injected).not.toHaveProperty("preload");
		expect(injected).not.toHaveProperty("preloadURL");
	});

	it("laisse passer ce qui ne relève pas des privilèges", () => {
		// L'aperçu règle la taille et le zoom ; la politique n'a rien à en dire.
		const preferences: Record<string, unknown> = { zoomFactor: 0.75 };
		enforceWebviewPreferences(preferences);
		expect(preferences.zoomFactor).toBe(0.75);
	});
});

describe("ce qu'un aperçu peut charger", () => {
	it.each([
		"http://localhost:5173/",
		"https://example.com/app",
		"file:///home/u/.workpilot/specs/001/architecture/map.html",
		"about:blank",
	])("accepte %s", (src) => {
		expect(isWebviewSourceAllowed(src)).toBe(true);
	});

	it.each(["javascript:alert(1)", "vbscript:msgbox", "chrome://settings"])(
		"refuse %s",
		(src) => {
			expect(isWebviewSourceAllowed(src)).toBe(false);
		},
	);

	it("accepte un src vide : rien à charger, rien à autoriser", () => {
		// L'état d'un <webview> monté avant sa première navigation.
		expect(isWebviewSourceAllowed("")).toBe(true);
		expect(isWebviewSourceAllowed(undefined)).toBe(true);
	});

	it("refuse un src non analysable", () => {
		expect(isWebviewSourceAllowed("pas une url")).toBe(false);
	});
});

describe("ce qu'une page peut demander à la machine", () => {
	it.each(["clipboard-read", "fullscreen", "notifications"])(
		"accorde %s",
		(permission) => {
			expect(isPermissionGranted(permission)).toBe(true);
		},
	);

	it.each([
		"media",
		"geolocation",
		"midi",
		"midiSysex",
		"hid",
		"serial",
		"usb",
		"pointerLock",
		"openExternal",
		"idle-detection",
	])("refuse %s", (permission) => {
		// Electron les accorde toutes par défaut, et l'aperçu charge la page de
		// quelqu'un d'autre.
		expect(isPermissionGranted(permission)).toBe(false);
	});

	it("refuse une permission qu'aucune version de Chromium n'a encore ajoutée", () => {
		// La liste est une liste d'autorisation : ce qui arrivera plus tard est
		// refusé jusqu'à ce que quelqu'un en décide autrement.
		expect(isPermissionGranted("some-future-capability")).toBe(false);
	});
});
