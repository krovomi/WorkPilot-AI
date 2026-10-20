/** Only the main application frame may request audio, never a preview or camera. */
export function canUseDictationMicrophone(
	permission: string,
	isMainWindow: boolean,
	isMainFrame: boolean | undefined,
	mediaTypes: readonly string[] | undefined,
): boolean {
	return (
		permission === "media" &&
		isMainWindow &&
		isMainFrame === true &&
		mediaTypes?.length === 1 &&
		mediaTypes[0] === "audio"
	);
}
