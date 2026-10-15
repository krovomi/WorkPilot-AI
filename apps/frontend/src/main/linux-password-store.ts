/**
 * The keyring Electron safeStorage uses on Linux, chosen once before `ready`.
 * See docs/architecture/secrets-at-rest.md.
 *
 * Chromium picks its password store from the desktop environment the session
 * declares (XDG_CURRENT_DESKTOP, DESKTOP_SESSION…). When none is declared —
 * WSL, a bare X server, an SSH session — it picks `basic_text`, whose key is
 * compiled into Chromium, even while a Secret Service (GNOME Keyring,
 * KeePassXC…) owns its name on the session bus. secret-storage.ts then keeps
 * the secrets in clear and the banner asks for a keyring the user already runs.
 *
 * In that one case we ask for `gnome-libsecret` explicitly. A declared desktop
 * keeps Chromium's choice, and an explicit `--password-store` always wins. If
 * libsecret then fails (keyring locked, prompt refused), safeStorage reports
 * encryption unavailable and nothing changes: secrets stay in clear and the
 * banner says so.
 */

import { spawnSync } from "node:child_process";
import { app } from "electron";
import { findExecutable, isLinux } from "./platform";

export const PASSWORD_STORE_SWITCH = "password-store";
export const LIBSECRET_PASSWORD_STORE = "gnome-libsecret";
const SECRET_SERVICE_BUS_NAME = "org.freedesktop.secrets";
const PROBE_TIMEOUT_MS = 2000;

/**
 * The variables Chromium reads to detect a desktop (`GetDesktopEnvironment`,
 * base/nix/xdg_util.cc). With none of them set it falls back to `basic_text`.
 */
const DESKTOP_ENV_VARS = [
	"XDG_CURRENT_DESKTOP",
	"DESKTOP_SESSION",
	"GNOME_DESKTOP_SESSION_ID",
	"KDE_FULL_SESSION",
] as const;

/** All the probe hands to dbus-send: where the bus is, no secret (rule S4). */
const BUS_ENV_VARS = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] as const;

type Env = Readonly<Record<string, string | undefined>>;

export interface PasswordStoreContext {
	env: Env;
	hasSwitch: (name: string) => boolean;
	secretServiceRunning: (env: Env) => boolean;
}

/** The `--password-store` value to add, or null to leave Chromium's choice. */
export function choosePasswordStore({
	env,
	hasSwitch,
	secretServiceRunning,
}: PasswordStoreContext): string | null {
	if (hasSwitch(PASSWORD_STORE_SWITCH)) return null;
	if (DESKTOP_ENV_VARS.some((name) => env[name])) return null;
	// No bus address: the user's keyring cannot be the one D-Bus would find.
	if (!env.DBUS_SESSION_BUS_ADDRESS) return null;
	return secretServiceRunning(env) ? LIBSECRET_PASSWORD_STORE : null;
}

/**
 * Whether a Secret Service owns its name on the session bus right now. One
 * D-Bus could only activate does not count: starting it would open a "create
 * a keyring" prompt the user never asked for.
 */
export function secretServiceOnSessionBus(env: Env): boolean {
	const dbusSend = findExecutable("dbus-send");
	if (!dbusSend) return false;
	const childEnv: Record<string, string> = {};
	for (const name of BUS_ENV_VARS) {
		const value = env[name];
		if (value) childEnv[name] = value;
	}
	try {
		const result = spawnSync(
			dbusSend,
			[
				"--session",
				"--print-reply",
				`--reply-timeout=${PROBE_TIMEOUT_MS}`,
				"--dest=org.freedesktop.DBus",
				"/org/freedesktop/DBus",
				"org.freedesktop.DBus.NameHasOwner",
				`string:${SECRET_SERVICE_BUS_NAME}`,
			],
			{
				encoding: "utf8",
				env: childEnv,
				stdio: ["ignore", "pipe", "ignore"],
				timeout: PROBE_TIMEOUT_MS + 500,
			},
		);
		return result.status === 0 && /\bboolean true\b/.test(result.stdout ?? "");
	} catch {
		return false;
	}
}

/**
 * Adds `--password-store` when Chromium would otherwise pass over a running
 * Secret Service. Call at startup, before `ready`: Chromium reads the switch
 * once, when it sets up os_crypt.
 */
export function selectLinuxPasswordStore(): void {
	if (!isLinux()) return;
	const store = choosePasswordStore({
		env: process.env,
		hasSwitch: (name) => app.commandLine.hasSwitch(name),
		secretServiceRunning: secretServiceOnSessionBus,
	});
	if (!store) return;
	app.commandLine.appendSwitch(PASSWORD_STORE_SWITCH, store);
	console.warn(
		`[SecretStorage] No desktop environment declared, but a Secret Service is running: safeStorage uses --${PASSWORD_STORE_SWITCH}=${store}.`,
	);
}
