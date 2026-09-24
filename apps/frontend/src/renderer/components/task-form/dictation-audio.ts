/** Capture mono PCM in memory, cutting on pauses so words usually stay together.
 * ScriptProcessor is used for Electron compatibility; output is always silence.
 */
export async function captureDictation(
	onChunk: (wav: ArrayBuffer) => void,
	onLevel: (level: number) => void,
	onEnded: () => void,
) {
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
		video: false,
	});
	let context!: AudioContext;
	let source: MediaStreamAudioSourceNode;
	let processor: ScriptProcessorNode;
	try {
		context = new AudioContext();
		await context.resume();
		source = context.createMediaStreamSource(stream);
		processor = context.createScriptProcessor(4096, 1, 1);
		source.connect(processor);
		processor.connect(context.destination);
	} catch (error) {
		stream.getTracks().forEach((track) => track.stop());
		void context?.close().catch(() => {
			/* Browser already closed the context. */
		});
		throw error;
	}
	let parts: Float32Array[] = [];
	let samples = 0;
	let quiet = 0;
	let voiced = false;
	let stopped = false;
	const flush = () => {
		if (voiced && samples) {
			const wav = new ArrayBuffer(44 + samples * 2);
			const view = new DataView(wav);
			const ascii = (offset: number, text: string) => {
				for (let i = 0; i < text.length; i++)
					view.setUint8(offset + i, text.charCodeAt(i));
			};
			ascii(0, "RIFF");
			view.setUint32(4, 36 + samples * 2, true);
			ascii(8, "WAVEfmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, context.sampleRate, true);
			view.setUint32(28, context.sampleRate * 2, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			ascii(36, "data");
			view.setUint32(40, samples * 2, true);
			let offset = 44;
			for (const part of parts)
				for (const sample of part) {
					view.setInt16(
						offset,
						Math.max(-1, Math.min(1, sample)) * 32767,
						true,
					);
					offset += 2;
				}
			onChunk(wav);
		}
		parts = [];
		samples = 0;
		quiet = 0;
		voiced = false;
	};
	processor.onaudioprocess = (event) => {
		if (stopped) return;
		const data = new Float32Array(event.inputBuffer.getChannelData(0));
		const rms = Math.sqrt(
			data.reduce((sum, value) => sum + value * value, 0) / data.length,
		);
		onLevel(Math.min(1, rms * 8));
		parts.push(data);
		samples += data.length;
		if (rms > 0.008) {
			voiced = true;
			quiet = 0;
		} else quiet += data.length;
		if (
			samples >= context.sampleRate * 20 ||
			(samples >= context.sampleRate * 2 && quiet >= context.sampleRate * 0.7)
		)
			flush();
	};
	stream
		.getAudioTracks()
		.forEach((track) => track.addEventListener("ended", onEnded));
	return (discard = false) => {
		if (stopped) return;
		stopped = true;
		processor.onaudioprocess = null;
		if (!discard) flush();
		parts = [];
		stream.getTracks().forEach((track) => {
			track.removeEventListener("ended", onEnded);
			track.stop();
		});
		source.disconnect();
		processor.disconnect();
		void context.close().catch(() => {
			/* Browser already closed the context. */
		});
	};
}
