/**
 * The release train's approvals (#362): main hashes the train file itself,
 * never through a link, and keeps the hash the person approved; what the
 * renderer sends is checked before the runner sees it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	approve,
	approvedHash,
	pickVariables,
	readAction,
	readEnvironment,
	readRunId,
	readServices,
	readTarget,
	trainFileHash,
} from "../approvals";

let dir: string;
let project: string;
let store: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "wp-train-"));
	project = path.join(dir, "project");
	mkdirSync(project);
	store = path.join(dir, "approvals.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("release train approvals", () => {
	it("hashes the file and keeps only the hash it still has", () => {
		expect(trainFileHash(project)).toBeNull();
		writeFileSync(path.join(project, "release-train.yaml"), "services: []\n", "utf-8");
		const hash = sha("services: []\n");
		expect(trainFileHash(project)).toBe(hash);
		expect(approve(store, project, "0".repeat(64))).toBe(false);
		expect(approve(store, project, hash)).toBe(true);
		expect(approvedHash(store, project)).toBe(hash);
		if (process.platform !== "win32") expect(statSync(store).mode & 0o777).toBe(0o600);
		writeFileSync(path.join(project, "release-train.yaml"), "services: [x]\n", "utf-8");
		expect(trainFileHash(project)).not.toBe(approvedHash(store, project));
		expect(JSON.parse(readFileSync(store, "utf-8"))).toEqual({ [project]: hash });
	});

	it.skipIf(process.platform === "win32")("never reads a train file through a link", () => {
		const outside = path.join(dir, "outside.yaml");
		writeFileSync(outside, "services: []\n", "utf-8");
		symlinkSync(outside, path.join(project, "release-train.yaml"));
		expect(trainFileHash(project)).toBeNull();
		mkdirSync(path.join(dir, "elsewhere"));
		writeFileSync(path.join(dir, "elsewhere", "release-train.yaml"), "x: 1\n", "utf-8");
		symlinkSync(path.join(dir, "elsewhere"), path.join(project, ".workpilot"));
		expect(trainFileHash(project)).toBeNull();
	});

	it("refuses an oversized train file", () => {
		writeFileSync(path.join(project, "release-train.yaml"), "#".repeat(64 * 1024 + 1), "utf-8");
		expect(trainFileHash(project)).toBeNull();
	});

	it("takes checked values only", () => {
		expect(readEnvironment("production")).toBe("production");
		expect(readEnvironment("--prod")).toBeNull();
		expect(readServices(["auth", "@acme/web"])).toEqual(["auth", "@acme/web"]);
		expect(readServices(["a b"])).toBeNull();
		expect(readServices(undefined)).toEqual([]);
		expect(readRunId("rt-20261110-010203-abcdef")).toBe("rt-20261110-010203-abcdef");
		expect(readRunId("../x")).toBeNull();
		expect(readAction("rollback")).toBe("rollback");
		expect(readAction("exec")).toBeNull();
		expect(readTarget("flag:new-checkout")).toBe("flag:new-checkout");
		expect(readTarget("flag:a b")).toBeNull();
		expect(readTarget(undefined)).toBe("");
	});

	it("hands over only the variables the train file names", () => {
		const env = { AWS_PROFILE: "prod", UNLEASH_API_TOKEN: "tok", OTHER_SECRET: "no" };
		expect(pickVariables(env, ["AWS_PROFILE", "UNLEASH_API_TOKEN", "MISSING", "bad name"])).toEqual({
			AWS_PROFILE: "prod",
			UNLEASH_API_TOKEN: "tok",
		});
		expect(pickVariables(env, "AWS_PROFILE")).toEqual({});
	});
});
