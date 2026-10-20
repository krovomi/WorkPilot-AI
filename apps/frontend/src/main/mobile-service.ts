import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import type {
	MobileDevice,
	MobilePlan,
	MobilePlatform,
	MobileSessionPhase,
} from "../shared/types/mobile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** The line `runners/mobile_runner.py` prints its answer on. */
const RESULT_MARKER = "__MOBILE_RESULT__:";

/** Detection is a handful of local reads; longer than this means a hung adb. */
const DETECT_TIMEOUT_MS = 45_000;

/** A cold emulator takes about a minute; a compile can take several. */
const BOOT_TIMEOUT_MS = 180_000;

/** Kept for the panel's log pane, and for diagnosing a build that failed. */
export const OUTPUT_BUFFER_LINES = 400;

/**
 * Driving an Android emulator or an iOS simulator from the Kanban.
 *
 * The App Emulator answers "what URL is the dev server on". That question has
 * no answer for a phone application: the artefact is compiled, pushed onto a
 * device and looked at. This service is the equivalent for that shape —
 * *which device*, *is it booted*, *did the app install*, *what is on screen*.
 *
 * All of the knowledge lives in `apps/backend/mobile/`: which stack this is,
 * which commands it responds to, which devices exist, whether the toolchain is
 * usable. This service runs that runner and executes the commands it returns.
 * It deliberately detects nothing itself — a TypeScript detector next to the
 * Python one is two answers to one question, which is exactly how the web side
 * ended up with a duplicate.
 *
 * Events:
 * - 'plan' (plan: MobilePlan) — detection result
 * - 'phase' (phase: MobileSessionPhase) — lifecycle transition
 * - 'status' (message: string) — human-readable progress
 * - 'output' (line: string) — a line from a build, an install or the device log
 * - 'screenshot' (dataUri: string) — a frame captured from the device
 * - 'error' (message: string)
 * - 'stopped' ()
 */
export class MobileService extends EventEmitter {
	private pythonPath = "python";
	private backendPath: string | null = null;
	private detectionProcess: ChildProcess | null = null;
	private sessionProcess: ChildProcess | null = null;
	private logProcess: ChildProcess | null = null;
	private plan: MobilePlan | null = null;
	private phase: MobileSessionPhase = "idle";
	private platform: MobilePlatform | null = null;
	private deviceId: string | null = null;
	private readonly output: string[] = [];

	configure(pythonPath?: string, backendPath?: string): void {
		if (pythonPath) this.pythonPath = pythonPath;
		if (backendPath) this.backendPath = backendPath;
	}

	getPlan(): MobilePlan | null {
		return this.plan;
	}

	getState() {
		return {
			phase: this.phase,
			platform: this.platform,
			deviceId: this.deviceId,
			output: this.output.join("\n"),
		};
	}

	/**
	 * Resolve the backend directory, using the same strategy as the App
	 * Emulator: a packaged app keeps it in extraResources, a dev run finds it
	 * relative to `out/main`.
	 */
	private resolveBackendPath(): string | null {
		const marker = (base: string) =>
			path.join(base, "runners", "mobile_runner.py");

		if (this.backendPath && existsSync(marker(this.backendPath))) {
			return this.backendPath;
		}

		const appPath = app.getAppPath();
		const candidates = [
			...(app.isPackaged ? [path.join(process.resourcesPath, "backend")] : []),
			path.resolve(__dirname, "..", "..", "..", "backend"),
			path.resolve(appPath, "..", "backend"),
			path.resolve(appPath, "..", "..", "Resources", "backend"),
			path.resolve(process.cwd(), "apps", "backend"),
		];

		for (const candidate of candidates) {
			if (existsSync(marker(candidate))) {
				this.backendPath = candidate;
				return candidate;
			}
		}
		return null;
	}

	private setPhase(phase: MobileSessionPhase): void {
		this.phase = phase;
		this.emit("phase", phase);
	}

	private pushOutput(chunk: string): void {
		for (const line of chunk.split(/\r?\n/)) {
			if (!line.trim()) continue;
			this.output.push(line);
			if (this.output.length > OUTPUT_BUFFER_LINES) this.output.shift();
			this.emit("output", line);
		}
	}

	/**
	 * Ask the backend runner what this project is, which devices exist, and
	 * whether each platform can be built here — in one call.
	 *
	 * Three calls for one panel is three chances for the three answers to
	 * describe different projects.
	 */
	async detect(projectDir: string): Promise<MobilePlan> {
		const backend = this.resolveBackendPath();
		if (!backend) {
			const plan: MobilePlan = {
				success: false,
				isMobile: false,
				error:
					"The WorkPilot backend could not be located, so the mobile toolchain cannot be inspected.",
			};
			this.plan = plan;
			this.emit("plan", plan);
			return plan;
		}

		this.detectionProcess?.kill();
		this.setPhase("detecting");

		const plan = await this.runRunner(backend, [
			"--project-dir",
			projectDir,
			"--action",
			"plan",
		]);
		this.plan = plan;
		this.emit("plan", plan);
		this.setPhase("idle");
		return plan;
	}

	/** Re-read the device list alone — the answer changes as emulators boot. */
	async refreshDevices(
		projectDir: string,
		platforms?: MobilePlatform[],
	): Promise<MobilePlan> {
		const backend = this.resolveBackendPath();
		if (!backend) {
			return { success: false, isMobile: false, error: "Backend not found" };
		}
		const args = ["--project-dir", projectDir, "--action", "devices"];
		for (const platform of platforms ?? []) args.push("--platform", platform);
		return this.runRunner(backend, args);
	}

	private runRunner(backend: string, args: string[]): Promise<MobilePlan> {
		const runner = path.join(backend, "runners", "mobile_runner.py");
		return new Promise((resolve) => {
			const proc = spawn(this.pythonPath, [runner, ...args], {
				cwd: backend,
				env: { ...process.env } as Record<string, string>,
			});
			this.detectionProcess = proc;

			let stdout = "";
			let stderr = "";
			const timer = setTimeout(() => proc.kill(), DETECT_TIMEOUT_MS);

			proc.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString("utf-8");
			});
			proc.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString("utf-8");
			});
			proc.on("error", (err) => {
				clearTimeout(timer);
				this.detectionProcess = null;
				resolve({ success: false, isMobile: false, error: err.message });
			});
			proc.on("close", () => {
				clearTimeout(timer);
				this.detectionProcess = null;
				resolve(parseRunnerOutput(stdout, stderr));
			});
		});
	}

	/**
	 * Boot a device, build, install and launch, then capture a first frame.
	 *
	 * Each step emits its own phase, because they fail differently and the fix
	 * differs with them: a boot failure is a device problem, a build failure is
	 * a code or a signing one, and reporting the second as the first sends
	 * whoever reads it hunting in the wrong place.
	 */
	async launch(
		projectDir: string,
		platform: MobilePlatform,
		device: MobileDevice,
	): Promise<{ success: boolean; error?: string }> {
		const stack = this.plan?.stack;
		if (!stack) {
			return { success: false, error: "Detect the project before launching." };
		}
		const commands = stack.commands[platform];
		if (!commands?.run) {
			return {
				success: false,
				error: `No run command is known for ${platform} on a ${stack.framework} project.`,
			};
		}

		const readiness = this.plan?.platforms?.[platform];
		if (readiness && !readiness.ok) {
			// Refusing here is the point: the alternative is a build that runs for
			// minutes and fails with an error that reads like a code defect.
			return { success: false, error: readiness.blocker };
		}

		this.stop();
		this.platform = platform;
		this.deviceId = device.id;

		try {
			if (!device.isBooted) {
				this.setPhase("booting");
				this.emit("status", `Booting ${device.name}…`);
				await this.bootDevice(platform, device);
			}

			// Resolved after the boot, not before: an AVD that was not running has
			// no adb serial until it is, and every adb call below needs one.
			const serial =
				platform === "android"
					? await this.resolveAndroidSerial(device)
					: device.id;
			this.deviceId = serial || device.id;

			this.setPhase("building");
			this.emit("status", "Building and installing…");
			const exitCode = await this.runCommand(
				commands.run,
				stack.projectDir || projectDir,
				this.deviceEnv(platform, serial),
			);
			if (exitCode !== 0) {
				const message = `Build or install failed (exit code ${exitCode}).`;
				this.setPhase("error");
				this.emit("error", message);
				return { success: false, error: message };
			}

			this.setPhase("running");
			this.emit("status", "Running on device.");
			await this.captureScreenshot(platform, device);
			await this.startLogStream(platform, serial, stack.packageId);
			return { success: true };
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			this.setPhase("error");
			this.emit("error", message);
			return { success: false, error: message };
		}
	}

	/**
	 * Tell the build which device to deploy onto.
	 *
	 * Without this, a machine with two booted emulators deploys onto whichever
	 * one the tool picks first, and the panel shows a screenshot of the other.
	 */
	private deviceEnv(
		platform: MobilePlatform,
		serial: string,
	): Record<string, string> {
		return platform === "android" && serial ? { ANDROID_SERIAL: serial } : {};
	}

	/**
	 * The adb serial for a device, which is *not* its id when the id is an AVD
	 * name.
	 *
	 * `emulator -list-avds` yields names ("Pixel_8_API_35"); `adb` only ever
	 * speaks serials ("emulator-5554"). Passing the name to `adb -s` fails with
	 * "device not found", which reads like the emulator never booted — so every
	 * adb call in a session goes through this, and a session started by booting
	 * an AVD resolves its serial once the boot completes.
	 */
	private async resolveAndroidSerial(device: MobileDevice): Promise<string> {
		if (device.id.startsWith("emulator-") || device.kind === "physical") {
			return device.id;
		}
		const { stdout } = await this.capture("adb", ["devices"]);
		const serials = parseAdbEmulatorSerials(stdout);

		for (const serial of serials) {
			const { stdout: name } = await this.capture("adb", [
				"-s",
				serial,
				"emu",
				"avd",
				"name",
			]);
			if (name.split(/\r?\n/)[0]?.trim() === device.id) return serial;
		}
		// One emulator and no match means the name query failed, not that the
		// emulator is someone else's: using it beats reporting no device.
		return serials.length === 1 ? serials[0] : "";
	}

	private bootDevice(
		platform: MobilePlatform,
		device: MobileDevice,
	): Promise<void> {
		if (platform === "ios") {
			return this.runToCompletion("xcrun", ["simctl", "boot", device.id]).then(
				() => {
					// `open -a Simulator` brings the window up; a headless boot works
					// for install and screenshot either way, so a failure here is not
					// fatal to the session.
					void this.runToCompletion("open", ["-a", "Simulator"]).catch(
						() => undefined,
					);
				},
			);
		}

		// Android: the emulator binary does not return, so it is started
		// detached and readiness is polled through adb.
		const proc = spawn("emulator", ["-avd", device.id, "-no-snapshot-load"], {
			detached: true,
			stdio: "ignore",
		});
		proc.unref();
		return this.waitForAndroidBoot();
	}

	/**
	 * Wait until Android has finished booting, not until adb answers.
	 *
	 * `adb wait-for-device` returns as soon as the daemon responds, which is a
	 * good half-minute before the launcher exists. Installing in that window
	 * fails with a "device offline" that looks like a broken emulator.
	 */
	private async waitForAndroidBoot(): Promise<void> {
		const deadline = Date.now() + BOOT_TIMEOUT_MS;
		await this.runToCompletion("adb", ["wait-for-device"]).catch(
			() => undefined,
		);
		while (Date.now() < deadline) {
			const { stdout } = await this.capture("adb", [
				"shell",
				"getprop",
				"sys.boot_completed",
			]);
			if (stdout.trim() === "1") return;
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
		throw new Error(
			"The Android emulator did not finish booting in time. Start it from Android Studio and try again.",
		);
	}

	/** Run a shell command in the project, streaming its output to the panel. */
	private runCommand(
		command: string,
		cwd: string,
		env: Record<string, string>,
	): Promise<number> {
		return new Promise((resolve) => {
			const proc = spawn(command, {
				cwd,
				shell: true,
				env: { ...process.env, ...env } as Record<string, string>,
			});
			this.sessionProcess = proc;
			this.pushOutput(`$ ${command}`);

			proc.stdout?.on("data", (data: Buffer) =>
				this.pushOutput(data.toString("utf-8")),
			);
			proc.stderr?.on("data", (data: Buffer) =>
				this.pushOutput(data.toString("utf-8")),
			);
			proc.on("error", (err) => {
				this.pushOutput(err.message);
				this.sessionProcess = null;
				resolve(1);
			});
			proc.on("close", (code) => {
				this.sessionProcess = null;
				resolve(code ?? 1);
			});
		});
	}

	/**
	 * A frame from the device — the phone equivalent of the webview.
	 *
	 * Read as base64 straight from the tool's stdout rather than through a
	 * temporary file: it avoids a write to a directory that may be read-only in
	 * a packaged app, and there is nothing to clean up afterwards.
	 */
	async captureScreenshot(
		platform: MobilePlatform,
		device: MobileDevice,
	): Promise<string | null> {
		try {
			// Resolved here rather than by the caller: the renderer holds the device
			// as the picker listed it, which on Android is an AVD name, and `adb -s`
			// only speaks serials.
			const serial =
				platform === "android"
					? await this.resolveAndroidSerial(device)
					: device.id;
			const buffer =
				platform === "android"
					? await this.captureBinary("adb", [
							...(serial ? ["-s", serial] : []),
							"exec-out",
							"screencap",
							"-p",
						])
					: await this.captureBinary("xcrun", [
							"simctl",
							"io",
							serial || "booted",
							"screenshot",
							"--type=png",
							"-",
						]);
			if (!buffer.length) return null;
			const dataUri = `data:image/png;base64,${buffer.toString("base64")}`;
			this.emit("screenshot", dataUri);
			return dataUri;
		} catch {
			// A missing screenshot degrades the panel; it does not end the session.
			return null;
		}
	}

	/**
	 * Follow the app's own log, never the whole device's.
	 *
	 * An unfiltered `adb logcat` is thousands of lines of system chatter around
	 * the one crash being looked for, and it fills the panel faster than anyone
	 * can read it. The filter needs the app's *pid*, which only exists once the
	 * app is running — hence the lookup here rather than a constant.
	 */
	private async startLogStream(
		platform: MobilePlatform,
		serial: string,
		packageId: string,
	): Promise<void> {
		this.logProcess?.kill();

		let androidArgs: string[] = [];
		if (platform === "android") {
			const pid = packageId
				? (
						await this.capture("adb", [
							...(serial ? ["-s", serial] : []),
							"shell",
							"pidof",
							"-s",
							packageId,
						])
					).stdout.trim()
				: "";
			androidArgs = [
				...(serial ? ["-s", serial] : []),
				"logcat",
				"-v",
				"brief",
				// No pid means the app is not running yet: warnings and above from
				// the whole device is noisy but still readable, and it is the only
				// place a startup crash would appear.
				...(pid ? ["--pid", pid] : ["*:W"]),
			];
		}

		const [command, args] =
			platform === "android"
				? (["adb", androidArgs] as const)
				: ([
						"xcrun",
						[
							"simctl",
							"spawn",
							serial || "booted",
							"log",
							"stream",
							"--level",
							"error",
						],
					] as const);

		try {
			const proc = spawn(command, [...args]);
			this.logProcess = proc;
			proc.stdout?.on("data", (data: Buffer) =>
				this.pushOutput(data.toString("utf-8")),
			);
			proc.on("error", () => {
				this.logProcess = null;
			});
			proc.on("close", () => {
				this.logProcess = null;
			});
		} catch {
			this.logProcess = null;
		}
	}

	private runToCompletion(command: string, args: string[]): Promise<void> {
		return new Promise((resolve, reject) => {
			const proc = spawn(command, args);
			proc.on("error", reject);
			proc.on("close", (code) =>
				code === 0
					? resolve()
					: reject(new Error(`${command} exited with code ${code}`)),
			);
		});
	}

	private capture(
		command: string,
		args: string[],
	): Promise<{ stdout: string; code: number }> {
		return new Promise((resolve) => {
			let stdout = "";
			const proc = spawn(command, args);
			proc.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString("utf-8");
			});
			proc.on("error", () => resolve({ stdout: "", code: 1 }));
			proc.on("close", (code) => resolve({ stdout, code: code ?? 1 }));
		});
	}

	private captureBinary(command: string, args: string[]): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			const proc = spawn(command, args);
			proc.stdout?.on("data", (data: Buffer) => chunks.push(data));
			proc.on("error", reject);
			proc.on("close", () => resolve(Buffer.concat(chunks)));
		});
	}

	/** Stop the session's processes. The device itself is left booted. */
	stop(): void {
		this.sessionProcess?.kill();
		this.sessionProcess = null;
		this.logProcess?.kill();
		this.logProcess = null;
		if (this.phase !== "idle") {
			this.setPhase("stopped");
			this.emit("stopped");
		}
	}
}

/**
 * The serials of the emulators `adb devices` reports as ready.
 *
 * Exported because the shape of that output is the whole difficulty: the first
 * line is a header, an emulator that is still booting is listed as `offline`
 * rather than absent, and a physical phone sits in the same list. Installing
 * onto an offline device fails with a message that reads like a broken build.
 */
export function parseAdbEmulatorSerials(stdout: string): string[] {
	return stdout
		.split(/\r?\n/)
		.slice(1)
		.map((line) => line.trim().split(/\s+/))
		.filter(
			([serial, state]) => serial?.startsWith("emulator-") && state === "device",
		)
		.map(([serial]) => serial);
}

/**
 * Read the runner's one-line answer out of its stdout.
 *
 * Exported for the tests, and because getting this wrong is silent: a runner
 * that printed a warning before its marker still has a valid result after it.
 */
export function parseRunnerOutput(stdout: string, stderr: string): MobilePlan {
	const index = stdout.lastIndexOf(RESULT_MARKER);
	if (index < 0) {
		return {
			success: false,
			isMobile: false,
			error:
				stderr.trim().slice(-500) ||
				"The mobile runner produced no result. Check that Python is configured in Settings.",
		};
	}
	try {
		return JSON.parse(stdout.slice(index + RESULT_MARKER.length).trim());
	} catch (error: unknown) {
		return {
			success: false,
			isMobile: false,
			error: `Could not read the mobile runner's result: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

export const mobileService = new MobileService();
