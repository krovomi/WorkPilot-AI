import { describe, expect, it } from "vitest";
import { parseAdbEmulatorSerials, parseRunnerOutput } from "./mobile-service";

/**
 * Reading the backend runner's answer.
 *
 * Getting this wrong is silent rather than loud: a runner that printed a
 * warning before its marker still has a perfectly good result after it, and a
 * parser that gives up on the first unexpected line reports "not a mobile
 * project" for one that is.
 */
describe("parseRunnerOutput", () => {
	it("reads the result that follows the marker", () => {
		const plan = parseRunnerOutput(
			'__MOBILE_RESULT__:{"success": true, "isMobile": true}',
			"",
		);
		expect(plan.success).toBe(true);
		expect(plan.isMobile).toBe(true);
	});

	it("ignores anything printed before the marker", () => {
		const plan = parseRunnerOutput(
			'warning: an emulator is already running\n__MOBILE_RESULT__:{"success": true, "isMobile": false}',
			"",
		);
		expect(plan.success).toBe(true);
		expect(plan.isMobile).toBe(false);
	});

	it("takes the last marker when a subprocess echoed an earlier one", () => {
		const plan = parseRunnerOutput(
			'__MOBILE_RESULT__:{"success": false, "isMobile": false}\n' +
				'__MOBILE_RESULT__:{"success": true, "isMobile": true}',
			"",
		);
		expect(plan.success).toBe(true);
	});

	it("reports stderr when the runner produced no result at all", () => {
		const plan = parseRunnerOutput("", "ModuleNotFoundError: No module named 'mobile'");
		expect(plan.success).toBe(false);
		expect(plan.error).toContain("ModuleNotFoundError");
	});

	it("says so when Python itself never ran", () => {
		const plan = parseRunnerOutput("", "");
		expect(plan.success).toBe(false);
		// The actionable half: the usual cause is an unconfigured interpreter.
		expect(plan.error).toContain("Python");
	});

	it("does not throw on a truncated result line", () => {
		const plan = parseRunnerOutput('__MOBILE_RESULT__:{"success": tru', "");
		expect(plan.success).toBe(false);
		expect(plan.error).toBeTruthy();
	});
});

/**
 * Reading `adb devices`.
 *
 * The reason this is a function and not two lines inline: an AVD name is not an
 * adb serial. `emulator -list-avds` yields "Pixel_8_API_35" and `adb -s` only
 * ever speaks "emulator-5554", so passing the picker's id straight to adb fails
 * with "device not found" — which reads like the emulator never booted.
 */
describe("parseAdbEmulatorSerials", () => {
	it("skips the header line", () => {
		expect(
			parseAdbEmulatorSerials("List of devices attached\nemulator-5554\tdevice\n"),
		).toEqual(["emulator-5554"]);
	});

	it("ignores an emulator that is still booting", () => {
		// Installing onto an offline device fails with a message that reads like
		// a broken build.
		expect(
			parseAdbEmulatorSerials(
				"List of devices attached\nemulator-5554\toffline\nemulator-5556\tdevice\n",
			),
		).toEqual(["emulator-5556"]);
	});

	it("ignores a physical phone plugged into the same machine", () => {
		expect(
			parseAdbEmulatorSerials(
				"List of devices attached\n1A2B3C4D\tdevice\nemulator-5554\tdevice\n",
			),
		).toEqual(["emulator-5554"]);
	});

	it("returns nothing when adb sees nothing", () => {
		expect(parseAdbEmulatorSerials("List of devices attached\n\n")).toEqual([]);
		expect(parseAdbEmulatorSerials("")).toEqual([]);
	});
});
