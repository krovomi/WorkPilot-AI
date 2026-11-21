/**
 * @vitest-environment node
 *
 * The command line of a forge runner: the runner, the project folder under
 * the runner's own flag, the model and thinking level when there are some,
 * then the command and its arguments.
 */

import { describe, expect, it } from "vitest";
import { buildRunnerArgs } from "../subprocess-runner";

describe("buildRunnerArgs", () => {
	it("names the project folder with --project unless the runner asks for another flag", () => {
		expect(buildRunnerArgs("runner.py", "/p", "review-pr", ["7"])).toEqual([
			"runner.py",
			"--project",
			"/p",
			"review-pr",
			"7",
		]);
		expect(
			buildRunnerArgs("runner.py", "/p", "review-mr", ["7"], {
				model: "m",
				thinkingLevel: "low",
				projectFlag: "--project-dir",
			}),
		).toEqual(["runner.py", "--project-dir", "/p", "--model", "m", "--thinking-level", "low", "review-mr", "7"]);
	});
});
