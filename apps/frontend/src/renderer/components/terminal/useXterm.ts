import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { debugError, debugLog } from "../../../shared/utils/debug-logger";
import { debounce } from "../../lib/debounce";
import {
	isLinux as checkIsLinux,
	isWindows as checkIsWindows,
} from "../../lib/os-detection";
import { terminalBufferManager } from "../../lib/terminal-buffer-manager";
import { DEFAULT_TERMINAL_THEME } from "../../lib/terminal-theme";
import { useTerminalFontSettingsStore } from "../../stores/terminal-font-settings-store";
import {
	registerOutputCallback,
	unregisterOutputCallback,
} from "../../stores/terminal-store";
import {
	attachOsc52Clipboard,
	createTerminalWebLinksAddon,
	handleClipboardKeyEvent,
} from "./terminal-interactions";

interface UseXtermOptions {
	terminalId: string;
	onCommandEnter?: (command: string) => void;
	onResize?: (cols: number, rows: number) => void;
	onDimensionsReady?: (cols: number, rows: number) => void;
}

/**
 * Return type for the useXterm hook.
 * Provides terminal control methods and state.
 */
export interface UseXtermReturn {
	/** Ref to attach to the terminal container div */
	terminalRef: React.RefObject<HTMLDivElement | null>;
	/** Ref to the xterm.js Terminal instance */
	xtermRef: React.MutableRefObject<XTerm | null>;
	/** Ref to the FitAddon instance */
	fitAddonRef: React.MutableRefObject<FitAddon | null>;
	/**
	 * Fit the terminal content to the container dimensions.
	 * @returns boolean indicating whether fit was successful (had valid dimensions)
	 */
	fit: () => boolean;
	/** Write data to the terminal */
	write: (data: string) => void;
	/** Write a line to the terminal */
	writeln: (data: string) => void;
	/** Focus the terminal */
	focus: () => void;
	/** Dispose of the terminal and clean up resources */
	dispose: () => void;
	/** Current number of columns */
	cols: number;
	/** Current number of rows */
	rows: number;
	/** Whether dimensions have been measured and are ready */
	dimensionsReady: boolean;
}

export function useXterm({
	terminalId,
	onCommandEnter,
	onResize,
	onDimensionsReady,
}: UseXtermOptions): UseXtermReturn {
	const terminalRef = useRef<HTMLDivElement>(null);
	const xtermRef = useRef<XTerm | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const serializeAddonRef = useRef<SerializeAddon | null>(null);
	const commandBufferRef = useRef<string>("");
	const isDisposedRef = useRef<boolean>(false);
	const dimensionsReadyCalledRef = useRef<boolean>(false);
	const [dimensions, setDimensions] = useState<{ cols: number; rows: number }>({
		cols: 80,
		rows: 24,
	});

	// Get font settings from store
	// Note: We subscribe to the entire store here for initial terminal creation.
	// The subscription effect below handles reactive updates for font changes.
	const fontSettings = useTerminalFontSettingsStore();

	// Initialize xterm.js UI
	useEffect(() => {
		if (!terminalRef.current || xtermRef.current) {
			debugLog(
				`[useXterm] Skipping xterm initialization for terminal: ${terminalId} - already initialized or container not ready`,
			);
			return;
		}

		// Reset refs when (re)initializing xterm
		// This is critical for React StrictMode which unmounts/remounts components,
		// causing dispose() to set isDisposedRef.current = true on the first unmount.
		// Without this reset, the remounted component would still have isDisposed = true.
		isDisposedRef.current = false;
		dimensionsReadyCalledRef.current = false;

		debugLog(`[useXterm] Initializing xterm for terminal: ${terminalId}`);

		const xterm = new XTerm({
			cursorBlink: fontSettings.cursorBlink,
			cursorStyle: fontSettings.cursorStyle,
			fontSize: fontSettings.fontSize,
			fontWeight: fontSettings.fontWeight,
			fontFamily: fontSettings.fontFamily.join(", "),
			lineHeight: fontSettings.lineHeight,
			letterSpacing: fontSettings.letterSpacing,
			theme: {
				...DEFAULT_TERMINAL_THEME,
				cursorAccent: fontSettings.cursorAccentColor,
			},
			allowProposedApi: true,
			scrollback: fontSettings.scrollback,
		});

		const fitAddon = new FitAddon();
		const webLinksAddon = createTerminalWebLinksAddon("useXterm");
		const serializeAddon = new SerializeAddon();

		xterm.loadAddon(fitAddon);
		xterm.loadAddon(webLinksAddon);
		xterm.loadAddon(serializeAddon);

		xterm.open(terminalRef.current);

		// OSC 52 : ce qu'un programme émet quand il propose lui-même de copier
		// (« (c to copy) »). Sans gestionnaire, la séquence est ignorée et rien
		// n'atteint le presse-papiers.
		attachOsc52Clipboard(xterm);

		// Platform detection for copy/paste shortcuts
		// Use existing os-detection module instead of custom implementation
		const platform = {
			isWindows: checkIsWindows(),
			isLinux: checkIsLinux(),
		};

		// Allow certain key combinations to bubble up to window-level handlers
		// This enables global shortcuts like Cmd/Ctrl+1-9 for project switching
		xterm.attachCustomKeyEventHandler((event) => {
			const isMod = event.metaKey || event.ctrlKey;

			// Handle SHIFT+Enter for multi-line input (send newline character)
			// This matches VS Code/Cursor behavior for multi-line input in Claude Code
			if (
				event.key === "Enter" &&
				event.shiftKey &&
				!isMod &&
				event.type === "keydown"
			) {
				// Send ESC + newline - same as OPTION+Enter which works for multi-line
				xterm.input("\x1b\n");
				return false; // Prevent default xterm handling
			}

			// Handle CMD+Backspace (Mac) or Ctrl+Backspace (Windows/Linux) to delete line
			// Sends Ctrl+U which is the terminal standard for "kill line backward"
			const isDeleteLine =
				event.key === "Backspace" && event.type === "keydown" && isMod;
			if (isDeleteLine) {
				xterm.input("\x15"); // Ctrl+U
				return false;
			}

			// Let Cmd/Ctrl + number keys pass through for project tab switching
			if (isMod && event.key >= "1" && event.key <= "9") {
				return false; // Don't handle in xterm, let it bubble up
			}

			// Let Cmd/Ctrl + Tab pass through for tab navigation
			if (isMod && event.key === "Tab") {
				return false;
			}

			// Let Cmd/Ctrl + T pass through for new terminal shortcut
			// Let Cmd/Ctrl + W pass through for close terminal shortcut
			if (
				isMod &&
				(event.key === "t" ||
					event.key === "T" ||
					event.key === "w" ||
					event.key === "W")
			) {
				return false;
			}

			// Copier / coller : une seule implémentation, partagée avec les
			// terminaux d'authentification (`terminal-interactions`). Elle rend
			// `undefined` quand la touche n'est pas un raccourci presse-papiers,
			// et c'est alors xterm qui la traite.
			const clipboardVerdict = handleClipboardKeyEvent(xterm, event, platform);
			if (clipboardVerdict !== undefined) {
				return clipboardVerdict;
			}

			// Handle all other keys in xterm
			return true;
		});

		xtermRef.current = xterm;
		fitAddonRef.current = fitAddon;
		serializeAddonRef.current = serializeAddon;

		// Use requestAnimationFrame to wait for layout, then fit
		// This is more reliable than a fixed timeout
		// Fallback to setTimeout for test environments where requestAnimationFrame may not be defined
		const raf =
			typeof requestAnimationFrame !== "undefined"
				? requestAnimationFrame
				: (cb: FrameRequestCallback) =>
						setTimeout(() => cb(Date.now()), 0) as unknown as number;

		const performInitialFit = () => {
			raf(() => {
				if (fitAddonRef.current && xtermRef.current && terminalRef.current) {
					// Check if container has valid dimensions
					const rect = terminalRef.current.getBoundingClientRect();
					if (rect.width > 0 && rect.height > 0) {
						fitAddonRef.current.fit();
						const cols = xtermRef.current.cols;
						const rows = xtermRef.current.rows;
						setDimensions({ cols, rows });
						// Call onDimensionsReady once when we have valid dimensions
						if (!dimensionsReadyCalledRef.current && cols > 0 && rows > 0) {
							dimensionsReadyCalledRef.current = true;
							debugLog(
								`[useXterm] Dimensions ready for terminal: ${terminalId}, cols: ${cols}, rows: ${rows}, containerWidth: ${rect.width}, containerHeight: ${rect.height}`,
							);
							onDimensionsReady?.(cols, rows);
						}
					} else {
						// Container not ready yet, retry after a short delay
						setTimeout(performInitialFit, 50);
					}
				}
			});
		};
		performInitialFit();

		// Replay buffered output if this is a remount or restored session
		// This now includes ANSI codes for proper formatting/colors/prompt
		// Use atomic getAndClear to prevent race condition where new output could arrive between get() and clear()
		const bufferedOutput = terminalBufferManager.getAndClear(terminalId);
		if (bufferedOutput && bufferedOutput.length > 0) {
			debugLog(
				`[useXterm] Replaying buffered output for terminal: ${terminalId}, buffer size: ${bufferedOutput.length} chars`,
			);
			xterm.write(bufferedOutput);
			debugLog(
				`[useXterm] Buffer replay complete and cleared for terminal: ${terminalId}`,
			);
		} else {
			debugLog(
				`[useXterm] No buffered output to replay for terminal: ${terminalId}`,
			);
		}

		// Handle terminal input
		xterm.onData((data) => {
			window.electronAPI.sendTerminalInput(terminalId, data);

			// Track commands for auto-naming
			if (data === "\r" || data === "\n") {
				const command = commandBufferRef.current;
				commandBufferRef.current = "";
				if (onCommandEnter) {
					onCommandEnter(command);
				}
			} else if (data === "\x7f" || data === "\b") {
				commandBufferRef.current = commandBufferRef.current.slice(0, -1);
			} else if (data === "\x03") {
				commandBufferRef.current = "";
			} else if (data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
				commandBufferRef.current += data;
			}
		});

		// Handle resize
		xterm.onResize(({ cols, rows }) => {
			if (onResize) {
				onResize(cols, rows);
			}
		});

		return () => {
			// Cleanup handled by parent component
		};
	}, [
		terminalId,
		onCommandEnter,
		onResize,
		onDimensionsReady,
		fontSettings.cursorAccentColor,
		fontSettings.cursorBlink,
		fontSettings.cursorStyle,
		fontSettings.fontFamily.join,
		fontSettings.fontSize,
		fontSettings.fontWeight,
		fontSettings.letterSpacing,
		fontSettings.lineHeight,
		fontSettings.scrollback,
	]);

	// Subscribe to font settings changes and update terminal reactively
	// This effect runs after xterm is created and re-runs when terminalId changes,
	// ensuring the subscription always uses the latest xterm instance
	useEffect(() => {
		const xterm = xtermRef.current;
		if (!xterm) return;

		// Update terminal options when font settings change
		const updateTerminalOptions = (
			settings: ReturnType<typeof useTerminalFontSettingsStore.getState>,
		) => {
			xterm.options.cursorBlink = settings.cursorBlink;
			xterm.options.cursorStyle = settings.cursorStyle;
			xterm.options.fontSize = settings.fontSize;
			xterm.options.fontWeight = settings.fontWeight;
			xterm.options.fontFamily = settings.fontFamily.join(", ");
			xterm.options.lineHeight = settings.lineHeight;
			xterm.options.letterSpacing = settings.letterSpacing;
			xterm.options.theme = {
				...xterm.options.theme,
				cursorAccent: settings.cursorAccentColor,
			};
			xterm.options.scrollback = settings.scrollback;

			// Refresh terminal to apply visual changes
			xterm.refresh(0, xterm.rows - 1);
		};

		// Subscribe to store changes - when terminalId changes, this effect re-runs,
		// cleaning up the old subscription and creating a new one for the new xterm instance
		const unsubscribe = useTerminalFontSettingsStore.subscribe(() => {
			// Get latest settings from store
			const latestSettings = useTerminalFontSettingsStore.getState();

			// Update terminal options with latest settings
			updateTerminalOptions(latestSettings);
		});

		return unsubscribe;
	}, []); // Only terminalId needed - re-subscribe when terminal changes

	// Register xterm write callback with terminal-store for global output listener
	// This allows the global listener to write directly to xterm when terminal is visible
	useEffect(() => {
		// Only register if xterm is ready
		if (!xtermRef.current) {
			debugLog(
				`[useXterm] Skipping output callback registration for terminal: ${terminalId} - xterm not ready`,
			);
			return;
		}

		debugLog(
			`[useXterm] Registering output callback for terminal: ${terminalId}`,
		);

		// Create a write function that writes directly to this xterm instance
		const writeCallback = (data: string) => {
			if (xtermRef.current && !isDisposedRef.current) {
				xtermRef.current.write(data);
			}
		};

		// Register the callback so global listener can write to this terminal
		registerOutputCallback(terminalId, writeCallback);

		// Cleanup: unregister callback when component unmounts
		return () => {
			debugLog(
				`[useXterm] Unregistering output callback for terminal: ${terminalId}`,
			);
			unregisterOutputCallback(terminalId);
		};
	}, [terminalId]);

	// Handle resize on container resize with debouncing
	useEffect(() => {
		const handleResize = debounce(() => {
			if (fitAddonRef.current && xtermRef.current && terminalRef.current) {
				// Check if container has valid dimensions before fitting
				const rect = terminalRef.current.getBoundingClientRect();
				if (rect.width > 0 && rect.height > 0) {
					fitAddonRef.current.fit();
					const cols = xtermRef.current.cols;
					const rows = xtermRef.current.rows;
					setDimensions({ cols, rows });
					// Notify when dimensions become valid (for late PTY creation)
					if (!dimensionsReadyCalledRef.current && cols > 0 && rows > 0) {
						dimensionsReadyCalledRef.current = true;
						onDimensionsReady?.(cols, rows);
					}
				}
			}
		}, 200); // 200ms debounce for xterm.js resize stability (recommended minimum)

		// Observe the terminalRef directly (not parent) for accurate resize detection
		const container = terminalRef.current;
		if (container) {
			const resizeObserver = new ResizeObserver(handleResize.fn);
			resizeObserver.observe(container);
			return () => {
				// Cancel any pending debounced call before disconnecting
				handleResize.cancel();
				resizeObserver.disconnect();
			};
		}
	}, [onDimensionsReady]);

	// Listen for terminal refit events (triggered after drag-drop reorder)
	useEffect(() => {
		const handleRefitAll = () => {
			if (fitAddonRef.current && xtermRef.current && terminalRef.current) {
				const rect = terminalRef.current.getBoundingClientRect();
				if (rect.width > 0 && rect.height > 0) {
					fitAddonRef.current.fit();
					const cols = xtermRef.current.cols;
					const rows = xtermRef.current.rows;
					setDimensions({ cols, rows });
				}
			}
		};

		window.addEventListener("terminal-refit-all", handleRefitAll);
		return () =>
			window.removeEventListener("terminal-refit-all", handleRefitAll);
	}, []);

	/**
	 * Fit the terminal content to the container dimensions.
	 * @returns boolean indicating whether fit was successful (had valid dimensions)
	 */
	const fit = useCallback((): boolean => {
		if (fitAddonRef.current && xtermRef.current && terminalRef.current) {
			// Validate container has valid dimensions before fitting
			const rect = terminalRef.current.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				fitAddonRef.current.fit();
				const cols = xtermRef.current.cols;
				const rows = xtermRef.current.rows;
				setDimensions({ cols, rows });
				return true;
			}
		}
		return false;
	}, []);

	const write = useCallback((data: string) => {
		if (xtermRef.current) {
			xtermRef.current.write(data);
		}
	}, []);

	const writeln = useCallback((data: string) => {
		if (xtermRef.current) {
			xtermRef.current.writeln(data);
		}
	}, []);

	const focus = useCallback(() => {
		if (xtermRef.current) {
			xtermRef.current.focus();
		}
	}, []);

	/**
	 * Serialize the terminal buffer before disposal.
	 * This preserves ANSI escape codes for colors, formatting, and the prompt.
	 */
	const serializeBuffer = useCallback(() => {
		if (xtermRef.current && serializeAddonRef.current) {
			try {
				debugLog(`[useXterm] Serializing buffer for terminal: ${terminalId}`);
				const serialized = serializeAddonRef.current.serialize();
				if (serialized && serialized.length > 0) {
					terminalBufferManager.set(terminalId, serialized);
					debugLog(
						`[useXterm] Buffer serialized for terminal: ${terminalId}, size: ${serialized.length} chars`,
					);
				} else {
					debugLog(
						`[useXterm] No content to serialize for terminal: ${terminalId}`,
					);
				}
			} catch (error) {
				debugError("[useXterm] Failed to serialize terminal buffer:", error);
			}
		} else {
			debugLog(
				`[useXterm] Cannot serialize buffer for terminal: ${terminalId} - xterm or serializeAddon not available`,
			);
		}
	}, [terminalId]);

	const dispose = useCallback(() => {
		// Guard against double dispose (can happen in React StrictMode or rapid unmount)
		if (isDisposedRef.current) {
			debugLog(
				`[useXterm] Skipping dispose for terminal: ${terminalId} - already disposed`,
			);
			return;
		}
		debugLog(`[useXterm] Disposing xterm for terminal: ${terminalId}`);
		isDisposedRef.current = true;

		// Serialize buffer before disposing to preserve ANSI formatting
		serializeBuffer();

		// Dispose addons explicitly before disposing xterm
		// While xterm.dispose() handles loaded addons, explicit disposal ensures
		// resources are freed in a predictable order and prevents potential leaks
		if (fitAddonRef.current) {
			fitAddonRef.current.dispose();
			fitAddonRef.current = null;
		}
		if (serializeAddonRef.current) {
			serializeAddonRef.current.dispose();
			serializeAddonRef.current = null;
		}
		// Note: webLinksAddon is local and will be disposed when xterm.dispose() is called
		if (xtermRef.current) {
			xtermRef.current.dispose();
			xtermRef.current = null;
		}
	}, [serializeBuffer, terminalId]);

	return {
		terminalRef,
		xtermRef,
		fitAddonRef,
		fit,
		write,
		writeln,
		focus,
		dispose,
		cols: dimensions.cols,
		rows: dimensions.rows,
		dimensionsReady: dimensionsReadyCalledRef.current,
	};
}
