import type { ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * The backend main spawns (uvicorn on 127.0.0.1:9000) and what its early exit
 * means.
 *
 * Two launchers race for the port under `pnpm run dev`: the backend's own dev
 * launcher (apps/backend/dev-server.mjs) and main, which starts one when
 * nothing answered within its first probe. The loser's uvicorn exits with
 * "Address already in use". When the winner is a backend that answers, that is
 * not a failure: the app uses it (dev-port.mjs does the same on the other
 * side). Only a port held by something that does not answer is reported, and
 * named, rather than "stopped with code 1".
 *
 * The pipes are drained as well: nothing else reads them, and a full pipe
 * blocks uvicorn on its next log line, the whole API with it.
 */

/** How much of uvicorn's stderr is kept to recognise why it stopped. */
const STDERR_TAIL_BYTES = 8 * 1024;

/** bind() refused, as each OS and Python words it. */
const ADDRESS_IN_USE = [
	/\[Errno (98|48)\]/, // Linux, macOS
	/WinError 10048/,
	/address already in use/i,
	/only one usage of each socket address/i,
];

export function isAddressInUse(stderr: string): boolean {
	return ADDRESS_IN_USE.some((pattern) => pattern.test(stderr));
}

/**
 * The error the startup dialog shows. uvicorn's own output stays out of it: it
 * can quote a configuration value, and only the cause matters here.
 */
export function backendExitError(
	code: number | null,
	stderrTail: string,
	port: number,
): Error {
	if (isAddressInUse(stderrTail)) {
		return new Error(
			`Le port ${port} est déjà utilisé par un autre programme, qui ne répond pas comme un backend WorkPilot. Arrêtez-le, puis relancez l'application.`,
		);
	}
	return new Error(`Le backend s'est arrêté au démarrage (code ${code}).`);
}

export interface SpawnedBackendWatch {
	/**
	 * Settles only when the spawned backend exits: resolves when another
	 * backend answers by then, rejects with the reason otherwise.
	 */
	exited: Promise<void>;
}

/**
 * Drains the child's output and watches its exit.
 *
 * @param answers whether a backend answers on the port now (briefly bounded)
 */
export function watchSpawnedBackend(
	child: ChildProcessWithoutNullStreams,
	port: number,
	answers: () => Promise<boolean>,
): SpawnedBackendWatch {
	let tail = "";
	child.stdout.on("data", () => undefined);
	child.stderr.on("data", (chunk: Buffer) => {
		tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
	});
	const exited = new Promise<void>((resolve, reject) => {
		child.once("exit", (code) => {
			void answers().then(
				(up) => (up ? resolve() : reject(backendExitError(code, tail, port))),
				() => reject(backendExitError(code, tail, port)),
			);
		});
	});
	return { exited };
}
