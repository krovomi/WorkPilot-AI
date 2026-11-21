/**
 * @vitest-environment node
 *
 * Linux password store (linux-password-store.ts): with no desktop declared,
 * Chromium passes over a running Secret Service for `basic_text`. We ask for
 * libsecret in that case only, and never override a choice already made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.fn();
const findExecutable = vi.fn<(name: string) => string | null>();
const isLinux = vi.fn(() => true);
const commandLine = {
	hasSwitch: vi.fn<(name: string) => boolean>(() => false),
	appendSwitch: vi.fn(),
};

vi.mock("node:child_process", () => ({ spawnSync }));
vi.mock("electron", () => ({ app: { commandLine } }));
vi.mock("../platform", () => ({ findExecutable, isLinux }));

type Module = typeof import("../linux-password-store");

async function load(): Promise<Module> {
	vi.resetModules();
	return import("../linux-password-store");
}

const BUS = "unix:path=/run/user/1000/bus";
const SECRET_SERVICE_REPLY =
	"method return time=1 sender=org.freedesktop.DBus -> destination=:1.4 serial=3 reply_serial=2\n   boolean true\n";
const LOGIN_COLLECTION = "/org/freedesktop/secrets/collection/login";
const ALIAS_REPLY = `method return time=1 sender=:1.7 -> destination=:1.9 serial=4 reply_serial=2\n   object path "${LOGIN_COLLECTION}"\n`;
const lockedReply = (locked: boolean) =>
	`method return time=1 sender=:1.7 -> destination=:1.9 serial=5 reply_serial=2\n   variant       boolean ${locked}\n`;

/** A session bus where a Secret Service runs, its default keyring as given. */
function busWith(keyring: { locked: boolean } | "none") {
	return (_command: string, args: string[]) => {
		if (args.includes("org.freedesktop.DBus.NameHasOwner")) {
			return { status: 0, stdout: SECRET_SERVICE_REPLY };
		}
		if (args.includes("org.freedesktop.Secret.Service.ReadAlias")) {
			return {
				status: 0,
				stdout:
					keyring === "none"
						? ALIAS_REPLY.replace(LOGIN_COLLECTION, "/")
						: ALIAS_REPLY,
			};
		}
		if (keyring !== "none" && args.includes(LOGIN_COLLECTION)) {
			return { status: 0, stdout: lockedReply(keyring.locked) };
		}
		return { status: 1, stdout: "" };
	};
}

describe("choosePasswordStore", () => {
	const running = vi.fn(() => true);
	const unlocked = vi.fn(() => true);
	const noSwitch = () => false;

	beforeEach(() => {
		running.mockClear();
		unlocked.mockClear();
	});

	it("asks for libsecret when no desktop is declared and a Secret Service runs", async () => {
		const { choosePasswordStore } = await load();

		expect(
			choosePasswordStore({
				env: { DBUS_SESSION_BUS_ADDRESS: BUS },
				hasSwitch: noSwitch,
				secretServiceRunning: running,
				keyringUnlocked: unlocked,
			}),
		).toBe("gnome-libsecret");
	});

	it("never overrides an explicit --password-store", async () => {
		const { choosePasswordStore } = await load();

		expect(
			choosePasswordStore({
				env: { DBUS_SESSION_BUS_ADDRESS: BUS },
				hasSwitch: (name) => name === "password-store",
				secretServiceRunning: running,
				keyringUnlocked: unlocked,
			}),
		).toBeNull();
		expect(running).not.toHaveBeenCalled();
	});

	it.each([
		["XDG_CURRENT_DESKTOP", "KDE"],
		["XDG_CURRENT_DESKTOP", "i3"],
		["DESKTOP_SESSION", "plasma"],
		["GNOME_DESKTOP_SESSION_ID", "this-is-deprecated"],
		["KDE_FULL_SESSION", "true"],
	])("leaves Chromium's choice to a declared desktop (%s=%s)", async (name, value) => {
		const { choosePasswordStore } = await load();

		expect(
			choosePasswordStore({
				env: { DBUS_SESSION_BUS_ADDRESS: BUS, [name]: value },
				hasSwitch: noSwitch,
				secretServiceRunning: running,
				keyringUnlocked: unlocked,
			}),
		).toBeNull();
		expect(running).not.toHaveBeenCalled();
	});

	it("treats an empty desktop variable as undeclared, as Chromium does", async () => {
		const { choosePasswordStore } = await load();

		expect(
			choosePasswordStore({
				env: { DBUS_SESSION_BUS_ADDRESS: BUS, XDG_CURRENT_DESKTOP: "" },
				hasSwitch: noSwitch,
				secretServiceRunning: running,
				keyringUnlocked: unlocked,
			}),
		).toBe("gnome-libsecret");
	});

	it("does nothing without a session bus address", async () => {
		const { choosePasswordStore } = await load();

		expect(
			choosePasswordStore({
				env: {},
				hasSwitch: noSwitch,
				secretServiceRunning: running,
				keyringUnlocked: unlocked,
			}),
		).toBeNull();
		expect(running).not.toHaveBeenCalled();
	});

	it("leaves basic_text when the keyring is locked: its unlock prompt may never show", async () => {
		const { choosePasswordStore } = await load();

		expect(
			choosePasswordStore({
				env: { DBUS_SESSION_BUS_ADDRESS: BUS },
				hasSwitch: noSwitch,
				secretServiceRunning: running,
				keyringUnlocked: () => false,
			}),
		).toBeNull();
	});

	it("does nothing when no Secret Service owns its name on the bus", async () => {
		const { choosePasswordStore } = await load();

		expect(
			choosePasswordStore({
				env: { DBUS_SESSION_BUS_ADDRESS: BUS },
				hasSwitch: noSwitch,
				secretServiceRunning: () => false,
				keyringUnlocked: unlocked,
			}),
		).toBeNull();
	});
});

describe("secretServiceOnSessionBus", () => {
	beforeEach(() => {
		spawnSync.mockReset();
		findExecutable.mockReset();
		findExecutable.mockReturnValue("/usr/bin/dbus-send");
	});

	it("asks the bus whether org.freedesktop.secrets has an owner, without a shell", async () => {
		spawnSync.mockReturnValue({ status: 0, stdout: SECRET_SERVICE_REPLY });
		const { secretServiceOnSessionBus } = await load();

		expect(
			secretServiceOnSessionBus({ DBUS_SESSION_BUS_ADDRESS: BUS }),
		).toBe(true);
		const [command, args, options] = spawnSync.mock.calls[0];
		expect(command).toBe("/usr/bin/dbus-send");
		expect(args).toContain("org.freedesktop.DBus.NameHasOwner");
		expect(args).toContain("string:org.freedesktop.secrets");
		expect(options.shell).toBeUndefined();
	});

	it("hands dbus-send the bus address and nothing else from the environment", async () => {
		spawnSync.mockReturnValue({ status: 0, stdout: SECRET_SERVICE_REPLY });
		const { secretServiceOnSessionBus } = await load();

		secretServiceOnSessionBus({
			DBUS_SESSION_BUS_ADDRESS: BUS,
			XDG_RUNTIME_DIR: "/run/user/1000",
			ANTHROPIC_API_KEY: "sk-test-0000",
			PATH: "/usr/bin",
		});

		expect(spawnSync.mock.calls[0][2].env).toEqual({
			DBUS_SESSION_BUS_ADDRESS: BUS,
			XDG_RUNTIME_DIR: "/run/user/1000",
		});
	});

	it("reports no Secret Service when the name has no owner", async () => {
		spawnSync.mockReturnValue({
			status: 0,
			stdout: SECRET_SERVICE_REPLY.replace("true", "false"),
		});
		const { secretServiceOnSessionBus } = await load();

		expect(
			secretServiceOnSessionBus({ DBUS_SESSION_BUS_ADDRESS: BUS }),
		).toBe(false);
	});

	it.each([
		["the call fails", { status: 1, stdout: "" }],
		["the call times out", { status: null, stdout: "", error: new Error("ETIMEDOUT") }],
		["the reply only mentions true elsewhere", { status: 0, stdout: "string \"boolean truely\"" }],
	])("reports no Secret Service when %s", async (_case, result) => {
		spawnSync.mockReturnValue(result);
		const { secretServiceOnSessionBus } = await load();

		expect(
			secretServiceOnSessionBus({ DBUS_SESSION_BUS_ADDRESS: BUS }),
		).toBe(false);
	});

	it("reports no Secret Service when spawning throws", async () => {
		spawnSync.mockImplementation(() => {
			throw new Error("EACCES");
		});
		const { secretServiceOnSessionBus } = await load();

		expect(
			secretServiceOnSessionBus({ DBUS_SESSION_BUS_ADDRESS: BUS }),
		).toBe(false);
	});

	it("reports no Secret Service when dbus-send is not installed", async () => {
		findExecutable.mockReturnValue(null);
		const { secretServiceOnSessionBus } = await load();

		expect(
			secretServiceOnSessionBus({ DBUS_SESSION_BUS_ADDRESS: BUS }),
		).toBe(false);
		expect(spawnSync).not.toHaveBeenCalled();
	});
});

describe("defaultKeyringUnlocked", () => {
	beforeEach(() => {
		spawnSync.mockReset();
		findExecutable.mockReset();
		findExecutable.mockReturnValue("/usr/bin/dbus-send");
	});

	it("reads the default alias, then that collection's Locked property, without a shell", async () => {
		spawnSync.mockImplementation(busWith({ locked: false }));
		const { defaultKeyringUnlocked } = await load();

		expect(defaultKeyringUnlocked({ DBUS_SESSION_BUS_ADDRESS: BUS })).toBe(true);
		const [alias, property] = spawnSync.mock.calls.map((call) => call[1]);
		expect(alias).toEqual(
			expect.arrayContaining([
				"--dest=org.freedesktop.secrets",
				"org.freedesktop.Secret.Service.ReadAlias",
				"string:default",
			]),
		);
		expect(property).toEqual(
			expect.arrayContaining([
				LOGIN_COLLECTION,
				"org.freedesktop.DBus.Properties.Get",
				"string:Locked",
			]),
		);
		for (const call of spawnSync.mock.calls) {
			expect(call[2].shell).toBeUndefined();
		}
	});

	it("reports a locked keyring as not unlocked", async () => {
		spawnSync.mockImplementation(busWith({ locked: true }));
		const { defaultKeyringUnlocked } = await load();

		expect(defaultKeyringUnlocked({ DBUS_SESSION_BUS_ADDRESS: BUS })).toBe(false);
	});

	it("reports no default collection without asking further: creating one prompts", async () => {
		spawnSync.mockImplementation(busWith("none"));
		const { defaultKeyringUnlocked } = await load();

		expect(defaultKeyringUnlocked({ DBUS_SESSION_BUS_ADDRESS: BUS })).toBe(false);
		expect(spawnSync).toHaveBeenCalledTimes(1);
	});

	it.each([
		["the alias call fails", () => ({ status: 1, stdout: "" })],
		[
			"the alias is not an object path",
			() => ({ status: 0, stdout: 'object path "/a/../b"' }),
		],
		[
			"the property call fails",
			(_command: string, args: string[]) =>
				args.includes("org.freedesktop.Secret.Service.ReadAlias")
					? { status: 0, stdout: ALIAS_REPLY }
					: { status: 1, stdout: "" },
		],
	])("reports a keyring it cannot read as not unlocked when %s", async (_case, reply) => {
		spawnSync.mockImplementation(reply);
		const { defaultKeyringUnlocked } = await load();

		expect(defaultKeyringUnlocked({ DBUS_SESSION_BUS_ADDRESS: BUS })).toBe(false);
	});
});

describe("selectLinuxPasswordStore", () => {
	const savedEnv = { ...process.env };
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		isLinux.mockReturnValue(true);
		commandLine.hasSwitch.mockReset();
		commandLine.hasSwitch.mockReturnValue(false);
		commandLine.appendSwitch.mockReset();
		findExecutable.mockReturnValue("/usr/bin/dbus-send");
		spawnSync.mockReset();
		spawnSync.mockImplementation(busWith({ locked: false }));
		for (const name of [
			"XDG_CURRENT_DESKTOP",
			"DESKTOP_SESSION",
			"GNOME_DESKTOP_SESSION_ID",
			"KDE_FULL_SESSION",
		]) {
			delete process.env[name];
		}
		process.env.DBUS_SESSION_BUS_ADDRESS = BUS;
		warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		process.env = { ...savedEnv };
		warn.mockRestore();
	});

	it("appends --password-store=gnome-libsecret in the WSL case", async () => {
		const { selectLinuxPasswordStore } = await load();

		selectLinuxPasswordStore();

		expect(commandLine.appendSwitch).toHaveBeenCalledWith(
			"password-store",
			"gnome-libsecret",
		);
	});

	it("keeps basic_text and says why when the keyring is locked", async () => {
		spawnSync.mockImplementation(busWith({ locked: true }));
		const { selectLinuxPasswordStore } = await load();

		selectLinuxPasswordStore();

		expect(commandLine.appendSwitch).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("locked"));
	});

	it("does nothing outside Linux", async () => {
		isLinux.mockReturnValue(false);
		const { selectLinuxPasswordStore } = await load();

		selectLinuxPasswordStore();

		expect(spawnSync).not.toHaveBeenCalled();
		expect(commandLine.appendSwitch).not.toHaveBeenCalled();
	});

	it("keeps the store the user passed on the command line", async () => {
		commandLine.hasSwitch.mockImplementation(
			(name) => name === "password-store",
		);
		const { selectLinuxPasswordStore } = await load();

		selectLinuxPasswordStore();

		expect(commandLine.appendSwitch).not.toHaveBeenCalled();
	});
});
