import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { debounce } from "../../../lib/debounce";
import { DEFAULT_TERMINAL_THEME } from "../../../lib/terminal-theme";
import type { TerminalFontSettings } from "../../../stores/terminal-font-settings-store";

interface LivePreviewTerminalProps {
	readonly settings: TerminalFontSettings;
}

/**
 * Sample terminal output to demonstrate font rendering
 * Includes ANSI color codes for realistic appearance
 */
const SAMPLE_OUTPUT = [
	"\x1b[1;32muser@hostname\x1b[0m:\x1b[1;34m~/project\x1b[0m$ \x1b[37mls -la\x1b[0m",
	"total 48",
	"\x1b[1;34mdrwxr-xr-x\x1b[0m  5 user  staff   160 Jan 15 10:30 \x1b[1;34msrc\x1b[0m",
	"\x1b[1;34mdrwxr-xr-x\x1b[0m  3 user  staff    96 Jan 15 10:30 \x1b[1;34mtests\x1b[0m",
	"-rw-r--r--  1 user  staff  2048 Jan 15 10:30 package.json",
	"-rw-r--r--  1 user  staff  1024 Jan 15 10:30 README.md",
	"",
	"\x1b[1;32muser@hostname\x1b[0m:\x1b[1;34m~/project\x1b[0m$ \x1b[37mgit status\x1b[0m",
	"On branch main",
	"Your branch is up to date with 'origin/main'.",
	"",
	"Changes not staged for commit:",
	"  \x1b[31mmodified:   src/App.tsx\x1b[0m",
	"  \x1b[32mnew file:   src/components/Header.tsx\x1b[0m",
	"",
	"\x1b[1;32muser@hostname\x1b[0m:\x1b[1;34m~/project\x1b[0m$ \x1b[37mnpm run dev\x1b[0m",
	"",
	"  \x1b[1mVITE\x1b[0m v5.0.0  \x1b[1mready in\x1b[0m \x1b[36m234 ms\x1b[0m",
	"",
	"  \x1b[1m➜\x1b[0m  \x1b[1mLocal:\x1b[0m   \x1b[1mhttp://localhost:3000/\x1b[0m",
	"  \x1b[1m➜\x1b[0m  \x1b[1m[network]\x1b[0m \x1b[1muse\x1b[0m \x1b[1m--host\x1b[0m \x1b[1mto expose\x1b[0m",
	"",
	"\x1b[1;32muser@hostname\x1b[0m:\x1b[1;34m~/project\x1b[0m$ \x1b[90m▊\x1b[0m",
].join("\r\n");

/**
 * LivePreviewTerminal component
 *
 * Renders a mock xterm.js terminal instance showing sample output.
 * Updates in real-time (300ms debounced) as font settings change.
 *
 * Features:
 * - Realistic terminal prompt and colored output
 * - Applies all font settings (family, size, weight, line height, letter spacing)
 * - Applies cursor settings (style, blink, accent color)
 * - Debounced updates prevent UI lag during slider drag
 * - Read-only terminal (no user input allowed)
 *
 * The instance is created once and then mutated: rebuilding it on every setting
 * change threw the sample output away and re-painted the whole panel on each
 * slider tick, which is exactly the drag the debounce exists to smooth out.
 */
export function LivePreviewTerminal({ settings }: LivePreviewTerminalProps) {
	const { t } = useTranslation("settings");
	const terminalRef = useRef<HTMLDivElement>(null);
	const xtermRef = useRef<XTerm | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);

	// Use a ref to hold current settings, avoiding stale closure in debounced function
	const settingsRef = useRef(settings);
	settingsRef.current = settings;

	// Create persistent debounced update function with cancel method
	const debouncedUpdateRef = useRef<ReturnType<typeof debounce> | null>(null);

	/**
	 * Initialize xterm.js instance on mount
	 * Creates terminal, applies the settings current at that moment, loads addons
	 */
	useEffect(() => {
		if (!terminalRef.current || xtermRef.current) {
			return;
		}

		const initialSettings = settingsRef.current;

		// Create xterm.js instance with current settings
		const xterm = new XTerm({
			cursorBlink: initialSettings.cursorBlink,
			cursorStyle: initialSettings.cursorStyle,
			fontSize: initialSettings.fontSize,
			fontFamily: initialSettings.fontFamily.join(", "),
			fontWeight: initialSettings.fontWeight,
			lineHeight: initialSettings.lineHeight,
			letterSpacing: initialSettings.letterSpacing,
			theme: {
				...DEFAULT_TERMINAL_THEME,
				cursorAccent: initialSettings.cursorAccentColor,
			},
			allowProposedApi: true,
			scrollback: 1000, // Fixed scrollback for preview
			disableStdin: true, // Read-only terminal
		});

		// Load addons
		const fitAddon = new FitAddon();
		xterm.loadAddon(fitAddon);

		// Open terminal in DOM
		xterm.open(terminalRef.current);

		// Write sample output
		xterm.write(SAMPLE_OUTPUT);

		// Store refs
		xtermRef.current = xterm;
		fitAddonRef.current = fitAddon;

		// Initial fit
		requestAnimationFrame(() => {
			if (fitAddonRef.current && terminalRef.current) {
				const rect = terminalRef.current.getBoundingClientRect();
				if (rect.width > 0 && rect.height > 0) {
					fitAddonRef.current.fit();
					// A fit that leaves fewer rows than the sample scrolls the first
					// command out of view; the preview should always start at the top.
					xterm.scrollToTop();
				}
			}
		});

		// Cleanup on unmount
		return () => {
			if (xtermRef.current) {
				xtermRef.current.dispose();
				xtermRef.current = null;
			}
			fitAddonRef.current = null;
		};
	}, []);

	/**
	 * Initialize the debounced update function once
	 * Uses settingsRef to avoid stale closure - reads current settings at execution time
	 * Cancels any pending debounced calls on unmount
	 */
	useEffect(() => {
		debouncedUpdateRef.current ??= debounce(() => {
			const xterm = xtermRef.current;
			if (!xterm) return;

			// Read from settingsRef.current to get current values, not closure values
			const currentSettings = settingsRef.current;

			// Update terminal options with current settings
			xterm.options.cursorBlink = currentSettings.cursorBlink;
			xterm.options.cursorStyle = currentSettings.cursorStyle;
			xterm.options.fontSize = currentSettings.fontSize;
			xterm.options.fontFamily = currentSettings.fontFamily.join(", ");
			xterm.options.fontWeight = currentSettings.fontWeight;
			xterm.options.lineHeight = currentSettings.lineHeight;
			xterm.options.letterSpacing = currentSettings.letterSpacing;
			xterm.options.theme = {
				...xterm.options.theme,
				cursorAccent: currentSettings.cursorAccentColor,
			};

			// Refresh terminal to apply visual changes
			xterm.refresh(0, xterm.rows - 1);

			// Fit terminal after options update
			if (fitAddonRef.current && terminalRef.current) {
				const rect = terminalRef.current.getBoundingClientRect();
				if (rect.width > 0 && rect.height > 0) {
					fitAddonRef.current.fit();
					xterm.scrollToTop();
				}
			}
		}, 300); // 300ms debounce

		// Cleanup: cancel any pending debounced call on unmount
		return () => {
			debouncedUpdateRef.current?.cancel();
			debouncedUpdateRef.current = null;
		};
	}, []);

	/**
	 * Push setting changes into the live instance
	 * Debounced to 300ms to prevent excessive updates during slider drag
	 */
	useEffect(() => {
		// Keep the ref the debounced callback reads in step with the render that
		// triggered it, and let `settings` be the dependency that fires this.
		settingsRef.current = settings;
		if (xtermRef.current && debouncedUpdateRef.current) {
			debouncedUpdateRef.current.fn();
		}
	}, [settings]);

	/**
	 * Handle container resize
	 * Fit terminal to container whenever the panel is resized
	 */
	useEffect(() => {
		if (!fitAddonRef.current || !terminalRef.current) return;

		const handleResize = debounce(() => {
			if (fitAddonRef.current && terminalRef.current) {
				const rect = terminalRef.current.getBoundingClientRect();
				if (rect.width > 0 && rect.height > 0) {
					fitAddonRef.current.fit();
				}
			}
		}, 100); // 100ms debounce for resize

		const resizeObserver = new ResizeObserver(handleResize.fn);
		resizeObserver.observe(terminalRef.current);

		return () => {
			resizeObserver.disconnect();
			handleResize.cancel(); // Cancel pending debounced resize calls
		};
	}, []);

	return (
		<div className="space-y-2">
			{/* Terminal container — padded so glyphs never touch the frame.
			    No min-width: the panel shares a grid column and must be able to
			    shrink instead of pushing the settings column off-screen. */}
			<div className="w-full overflow-hidden rounded-lg border border-border bg-[#0B0B0F] p-3">
				<section
					ref={terminalRef}
					className="h-[420px] w-full 2xl:h-[520px]"
					aria-label={t("terminalFonts.preview.ariaLabel", {
						defaultValue:
							"Terminal preview showing sample output with current font settings",
					})}
				/>
			</div>

			{/* Info text */}
			<p className="text-[11px] leading-relaxed text-muted-foreground">
				{t("terminalFonts.preview.infoText", {
					defaultValue:
						"Preview updates within 300ms of setting changes. This is a read-only terminal for demonstration purposes.",
				})}
			</p>
		</div>
	);
}
