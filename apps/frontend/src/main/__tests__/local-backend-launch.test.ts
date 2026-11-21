/**
 * @vitest-environment node
 *
 * The backend main spawns, when its uvicorn stops at startup
 * (local-backend-launch.ts): a port another backend already serves is used,
 * a port held by anything else is named, and the pipes never fill.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	backendExitError,
	isAddressInUse,
	watchSpawnedBackend,
} from "../local-backend-launch";

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough };

function fakeChild(): FakeChild {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
	});
}

function watch(child: FakeChild, answers: () => Promise<boolean>) {
	return watchSpawnedBackend(
		child as unknown as ChildProcessWithoutNullStreams,
		9000,
		answers,
	);
}

const LINUX_BUSY = "ERROR:    [Errno 98] Address already in use\n";

describe("isAddressInUse", () => {
	it.each([
		["Linux", LINUX_BUSY],
		["macOS", "ERROR:    [Errno 48] Address already in use"],
		[
			"Windows",
			"ERROR:    [WinError 10048] Only one usage of each socket address (protocol/network address/port) is normally permitted",
		],
	])("recognises a busy port on %s", (_os, stderr) => {
		expect(isAddressInUse(stderr)).toBe(true);
	});

	it("does not take another failure for a busy port", () => {
		expect(
			isAddressInUse("ModuleNotFoundError: No module named 'fastapi'"),
		).toBe(false);
	});
});

describe("backendExitError", () => {
	it("names the port a program holds", () => {
		expect(backendExitError(3, LINUX_BUSY, 9000).message).toContain(
			"Le port 9000 est déjà utilisé",
		);
	});

	it("keeps uvicorn's own output out of the message", () => {
		const message = backendExitError(1, "Traceback: token=sk-test-0000", 9000)
			.message;
		expect(message).toBe("Le backend s'est arrêté au démarrage (code 1).");
	});
});

describe("watchSpawnedBackend", () => {
	it("resolves when another backend serves the port the spawned one lost", async () => {
		const child = fakeChild();
		const answers = vi.fn(async () => true);
		const { exited } = watch(child, answers);

		child.stderr.write(LINUX_BUSY);
		await new Promise((r) => setImmediate(r));
		child.emit("exit", 3);

		await expect(exited).resolves.toBeUndefined();
		expect(answers).toHaveBeenCalledOnce();
	});

	it("rejects naming the port when nothing answers on it", async () => {
		const child = fakeChild();
		const { exited } = watch(child, async () => false);

		child.stderr.write(LINUX_BUSY);
		await new Promise((r) => setImmediate(r));
		child.emit("exit", 3);

		await expect(exited).rejects.toThrow("Le port 9000 est déjà utilisé");
	});

	it("rejects with the exit code for any other failure, even if the probe throws", async () => {
		const child = fakeChild();
		const { exited } = watch(child, async () => {
			throw new Error("probe failed");
		});

		child.emit("exit", 1);

		await expect(exited).rejects.toThrow("(code 1)");
	});

	it("drains both pipes and keeps only the end of stderr", async () => {
		const child = fakeChild();
		const { exited } = watch(child, async () => false);

		child.stdout.write("x".repeat(256 * 1024));
		child.stderr.write("y".repeat(256 * 1024));
		child.stderr.write(LINUX_BUSY);
		await new Promise((r) => setImmediate(r));

		expect(child.stdout.readableLength).toBe(0);
		expect(child.stderr.readableLength).toBe(0);
		child.emit("exit", 3);
		await expect(exited).rejects.toThrow("Le port 9000");
	});
});
