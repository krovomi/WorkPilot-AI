/**
 * The scenario walkthrough in the visual proof (F5): only the verification's
 * own GIF, from one of the two spec copies, is copied into the run folder,
 * and the PR comment shows it under "Walkthrough" with the captures' URLs.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VisualProofRun } from "../shared/types";
import { buildProofComment } from "./visual-proof-service";
import {
	WALKTHROUGH_FILE,
	WALKTHROUGH_MAX_BYTES,
	WALKTHROUGH_SOURCE,
	copyWalkthrough,
	findWalkthrough,
	type WalkthroughPlace,
	walkthroughSection,
} from "./visual-proof-walkthrough";

const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
let root: string;
let place: WalkthroughPlace;

function verifyDir(checkout: string): string {
	const dir = path.join(checkout, ".workpilot", "specs", "001-orders", "verify");
	mkdirSync(dir, { recursive: true });
	return dir;
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "walkthrough-"));
	const relativeArtifactDir = path.join(".workpilot", "specs", "visual-proofs", "001-orders", "run-1");
	place = {
		runPath: path.join(root, "worktree"),
		projectPath: path.join(root, "project"),
		specsBaseDir: path.join(".workpilot", "specs"),
		specId: "001-orders",
		artifactDir: path.join(root, "worktree", relativeArtifactDir),
		relativeArtifactDir,
	};
	mkdirSync(place.artifactDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("findWalkthrough / copyWalkthrough", () => {
	it("copies the newer of the two spec copies into the run folder", () => {
		const older = path.join(verifyDir(place.projectPath), WALKTHROUGH_SOURCE);
		writeFileSync(older, Buffer.concat([GIF, Buffer.from("old")]));
		utimesSync(older, new Date(1_000_000), new Date(1_000_000));
		const newer = path.join(verifyDir(place.runPath), WALKTHROUGH_SOURCE);
		writeFileSync(newer, Buffer.concat([GIF, Buffer.from("new")]));

		const shot = copyWalkthrough(place);
		expect(shot?.relativePath).toBe(path.join(place.relativeArtifactDir, WALKTHROUGH_FILE));
		expect(readFileSync(path.join(place.artifactDir, WALKTHROUGH_FILE)).toString("latin1")).toMatch(/new$/);
	});

	it("refuses a link to a file outside the spec", () => {
		const target = path.join(root, "elsewhere.gif");
		writeFileSync(target, GIF);
		try {
			symlinkSync(target, path.join(verifyDir(place.runPath), WALKTHROUGH_SOURCE));
		} catch {
			return; // symlinks need privileges on some Windows runners
		}
		expect(findWalkthrough(place)).toBeNull();
	});

	it("refuses a file over the ceiling, or one that is not a GIF", () => {
		const dir = verifyDir(place.runPath);
		writeFileSync(path.join(dir, WALKTHROUGH_SOURCE), Buffer.alloc(WALKTHROUGH_MAX_BYTES + 1, 0x47));
		expect(findWalkthrough(place)).toBeNull();

		writeFileSync(path.join(dir, WALKTHROUGH_SOURCE), "<svg onload=alert(1)>");
		expect(findWalkthrough(place)).toBeNull();
		expect(copyWalkthrough(place)).toBeUndefined();
		expect(existsSync(path.join(place.artifactDir, WALKTHROUGH_FILE))).toBe(false);
	});
});

describe("the Walkthrough section of the PR comment", () => {
	const run: VisualProofRun = {
		id: "run-1",
		status: "passed",
		taskId: "t1",
		specId: "001-orders",
		screenshots: [
			{
				label: "Home",
				relativePath: "specs/visual-proofs/001-orders/run-1/home.png",
				absolutePath: "/abs/home.png",
				width: 1,
				height: 1,
				capturedAt: "2026-11-06T00:00:00Z",
			},
		],
		startedAt: "2026-11-06T00:00:00Z",
	};
	const walkthrough = {
		label: "Scenario walkthrough",
		relativePath: "specs\\visual-proofs\\001-orders\\run-1\\walkthrough.gif",
		absolutePath: "/abs/walkthrough.gif",
		width: 0,
		height: 0,
		capturedAt: "2026-11-06T00:00:00Z",
	};

	it("appears only when a walkthrough was attached", () => {
		expect(walkthroughSection(undefined, "feat/x")).toEqual([]);
		expect(buildProofComment(run, "feat/x")).not.toContain("### Walkthrough");
	});

	it("links the GIF from the branch exactly like the captures", () => {
		const comment = buildProofComment({ ...run, walkthrough }, "feat/x");
		expect(comment).toContain("### Walkthrough");
		expect(comment).toContain(
			"![Scenario walkthrough](blob/feat/x/specs/visual-proofs/001-orders/run-1/walkthrough.gif?raw=1)",
		);
		expect(comment).toContain("![Home](blob/feat/x/specs/visual-proofs/001-orders/run-1/home.png?raw=1)");
		expect(comment.indexOf("### Walkthrough")).toBeLessThan(comment.indexOf("### Screenshots"));
		const url = "https://github.com/acme/shop/blob/feat/x/walkthrough.gif?raw=1";
		expect(walkthroughSection({ ...walkthrough, url })).toEqual([
			"### Walkthrough",
			"",
			`![Scenario walkthrough](${url})`,
			"",
		]);
	});
});
