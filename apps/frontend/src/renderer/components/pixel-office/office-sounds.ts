/**
 * Office chimes.
 *
 * Upstream (pixel-agents) plays a sound when an agent finishes its turn or asks
 * for permission, and that is what makes a room worth leaving open on a second
 * monitor: it tells you when it needs you. WorkPilot has had the `soundEnabled`
 * toggle since the feature shipped, wired to nothing.
 *
 * The tones are synthesised rather than shipped as files. Three short notes do
 * not justify three binaries in the bundle, an asset path that has to resolve
 * the same way in dev, in the packaged app and on three platforms, or a decode
 * step that can fail after the moment it was needed. An oscillator and a gain
 * ramp are the whole implementation and they behave identically everywhere.
 */

/** One note of a chime. */
interface Note {
	/** Hz. */
	readonly freq: number;
	/** Seconds from the start of the chime. */
	readonly at: number;
	/** Seconds. */
	readonly duration: number;
}

/** Rising major third — "I need you". */
const NEEDS_INPUT: readonly Note[] = [
	{ freq: 660, at: 0, duration: 0.12 },
	{ freq: 880, at: 0.11, duration: 0.18 },
];

/** Settled perfect fifth — "that's done". */
const TURN_DONE: readonly Note[] = [
	{ freq: 523.25, at: 0, duration: 0.1 },
	{ freq: 784, at: 0.09, duration: 0.22 },
];

/** Falling minor second — "that went wrong". */
const FAILED: readonly Note[] = [
	{ freq: 415.3, at: 0, duration: 0.14 },
	{ freq: 311.1, at: 0.13, duration: 0.26 },
];

export type ChimeName = "needs-input" | "turn-done" | "failed";

const CHIMES: Record<ChimeName, readonly Note[]> = {
	"needs-input": NEEDS_INPUT,
	"turn-done": TURN_DONE,
	failed: FAILED,
};

/** Peak gain per note. Quiet on purpose — this plays while you work elsewhere. */
const PEAK_GAIN = 0.06;

/**
 * Shortest gap between two chimes, in ms.
 *
 * A swarm wave finishing lands a dozen `turn-done` transitions in the same tick.
 * Twelve overlapping chimes is a buzzer, not a notification, so the run is
 * announced once and the rest are dropped.
 */
const THROTTLE_MS = 700;

let context: AudioContext | null = null;
let lastPlayedAt = 0;

type AudioContextCtor = new () => AudioContext;

function getAudioContext(): AudioContext | null {
	if (context) return context;
	const Ctor = (
		globalThis as unknown as {
			AudioContext?: AudioContextCtor;
			webkitAudioContext?: AudioContextCtor;
		}
	).AudioContext;
	if (!Ctor) return null;
	try {
		context = new Ctor();
		return context;
	} catch {
		// No audio device, or the context limit is reached. The office is still
		// perfectly usable in silence.
		return null;
	}
}

function playNote(ctx: AudioContext, note: Note, startAt: number): void {
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = "triangle";
	osc.frequency.setValueAtTime(note.freq, startAt);

	// A square edge on a synthesised note is an audible click. Ramp both ends.
	gain.gain.setValueAtTime(0, startAt);
	gain.gain.linearRampToValueAtTime(PEAK_GAIN, startAt + 0.015);
	gain.gain.exponentialRampToValueAtTime(0.0001, startAt + note.duration);

	osc.connect(gain);
	gain.connect(ctx.destination);
	osc.start(startAt);
	osc.stop(startAt + note.duration + 0.02);
}

/**
 * Play one chime. No-op when audio is unavailable, or when another chime played
 * within the throttle window.
 */
export function playChime(name: ChimeName): void {
	const now = Date.now();
	if (now - lastPlayedAt < THROTTLE_MS) return;

	const ctx = getAudioContext();
	if (!ctx) return;

	// Autoplay policy suspends a context created before any user gesture. The
	// office is reached by clicking a sidebar item, so this resolves — but the
	// promise is deliberately not awaited: the note would land after the event
	// it announces.
	if (ctx.state === "suspended") {
		void ctx.resume().catch(() => {
			// Still blocked by the autoplay policy: silence, not an error.
		});
	}

	lastPlayedAt = now;
	const start = ctx.currentTime + 0.01;
	for (const note of CHIMES[name]) {
		playNote(ctx, note, start + note.at);
	}
}

/** Release the audio device. Called when the office view unmounts. */
export function closeChimes(): void {
	const ctx = context;
	context = null;
	lastPlayedAt = 0;
	void ctx?.close().catch(() => {
		// Already closed, or never opened. Nothing to release.
	});
}
