/**
 * Building smartphone applications — Android and Apple — from the Kanban.
 *
 * A phone app has no URL to open, so the App Emulator's "framework + port +
 * iframe" shape does not describe it. What replaces the port is a **device**:
 * an Android emulator or an iOS simulator, booted, with the app installed on
 * it, and a screenshot as the evidence a human looks at.
 *
 * Every shape here mirrors what `apps/backend/mobile/` produces. The backend is
 * the only detector — a second one written in TypeScript is how the web side
 * ended up with two answers to "what kind of project is this".
 */

/** Where the app runs. Not the framework it is written with. */
export type MobilePlatform = "android" | "ios";

/** The stacks `mobile.stacks` knows how to build. */
export type MobileFramework =
	| "android-native"
	| "ios-native"
	| "flutter"
	| "react-native"
	| "expo"
	| "dotnet-maui"
	| "kotlin-multiplatform"
	| "capacitor";

/** What to run for one platform of one framework. */
export interface MobilePlatformCommands {
	/** Puts the app on a booted device — what the preview button calls. */
	run: string;
	/** Produces the artefact a store would take. */
	build: string;
	test: string;
	lint: string;
	/** Glob of where the build lands, when the stack has a stable one. */
	artifact: string;
	/** The trap specific to this stack and platform. */
	notes: string;
}

export interface MobileStackInfo {
	framework: MobileFramework | string;
	platforms: MobilePlatform[];
	/** The mobile root — a monorepo's app may sit below the project root. */
	projectDir: string;
	packageId: string;
	/** The files detection matched on, so a wrong answer can be argued with. */
	evidence: string[];
	notes: string;
	isCrossPlatform: boolean;
	commands: Partial<Record<MobilePlatform, MobilePlatformCommands>>;
}

/** One thing the app can be installed onto. */
export interface MobileDevice {
	/** AVD name or adb serial on Android; simulator udid on iOS. */
	id: string;
	name: string;
	platform: MobilePlatform;
	kind: "emulator" | "simulator" | "physical";
	state: string;
	/** "iOS 18.2" — empty on Android, where the AVD name carries the level. */
	runtime: string;
	isBooted: boolean;
}

export interface MobileToolCheck {
	tool: string;
	ok: boolean;
	detail: string;
	/** What to do about it. Empty when the check passed. */
	remedy: string;
	required: boolean;
}

/**
 * Whether one platform can be built on this machine.
 *
 * `ok: false` is not always a defect to fix: iOS off macOS is a property of the
 * machine, and the UI says so rather than offering a fix that does not exist.
 */
export interface MobilePlatformReadiness {
	platform: MobilePlatform;
	ok: boolean;
	blocker: string;
	checks: MobileToolCheck[];
}

/** Everything the preview panel needs, from one call to the runner. */
export interface MobilePlan {
	success: boolean;
	isMobile: boolean;
	/** Why not, when `isMobile` is false. */
	reason?: string;
	error?: string;
	stack?: MobileStackInfo;
	platforms?: Partial<Record<MobilePlatform, MobilePlatformReadiness>>;
	devices?: MobileDevice[];
	/** Per platform, why no device was found. The useful half of an empty list. */
	unavailable?: Partial<Record<MobilePlatform, string>>;
}

/** Where a preview session is in its lifecycle. */
export type MobileSessionPhase =
	| "idle"
	| "detecting"
	| "booting"
	| "building"
	| "installing"
	| "running"
	| "stopped"
	| "error";

export interface MobileSessionState {
	phase: MobileSessionPhase;
	platform: MobilePlatform | null;
	deviceId: string | null;
	/** Last screenshot, as a data URI. The phone equivalent of the webview. */
	screenshot: string | null;
	status: string;
	error: string | null;
}

/** The two platforms, in the order the UI shows them. */
export const MOBILE_PLATFORMS: readonly MobilePlatform[] = ["android", "ios"];

/** Label for a platform, for anything that is not translated (logs, commands). */
export function mobilePlatformLabel(platform: MobilePlatform): string {
	return platform === "android" ? "Android" : "iOS";
}
