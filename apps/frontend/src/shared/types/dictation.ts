export type DictationResult = {
	ready?: boolean;
	text?: string;
	error?: string;
};
export interface DictationAPI {
	dictationStart: (
		sessionId: string,
		download: boolean,
		projectPath?: string,
	) => Promise<DictationResult>;
	dictationTranscribe: (
		sessionId: string,
		audio: ArrayBuffer,
		language: string,
	) => Promise<DictationResult>;
	dictationCancel: (sessionId: string) => Promise<void>;
}
