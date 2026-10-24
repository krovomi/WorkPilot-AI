/**
 * Command lines that open a folder in a terminal or an IDE. The folder is
 * data: it reaches osascript as an argument and cmd.exe quoted, and what
 * quoting cannot protect is refused. No side effect, so any handler can
 * import it.
 */

/** What double quotes cannot neutralise once cmd.exe parses the line. */
const CMD_UNSAFE_CHARS = /["%\r\n]/;

/**
 * Arguments for `cmd.exe` to run a batch launcher (`code.cmd`…) on a
 * directory. Node refuses to spawn a `.cmd` without a shell, so cmd.exe parses
 * this line: the directory is quoted, and what quoting cannot protect (`"`,
 * `%`, line breaks) is refused. `null` when the line cannot be built safely.
 */
export function buildBatchLaunchArgs(
	command: string,
	dirPath: string,
): string[] | null {
	if (CMD_UNSAFE_CHARS.test(command) || CMD_UNSAFE_CHARS.test(dirPath)) {
		return null;
	}
	return ["/d", "/s", "/c", `"${command} "${dirPath}""`];
}

/**
 * Arguments for a `cmd.exe` console that stays open in `dirPath`. Without
 * `windowsVerbatimArguments`, Node leaves a path without spaces unquoted and
 * cmd.exe would run what follows a `&`: the path is quoted here, and what
 * quoting cannot protect is refused. `null` when the line cannot be built.
 */
export function buildCmdConsoleArgs(dirPath: string): string[] | null {
	if (CMD_UNSAFE_CHARS.test(dirPath)) return null;
	return ["/d", "/s", "/k", `"cd /d "${dirPath}""`];
}

/**
 * AppleScript that opens a terminal tab in `item 1 of argv`. The directory is
 * passed to osascript as an argument and quoted by `quoted form of`: it is
 * never part of the script's source.
 */
export function buildMacTerminalScript(terminal: "system" | "iterm2"): string {
	const cd = `"cd " & quoted form of (item 1 of argv)`;
	if (terminal === "iterm2") {
		return [
			"on run argv",
			'tell application "iTerm"',
			"create window with default profile",
			"tell current session of current window",
			`write text ${cd}`,
			"end tell",
			"end tell",
			"end run",
		].join("\n");
	}
	return [
		"on run argv",
		`tell application "Terminal" to do script ${cd}`,
		"end run",
	].join("\n");
}
