/**
 * Detecting the IDEs and terminals installed on this machine, and opening a
 * worktree in one of them. Split out of worktree-handlers.ts (audit lot L11, F36).
 */

import { exec, execFile, spawn } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { shell } from "electron";
import type { SupportedIDE, SupportedTerminal } from "../../../shared/types";
import { getCurrentOS } from "../../platform";
import { isPathWithinBase } from "../../worktree-paths";
import {
	buildBatchLaunchArgs,
	buildCmdConsoleArgs,
	buildMacTerminalScript,
} from "./launch-args";

export const execAsync = promisify(exec);

export const execFileAsync = promisify(execFile);

/**
 * IDE and Terminal detection and launching utilities
 */
export interface DetectedTool {
	id: string;
	name: string;
	path: string;
	installed: boolean;
}

export interface DetectedTools {
	ides: DetectedTool[];
	terminals: DetectedTool[];
}

// IDE detection paths (macOS, Windows, Linux)
// Comprehensive detection for 50+ IDEs and editors
export const IDE_DETECTION: Partial<
	Record<
		SupportedIDE,
		{
			name: string;
			paths: Record<string, string[]>;
			commands: Record<string, string>;
		}
	>
> = {
	// Microsoft/VS Code Ecosystem
	vscode: {
		name: "Visual Studio Code",
		paths: {
			darwin: ["/Applications/Visual Studio Code.app"],
			win32: [
				"C:\\Program Files\\Microsoft VS Code\\Code.exe",
				"C:\\Users\\%USERNAME%\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
			],
			linux: ["/usr/share/code", "/snap/bin/code", "/usr/bin/code"],
		},
		commands: { darwin: "code", win32: "code.cmd", linux: "code" },
	},
	visualstudio: {
		name: "Visual Studio",
		paths: {
			darwin: [],
			win32: [
				"C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.exe",
				"C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\IDE\\devenv.exe",
				"C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\IDE\\devenv.exe",
			],
			linux: [],
		},
		commands: { darwin: "", win32: "devenv", linux: "" },
	},
	vscodium: {
		name: "VSCodium",
		paths: {
			darwin: ["/Applications/VSCodium.app"],
			win32: [
				"C:\\Program Files\\VSCodium\\VSCodium.exe",
				"C:\\Users\\%USERNAME%\\AppData\\Local\\Programs\\VSCodium\\VSCodium.exe",
			],
			linux: ["/usr/bin/codium", "/snap/bin/codium"],
		},
		commands: { darwin: "codium", win32: "codium", linux: "codium" },
	},
	// AI-Powered Editors
	cursor: {
		name: "Cursor",
		paths: {
			darwin: ["/Applications/Cursor.app"],
			win32: [
				"C:\\Users\\%USERNAME%\\AppData\\Local\\Programs\\cursor\\Cursor.exe",
			],
			linux: ["/usr/bin/cursor", "/opt/Cursor/cursor"],
		},
		commands: { darwin: "cursor", win32: "cursor.cmd", linux: "cursor" },
	},
	windsurf: {
		name: "Windsurf",
		paths: {
			darwin: ["/Applications/Windsurf.app"],
			win32: [
				"C:\\Users\\%USERNAME%\\AppData\\Local\\Programs\\Windsurf\\Windsurf.exe",
			],
			linux: ["/usr/bin/windsurf", "/opt/Windsurf/windsurf"],
		},
		commands: { darwin: "windsurf", win32: "windsurf.cmd", linux: "windsurf" },
	},
	zed: {
		name: "Zed",
		paths: {
			darwin: ["/Applications/Zed.app"],
			win32: [],
			linux: ["/usr/bin/zed", "~/.local/bin/zed"],
		},
		commands: { darwin: "zed", win32: "", linux: "zed" },
	},
	void: {
		name: "Void",
		paths: {
			darwin: ["/Applications/Void.app"],
			win32: [
				"C:\\Users\\%USERNAME%\\AppData\\Local\\Programs\\Void\\Void.exe",
			],
			linux: ["/usr/bin/void"],
		},
		commands: { darwin: "void", win32: "void", linux: "void" },
	},
	// JetBrains IDEs
	intellij: {
		name: "IntelliJ IDEA",
		paths: {
			darwin: [
				"/Applications/IntelliJ IDEA.app",
				"/Applications/IntelliJ IDEA CE.app",
			],
			win32: ["C:\\Program Files\\JetBrains\\IntelliJ IDEA*\\bin\\idea64.exe"],
			linux: [
				"/usr/bin/idea",
				"/snap/bin/intellij-idea-ultimate",
				"/snap/bin/intellij-idea-community",
			],
		},
		commands: { darwin: "idea", win32: "idea64.exe", linux: "idea" },
	},
	pycharm: {
		name: "PyCharm",
		paths: {
			darwin: ["/Applications/PyCharm.app", "/Applications/PyCharm CE.app"],
			win32: ["C:\\Program Files\\JetBrains\\PyCharm*\\bin\\pycharm64.exe"],
			linux: [
				"/usr/bin/pycharm",
				"/snap/bin/pycharm-professional",
				"/snap/bin/pycharm-community",
			],
		},
		commands: { darwin: "pycharm", win32: "pycharm64.exe", linux: "pycharm" },
	},
	webstorm: {
		name: "WebStorm",
		paths: {
			darwin: ["/Applications/WebStorm.app"],
			win32: ["C:\\Program Files\\JetBrains\\WebStorm*\\bin\\webstorm64.exe"],
			linux: ["/usr/bin/webstorm", "/snap/bin/webstorm"],
		},
		commands: {
			darwin: "webstorm",
			win32: "webstorm64.exe",
			linux: "webstorm",
		},
	},
	phpstorm: {
		name: "PhpStorm",
		paths: {
			darwin: ["/Applications/PhpStorm.app"],
			win32: ["C:\\Program Files\\JetBrains\\PhpStorm*\\bin\\phpstorm64.exe"],
			linux: ["/usr/bin/phpstorm", "/snap/bin/phpstorm"],
		},
		commands: {
			darwin: "phpstorm",
			win32: "phpstorm64.exe",
			linux: "phpstorm",
		},
	},
	rubymine: {
		name: "RubyMine",
		paths: {
			darwin: ["/Applications/RubyMine.app"],
			win32: ["C:\\Program Files\\JetBrains\\RubyMine*\\bin\\rubymine64.exe"],
			linux: ["/usr/bin/rubymine", "/snap/bin/rubymine"],
		},
		commands: {
			darwin: "rubymine",
			win32: "rubymine64.exe",
			linux: "rubymine",
		},
	},
	goland: {
		name: "GoLand",
		paths: {
			darwin: ["/Applications/GoLand.app"],
			win32: ["C:\\Program Files\\JetBrains\\GoLand*\\bin\\goland64.exe"],
			linux: ["/usr/bin/goland", "/snap/bin/goland"],
		},
		commands: { darwin: "goland", win32: "goland64.exe", linux: "goland" },
	},
	clion: {
		name: "CLion",
		paths: {
			darwin: ["/Applications/CLion.app"],
			win32: ["C:\\Program Files\\JetBrains\\CLion*\\bin\\clion64.exe"],
			linux: ["/usr/bin/clion", "/snap/bin/clion"],
		},
		commands: { darwin: "clion", win32: "clion64.exe", linux: "clion" },
	},
	rider: {
		name: "Rider",
		paths: {
			darwin: ["/Applications/Rider.app"],
			win32: ["C:\\Program Files\\JetBrains\\Rider*\\bin\\rider64.exe"],
			linux: ["/usr/bin/rider", "/snap/bin/rider"],
		},
		commands: { darwin: "rider", win32: "rider64.exe", linux: "rider" },
	},
	datagrip: {
		name: "DataGrip",
		paths: {
			darwin: ["/Applications/DataGrip.app"],
			win32: ["C:\\Program Files\\JetBrains\\DataGrip*\\bin\\datagrip64.exe"],
			linux: ["/usr/bin/datagrip", "/snap/bin/datagrip"],
		},
		commands: {
			darwin: "datagrip",
			win32: "datagrip64.exe",
			linux: "datagrip",
		},
	},
	fleet: {
		name: "Fleet",
		paths: {
			darwin: ["/Applications/Fleet.app"],
			win32: [
				"C:\\Users\\%USERNAME%\\AppData\\Local\\JetBrains\\Toolbox\\apps\\Fleet\\ch-0\\*\\Fleet.exe",
			],
			linux: ["~/.local/share/JetBrains/Toolbox/apps/Fleet/ch-0/*/fleet"],
		},
		commands: { darwin: "fleet", win32: "fleet", linux: "fleet" },
	},
	androidstudio: {
		name: "Android Studio",
		paths: {
			darwin: ["/Applications/Android Studio.app"],
			win32: ["C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe"],
			linux: [
				"/usr/bin/android-studio",
				"/snap/bin/android-studio",
				"/opt/android-studio/bin/studio.sh",
			],
		},
		commands: {
			darwin: "studio",
			win32: "studio64.exe",
			linux: "android-studio",
		},
	},
	rustrover: {
		name: "RustRover",
		paths: {
			darwin: ["/Applications/RustRover.app"],
			win32: ["C:\\Program Files\\JetBrains\\RustRover*\\bin\\rustrover64.exe"],
			linux: ["/usr/bin/rustrover", "/snap/bin/rustrover"],
		},
		commands: {
			darwin: "rustrover",
			win32: "rustrover64.exe",
			linux: "rustrover",
		},
	},
	// Classic Text Editors
	sublime: {
		name: "Sublime Text",
		paths: {
			darwin: ["/Applications/Sublime Text.app"],
			win32: [
				"C:\\Program Files\\Sublime Text\\subl.exe",
				"C:\\Program Files\\Sublime Text 3\\subl.exe",
			],
			linux: ["/usr/bin/subl", "/snap/bin/subl"],
		},
		commands: { darwin: "subl", win32: "subl.exe", linux: "subl" },
	},
	vim: {
		name: "Vim",
		paths: {
			darwin: ["/usr/bin/vim"],
			win32: ["C:\\Program Files\\Vim\\vim*\\vim.exe"],
			linux: ["/usr/bin/vim"],
		},
		commands: { darwin: "vim", win32: "vim", linux: "vim" },
	},
	neovim: {
		name: "Neovim",
		paths: {
			darwin: ["/usr/local/bin/nvim", "/opt/homebrew/bin/nvim"],
			win32: ["C:\\Program Files\\Neovim\\bin\\nvim.exe"],
			linux: ["/usr/bin/nvim", "/snap/bin/nvim"],
		},
		commands: { darwin: "nvim", win32: "nvim", linux: "nvim" },
	},
	emacs: {
		name: "Emacs",
		paths: {
			darwin: [
				"/Applications/Emacs.app",
				"/usr/local/bin/emacs",
				"/opt/homebrew/bin/emacs",
			],
			win32: ["C:\\Program Files\\Emacs\\bin\\emacs.exe"],
			linux: ["/usr/bin/emacs", "/snap/bin/emacs"],
		},
		commands: { darwin: "emacs", win32: "emacs", linux: "emacs" },
	},
	nano: {
		name: "GNU Nano",
		paths: {
			darwin: ["/usr/bin/nano"],
			win32: [],
			linux: ["/usr/bin/nano"],
		},
		commands: { darwin: "nano", win32: "", linux: "nano" },
	},
	helix: {
		name: "Helix",
		paths: {
			darwin: ["/opt/homebrew/bin/hx", "/usr/local/bin/hx"],
			win32: ["C:\\Program Files\\Helix\\hx.exe"],
			linux: ["/usr/bin/hx", "~/.cargo/bin/hx"],
		},
		commands: { darwin: "hx", win32: "hx", linux: "hx" },
	},
	// Platform-Specific IDEs
	xcode: {
		name: "Xcode",
		paths: {
			darwin: ["/Applications/Xcode.app"],
			win32: [],
			linux: [],
		},
		commands: { darwin: "xcode", win32: "", linux: "" },
	},
	eclipse: {
		name: "Eclipse",
		paths: {
			darwin: ["/Applications/Eclipse.app"],
			win32: [
				"C:\\eclipse\\eclipse.exe",
				"C:\\Program Files\\Eclipse\\eclipse.exe",
			],
			linux: ["/usr/bin/eclipse", "/snap/bin/eclipse"],
		},
		commands: { darwin: "eclipse", win32: "eclipse", linux: "eclipse" },
	},
	netbeans: {
		name: "NetBeans",
		paths: {
			darwin: [
				"/Applications/NetBeans.app",
				"/Applications/Apache NetBeans.app",
			],
			win32: ["C:\\Program Files\\NetBeans*\\bin\\netbeans64.exe"],
			linux: ["/usr/bin/netbeans", "/snap/bin/netbeans"],
		},
		commands: {
			darwin: "netbeans",
			win32: "netbeans64.exe",
			linux: "netbeans",
		},
	},
	// macOS Editors
	nova: {
		name: "Nova",
		paths: {
			darwin: ["/Applications/Nova.app"],
			win32: [],
			linux: [],
		},
		commands: { darwin: "nova", win32: "", linux: "" },
	},
	bbedit: {
		name: "BBEdit",
		paths: {
			darwin: ["/Applications/BBEdit.app"],
			win32: [],
			linux: [],
		},
		commands: { darwin: "bbedit", win32: "", linux: "" },
	},
	textmate: {
		name: "TextMate",
		paths: {
			darwin: ["/Applications/TextMate.app"],
			win32: [],
			linux: [],
		},
		commands: { darwin: "mate", win32: "", linux: "" },
	},
	// Windows Editors
	notepadpp: {
		name: "Notepad++",
		paths: {
			darwin: [],
			win32: [
				"C:\\Program Files\\Notepad++\\notepad++.exe",
				"C:\\Program Files (x86)\\Notepad++\\notepad++.exe",
			],
			linux: [],
		},
		commands: { darwin: "", win32: "notepad++", linux: "" },
	},
	// Linux Editors
	kate: {
		name: "Kate",
		paths: {
			darwin: [],
			win32: [],
			linux: ["/usr/bin/kate", "/snap/bin/kate"],
		},
		commands: { darwin: "", win32: "", linux: "kate" },
	},
	gedit: {
		name: "gedit",
		paths: {
			darwin: [],
			win32: [],
			linux: ["/usr/bin/gedit", "/snap/bin/gedit"],
		},
		commands: { darwin: "", win32: "", linux: "gedit" },
	},
	geany: {
		name: "Geany",
		paths: {
			darwin: [],
			win32: [],
			linux: ["/usr/bin/geany"],
		},
		commands: { darwin: "", win32: "", linux: "geany" },
	},
	lapce: {
		name: "Lapce",
		paths: {
			darwin: ["/Applications/Lapce.app"],
			win32: ["C:\\Users\\%USERNAME%\\AppData\\Local\\lapce\\Lapce.exe"],
			linux: ["/usr/bin/lapce", "~/.cargo/bin/lapce"],
		},
		commands: { darwin: "lapce", win32: "lapce", linux: "lapce" },
	},
	custom: {
		name: "Custom IDE",
		paths: { darwin: [], win32: [], linux: [] },
		commands: { darwin: "", win32: "", linux: "" },
	},
};

// Terminal detection paths (macOS, Windows, Linux)
// Comprehensive detection for 30+ terminal emulators
export const TERMINAL_DETECTION: Partial<
	Record<
		SupportedTerminal,
		{
			name: string;
			paths: Record<string, string[]>;
			commands: Record<string, string[]>;
		}
	>
> = {
	// System Defaults
	system: {
		name: "System Terminal",
		paths: {
			darwin: ["/System/Applications/Utilities/Terminal.app"],
			win32: [],
			linux: [],
		},
		commands: {
			darwin: ["open", "-a", "Terminal"],
			win32: ["cmd.exe", "/c", "start", "cmd.exe", "/K", "cd", "/d"],
			linux: ["x-terminal-emulator", "-e", "bash", "-c"],
		},
	},
	// macOS Terminals
	terminal: {
		name: "Terminal.app",
		paths: {
			darwin: ["/System/Applications/Utilities/Terminal.app"],
			win32: [],
			linux: [],
		},
		commands: { darwin: ["open", "-a", "Terminal"], win32: [], linux: [] },
	},
	iterm2: {
		name: "iTerm2",
		paths: { darwin: ["/Applications/iTerm.app"], win32: [], linux: [] },
		commands: { darwin: ["open", "-a", "iTerm"], win32: [], linux: [] },
	},
	warp: {
		name: "Warp",
		paths: {
			darwin: ["/Applications/Warp.app"],
			win32: [],
			linux: ["/usr/bin/warp-terminal"],
		},
		commands: {
			darwin: ["open", "-a", "Warp"],
			win32: [],
			linux: ["warp-terminal"],
		},
	},
	ghostty: {
		name: "Ghostty",
		paths: {
			darwin: ["/Applications/Ghostty.app"],
			win32: [],
			linux: ["/usr/bin/ghostty"],
		},
		commands: {
			darwin: ["open", "-a", "Ghostty"],
			win32: [],
			linux: ["ghostty"],
		},
	},
	rio: {
		name: "Rio",
		paths: {
			darwin: ["/Applications/Rio.app"],
			win32: [],
			linux: ["/usr/bin/rio"],
		},
		commands: { darwin: ["open", "-a", "Rio"], win32: [], linux: ["rio"] },
	},
	// Windows Terminals
	windowsterminal: {
		name: "Windows Terminal",
		paths: {
			darwin: [],
			win32: [
				"C:\\Users\\%USERNAME%\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
			],
			linux: [],
		},
		commands: { darwin: [], win32: ["wt.exe", "-d"], linux: [] },
	},
	powershell: {
		name: "PowerShell",
		paths: {
			darwin: [],
			win32: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
			linux: [],
		},
		commands: {
			darwin: [],
			win32: ["powershell.exe", "-NoExit", "-Command", "cd"],
			linux: [],
		},
	},
	cmd: {
		name: "Command Prompt",
		paths: { darwin: [], win32: ["C:\\Windows\\System32\\cmd.exe"], linux: [] },
		commands: { darwin: [], win32: ["cmd.exe", "/K", "cd", "/d"], linux: [] },
	},
	conemu: {
		name: "ConEmu",
		paths: {
			darwin: [],
			win32: [
				"C:\\Program Files\\ConEmu\\ConEmu64.exe",
				"C:\\Program Files (x86)\\ConEmu\\ConEmu.exe",
			],
			linux: [],
		},
		commands: { darwin: [], win32: ["ConEmu64.exe", "-Dir"], linux: [] },
	},
	cmder: {
		name: "Cmder",
		paths: {
			darwin: [],
			win32: ["C:\\cmder\\Cmder.exe", "C:\\tools\\cmder\\Cmder.exe"],
			linux: [],
		},
		commands: { darwin: [], win32: ["Cmder.exe", "/START"], linux: [] },
	},
	gitbash: {
		name: "Git Bash",
		paths: {
			darwin: [],
			win32: ["C:\\Program Files\\Git\\git-bash.exe"],
			linux: [],
		},
		commands: { darwin: [], win32: ["git-bash.exe", "--cd="], linux: [] },
	},
	// Linux Desktop Environment Terminals
	gnometerminal: {
		name: "GNOME Terminal",
		paths: { darwin: [], win32: [], linux: ["/usr/bin/gnome-terminal"] },
		commands: {
			darwin: [],
			win32: [],
			linux: ["gnome-terminal", "--working-directory="],
		},
	},
	konsole: {
		name: "Konsole",
		paths: { darwin: [], win32: [], linux: ["/usr/bin/konsole"] },
		commands: { darwin: [], win32: [], linux: ["konsole", "--workdir"] },
	},
	xfce4terminal: {
		name: "XFCE4 Terminal",
		paths: { darwin: [], win32: [], linux: ["/usr/bin/xfce4-terminal"] },
		commands: {
			darwin: [],
			win32: [],
			linux: ["xfce4-terminal", "--working-directory="],
		},
	},
	"mate-terminal": {
		name: "MATE Terminal",
		paths: { darwin: [], win32: [], linux: ["/usr/bin/mate-terminal"] },
		commands: {
			darwin: [],
			win32: [],
			linux: ["mate-terminal", "--working-directory="],
		},
	},
	// Linux Feature-rich Terminals
	terminator: {
		name: "Terminator",
		paths: { darwin: [], win32: [], linux: ["/usr/bin/terminator"] },
		commands: {
			darwin: [],
			win32: [],
			linux: ["terminator", "--working-directory="],
		},
	},
	tilix: {
		name: "Tilix",
		paths: { darwin: [], win32: [], linux: ["/usr/bin/tilix"] },
		commands: {
			darwin: [],
			win32: [],
			linux: ["tilix", "--working-directory="],
		},
	},
	guake: {
		name: "Guake",
		paths: { darwin: [], win32: [], linux: ["/usr/bin/guake"] },
		commands: { darwin: [], win32: [], linux: ["guake", "--show", "-n", "--"] },
	},
	yakuake: {
		name: "Yakuake",
		paths: { darwin: [], win32: [], linux: ["/usr/bin/yakuake"] },
		commands: { darwin: [], win32: [], linux: ["yakuake"] },
	},
	tilda: {
		name: "Tilda",
		paths: { darwin: [], win32: [], linux: ["/usr/bin/tilda"] },
		commands: { darwin: [], win32: [], linux: ["tilda"] },
	},
	// GPU-Accelerated Cross-platform Terminals
	alacritty: {
		name: "Alacritty",
		paths: {
			darwin: ["/Applications/Alacritty.app"],
			win32: [
				"C:\\Program Files\\Alacritty\\alacritty.exe",
				"C:\\Users\\%USERNAME%\\scoop\\apps\\alacritty\\current\\alacritty.exe",
			],
			linux: ["/usr/bin/alacritty", "/snap/bin/alacritty"],
		},
		commands: {
			darwin: ["open", "-a", "Alacritty", "--args", "--working-directory"],
			win32: ["alacritty.exe", "--working-directory"],
			linux: ["alacritty", "--working-directory"],
		},
	},
	kitty: {
		name: "Kitty",
		paths: {
			darwin: ["/Applications/kitty.app"],
			win32: [],
			linux: ["/usr/bin/kitty"],
		},
		commands: {
			darwin: ["open", "-a", "kitty", "--args", "--directory"],
			win32: [],
			linux: ["kitty", "--directory"],
		},
	},
	wezterm: {
		name: "WezTerm",
		paths: {
			darwin: ["/Applications/WezTerm.app"],
			win32: ["C:\\Program Files\\WezTerm\\wezterm-gui.exe"],
			linux: ["/usr/bin/wezterm", "/usr/bin/wezterm-gui"],
		},
		commands: {
			darwin: ["open", "-a", "WezTerm", "--args", "start", "--cwd"],
			win32: ["wezterm-gui.exe", "start", "--cwd"],
			linux: ["wezterm", "start", "--cwd"],
		},
	},
	// Cross-Platform Terminals
	hyper: {
		name: "Hyper",
		paths: {
			darwin: ["/Applications/Hyper.app"],
			win32: [
				"C:\\Users\\%USERNAME%\\AppData\\Local\\Programs\\Hyper\\Hyper.exe",
			],
			linux: ["/usr/bin/hyper", "/opt/Hyper/hyper"],
		},
		commands: {
			darwin: ["open", "-a", "Hyper"],
			win32: ["hyper.exe"],
			linux: ["hyper"],
		},
	},
	tabby: {
		name: "Tabby",
		paths: {
			darwin: ["/Applications/Tabby.app"],
			win32: [
				"C:\\Users\\%USERNAME%\\AppData\\Local\\Programs\\Tabby\\Tabby.exe",
			],
			linux: ["/usr/bin/tabby", "/opt/Tabby/tabby"],
		},
		commands: {
			darwin: ["open", "-a", "Tabby"],
			win32: ["Tabby.exe"],
			linux: ["tabby"],
		},
	},
	contour: {
		name: "Contour",
		paths: {
			darwin: ["/Applications/Contour.app"],
			win32: [],
			linux: ["/usr/bin/contour"],
		},
		commands: {
			darwin: ["open", "-a", "Contour"],
			win32: [],
			linux: ["contour"],
		},
	},
	// Minimal/Suckless Terminals
	xterm: {
		name: "xterm",
		paths: { darwin: [], win32: [], linux: ["/usr/bin/xterm"] },
		commands: { darwin: [], win32: [], linux: ["xterm", "-e", "cd"] },
	},
	urxvt: {
		name: "rxvt-unicode",
		paths: { darwin: [], win32: [], linux: ["/usr/bin/urxvt"] },
		commands: { darwin: [], win32: [], linux: ["urxvt", "-cd"] },
	},
	st: {
		name: "st (suckless)",
		paths: {
			darwin: [],
			win32: [],
			linux: ["/usr/local/bin/st", "/usr/bin/st"],
		},
		commands: { darwin: [], win32: [], linux: ["st", "-d"] },
	},
	foot: {
		name: "Foot",
		paths: { darwin: [], win32: [], linux: ["/usr/bin/foot"] },
		commands: {
			darwin: [],
			win32: [],
			linux: ["foot", "--working-directory="],
		},
	},
	// Specialty Terminals
	coolretroterm: {
		name: "cool-retro-term",
		paths: {
			darwin: ["/Applications/cool-retro-term.app"],
			win32: [],
			linux: ["/usr/bin/cool-retro-term"],
		},
		commands: {
			darwin: ["open", "-a", "cool-retro-term"],
			win32: [],
			linux: ["cool-retro-term"],
		},
	},
	// Multiplexers (commonly used as terminal environment)
	tmux: {
		name: "tmux",
		paths: {
			darwin: ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"],
			win32: [],
			linux: ["/usr/bin/tmux"],
		},
		commands: { darwin: ["tmux"], win32: [], linux: ["tmux"] },
	},
	zellij: {
		name: "Zellij",
		paths: {
			darwin: ["/opt/homebrew/bin/zellij", "/usr/local/bin/zellij"],
			win32: [],
			linux: ["/usr/bin/zellij", "~/.cargo/bin/zellij"],
		},
		commands: { darwin: ["zellij"], win32: [], linux: ["zellij"] },
	},
	custom: {
		name: "Custom Terminal",
		paths: { darwin: [], win32: [], linux: [] },
		commands: { darwin: [], win32: [], linux: [] },
	},
};

/**
 * Security helpers: the directory and the launcher both come from outside the
 * main process, so each is resolved before anything runs.
 */

function realpathOrNull(target: string): string | null {
	try {
		return realpathSync(target);
	} catch {
		return null;
	}
}

/**
 * The directory the renderer asks to open, resolved (symlinks included) and
 * accepted only if it is a directory inside one of the known projects
 * (worktrees and specs live under the project). `null` otherwise.
 */
export function resolveOpenableDir(
	dirPath: unknown,
	projectPaths: string[],
): string | null {
	if (typeof dirPath !== "string" || !path.isAbsolute(dirPath)) return null;
	const resolved = realpathOrNull(dirPath);
	if (!resolved) return null;
	try {
		if (!statSync(resolved).isDirectory()) return null;
	} catch {
		return null;
	}
	const inProject = projectPaths.some((projectPath) => {
		const base = realpathOrNull(projectPath);
		return base !== null && isPathWithinBase(resolved, base);
	});
	return inProject ? resolved : null;
}

/**
 * A custom IDE or terminal from the user's settings: an absolute path to an
 * existing file (or a macOS `.app` bundle), resolved. `null` otherwise.
 */
export function resolveCustomLauncher(customPath: unknown): string | null {
	if (typeof customPath !== "string" || !path.isAbsolute(customPath)) {
		return null;
	}
	const resolved = realpathOrNull(customPath);
	if (!resolved) return null;
	try {
		const stats = statSync(resolved);
		return stats.isFile() || resolved.endsWith(".app") ? resolved : null;
	} catch {
		return null;
	}
}

/**
 * Validate a detection path doesn't contain traversal after variable expansion
 */
export function isPathSafe(expandedPath: string): boolean {
	return !path.normalize(expandedPath).includes("..");
}


/**
 * Smart app detection using native OS APIs for faster, more comprehensive discovery
 */

// Cache for installed apps (refreshed on each detection call)
export let installedAppsCache: Set<string> = new Set();

/**
 * macOS: Use Spotlight (mdfind) to quickly find all installed .app bundles
 */
export async function detectMacApps(): Promise<Set<string>> {
	const apps = new Set<string>();
	try {
		// Use mdfind to query Spotlight for all applications - much faster than directory scanning
		// Timeout after 10 seconds to prevent hangs on systems with slow Spotlight indexing
		const { stdout } = await execAsync(
			'mdfind -onlyin /Applications "kMDItemKind == Application" 2>/dev/null | head -500',
			{ timeout: 10000 },
		);
		const appPaths = stdout
			.trim()
			.split("\n")
			.filter((p) => p);

		for (const appPath of appPaths) {
			// Extract app name from path (e.g., "/Applications/Visual Studio Code.app" -> "Visual Studio Code")
			const match = appPath.match(/\/([^/]+)\.app$/i);
			if (match) {
				apps.add(match[1].toLowerCase());
			}
		}
	} catch {
		// Fallback: scan /Applications directory
		try {
			const appDir = "/Applications";
			if (existsSync(appDir)) {
				const entries = readdirSync(appDir);
				for (const entry of entries) {
					if (entry.endsWith(".app")) {
						apps.add(entry.replace(".app", "").toLowerCase());
					}
				}
			}
		} catch {
			// Ignore errors
		}
	}
	return apps;
}

/**
 * Windows: Check registry and common installation paths
 */
export async function detectWindowsApps(): Promise<Set<string>> {
	const apps = new Set<string>();
	try {
		// Query registry for installed programs using PowerShell
		const { stdout } = await execAsync(
			`powershell -Command "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Select-Object DisplayName | ConvertTo-Json"`,
			{ timeout: 10000 },
		);
		const programs = JSON.parse(stdout);
		if (Array.isArray(programs)) {
			for (const prog of programs) {
				if (prog.DisplayName) {
					apps.add(prog.DisplayName.toLowerCase());
				}
			}
		}
	} catch {
		// Fallback: check common paths
		const commonPaths = [
			"C:\\Program Files",
			"C:\\Program Files (x86)",
			process.env.LOCALAPPDATA || "",
		];
		for (const basePath of commonPaths) {
			if (basePath && existsSync(basePath)) {
				try {
					const entries = readdirSync(basePath);
					for (const entry of entries) {
						apps.add(entry.toLowerCase());
					}
				} catch {
					// Ignore errors
				}
			}
		}
	}
	return apps;
}

/**
 * Linux: Parse .desktop files from standard locations for fast app discovery
 */
export async function detectLinuxApps(): Promise<Set<string>> {
	const apps = new Set<string>();
	const desktopDirs = [
		"/usr/share/applications",
		"/usr/local/share/applications",
		`${homedir()}/.local/share/applications`,
		"/var/lib/flatpak/exports/share/applications",
		"/var/lib/snapd/desktop/applications",
	];

	for (const dir of desktopDirs) {
		try {
			if (existsSync(dir)) {
				const files = readdirSync(dir);
				for (const file of files) {
					if (file.endsWith(".desktop")) {
						// Extract app name from .desktop filename
						const name = file.replace(".desktop", "").toLowerCase();
						apps.add(name);

						// Also try to read the Name= field from .desktop file for better matching
						try {
							const content = readFileSync(path.join(dir, file), "utf-8");
							const nameMatch = content.match(/^Name=(.+)$/m);
							if (nameMatch) {
								apps.add(nameMatch[1].toLowerCase());
							}
						} catch {
							// Ignore read errors
						}
					}
				}
			}
		} catch {
			// Ignore directory errors
		}
	}

	// Also check common binary paths
	const binPaths = ["/usr/bin", "/usr/local/bin", "/snap/bin"];
	for (const binPath of binPaths) {
		try {
			if (existsSync(binPath)) {
				const bins = readdirSync(binPath);
				for (const bin of bins) {
					apps.add(bin.toLowerCase());
				}
			}
		} catch {
			// Ignore errors
		}
	}

	return apps;
}

/**
 * Check if an app is installed using the cached app list + specific path checks
 */
export function isAppInstalled(
	appNames: string[],
	specificPaths: string[],
	_platform: string,
): { installed: boolean; foundPath: string } {
	// First, check the cached app list (fast)
	for (const name of appNames) {
		if (installedAppsCache.has(name.toLowerCase())) {
			return { installed: true, foundPath: "" };
		}
	}

	// Then check specific paths (for apps not in standard locations)
	for (const checkPath of specificPaths) {
		const expandedPath = checkPath
			.replace("%USERNAME%", process.env.USERNAME || process.env.USER || "")
			.replace("~", homedir());

		// Validate path doesn't contain traversal attempts after expansion
		if (!isPathSafe(expandedPath)) {
			console.warn("[detectTool] Skipping potentially unsafe path:", checkPath);
			continue;
		}

		// Handle glob patterns (e.g., JetBrains*) - just check if directory exists for base path
		const basePath = expandedPath.split("*")[0];
		if (
			existsSync(expandedPath) ||
			(basePath !== expandedPath && existsSync(basePath))
		) {
			return { installed: true, foundPath: expandedPath };
		}
	}

	return { installed: false, foundPath: "" };
}

/**
 * Detect installed IDEs and terminals on the system
 * Uses smart platform-native detection for faster results
 */
export async function detectInstalledTools(): Promise<DetectedTools> {
	const platform = getCurrentOS();
	const ides: DetectedTool[] = [];
	const terminals: DetectedTool[] = [];
	const _startTime = Date.now();

	if (platform === "darwin") {
		installedAppsCache = await detectMacApps();
	} else if (platform === "win32") {
		installedAppsCache = await detectWindowsApps();
	} else {
		installedAppsCache = await detectLinuxApps();
	}

	// Detect IDEs using cached app list + specific path checks
	for (const [id, config] of Object.entries(IDE_DETECTION)) {
		if (id === "custom" || !config) continue;

		const paths = config.paths[platform] || [];
		// Generate search names from the config name and id
		const searchNames = [
			config.name.toLowerCase(),
			id.toLowerCase(),
			// Handle common variations
			config.name
				.replace(/\s+/g, "")
				.toLowerCase(),
			config.name.replace(/\s+/g, "-").toLowerCase(),
		];

		const { installed, foundPath } = isAppInstalled(
			searchNames,
			paths,
			platform,
		);

		// Also try command check if not found via app detection
		let finalInstalled = installed;
		if (!finalInstalled && config.commands[platform]) {
			try {
				if (platform === "win32") {
					await execAsync(`where ${config.commands[platform]}`, {
						timeout: 2000,
					});
				} else {
					await execAsync(`which ${config.commands[platform]}`, {
						timeout: 2000,
					});
				}
				finalInstalled = true;
			} catch {
				// Command not found
			}
		}

		if (finalInstalled) {
			ides.push({
				id,
				name: config.name,
				path: foundPath,
				installed: true,
			});
		}
	}

	// Detect Terminals using cached app list + specific path checks
	for (const [id, config] of Object.entries(TERMINAL_DETECTION)) {
		if (id === "custom" || !config) continue;

		const paths = config.paths[platform] || [];
		const searchNames = [
			config.name.toLowerCase(),
			id.toLowerCase(),
			config.name.replace(/\s+/g, "").toLowerCase(),
		];

		const { installed, foundPath } = isAppInstalled(
			searchNames,
			paths,
			platform,
		);

		if (installed) {
			terminals.push({
				id,
				name: config.name,
				path: foundPath,
				installed: true,
			});
		}
	}

	// Always add system terminal as fallback
	if (!terminals.find((t) => t.id === "system")) {
		terminals.unshift({
			id: "system",
			name: "System Terminal",
			path: "",
			installed: true,
		});
	}
	return { ides, terminals };
}

/**
 * Open a directory in the specified IDE
 */
export async function openInIDE(
	dirPath: string,
	ide: SupportedIDE,
	customPath?: string,
): Promise<{ success: boolean; error?: string }> {
	const platform = getCurrentOS();

	try {
		if (ide === "custom") {
			const launcher = resolveCustomLauncher(customPath);
			if (!launcher) {
				return { success: false, error: "Invalid custom IDE path" };
			}
			await execFileAsync(launcher, [dirPath]);
			return { success: true };
		}

		const config = IDE_DETECTION[ide];
		if (!config) {
			return { success: false, error: `Unknown IDE: ${ide}` };
		}

		const command = config.commands[platform];
		if (!command) {
			return {
				success: false,
				error: `IDE ${ide} is not supported on ${platform}`,
			};
		}

		// Special handling for macOS .app bundles
		if (platform === "darwin") {
			const appPath = config.paths.darwin?.[0];
			if (appPath && existsSync(appPath)) {
				// Use 'open' command with execFileAsync to prevent shell injection
				await execFileAsync("open", [
					"-a",
					path.basename(appPath, ".app"),
					dirPath,
				]);
				return { success: true };
			}
		}

		// Windows batch launchers (.cmd, .bat) only run through cmd.exe
		if (
			platform === "win32" &&
			(command.endsWith(".cmd") || command.endsWith(".bat"))
		) {
			const args = buildBatchLaunchArgs(command, dirPath);
			if (!args) {
				return {
					success: false,
					error: `This folder path cannot be opened with ${config.name}`,
				};
			}
			spawn("cmd.exe", args, {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
				windowsVerbatimArguments: true,
			}).unref();
			return { success: true };
		}

		// Use command line tool with execFileAsync
		await execFileAsync(command, [dirPath]);
		return { success: true };
	} catch (error) {
		console.error(`Failed to open in IDE ${ide}:`, error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Failed to open IDE",
		};
	}
}

/**
 * Open a directory in the specified terminal
 */
export async function openInTerminal(
	dirPath: string,
	terminal: SupportedTerminal,
	customPath?: string,
): Promise<{ success: boolean; error?: string }> {
	const platform = getCurrentOS();

	try {
		if (terminal === "custom") {
			const launcher = resolveCustomLauncher(customPath);
			if (!launcher) {
				return { success: false, error: "Invalid custom terminal path" };
			}
			await execFileAsync(launcher, [dirPath]);
			return { success: true };
		}

		const config = TERMINAL_DETECTION[terminal];
		if (!config) {
			return { success: false, error: `Unknown terminal: ${terminal}` };
		}

		const commands = config.commands[platform];
		if (!commands || commands.length === 0) {
			// Fall back to opening the folder in system file manager
			await shell.openPath(dirPath);
			return { success: true };
		}

		if (platform === "darwin") {
			if (terminal === "system" || terminal === "iterm2") {
				// The directory is an osascript argument, never script source
				await execFileAsync("osascript", [
					"-e",
					buildMacTerminalScript(terminal),
					dirPath,
				]);
			} else if (terminal === "warp") {
				// Warp can be opened with just the directory using execFileAsync
				await execFileAsync("open", ["-a", "Warp", dirPath]);
			} else {
				// For other terminals, use execFileAsync with arguments array
				await execFileAsync(commands[0], [...commands.slice(1), dirPath]);
			}
		} else if (platform === "win32") {
			// Windows: Start terminal at directory using spawn to avoid shell injection
			if (terminal === "system") {
				const args = buildCmdConsoleArgs(dirPath);
				if (!args) {
					return {
						success: false,
						error: "This folder path cannot be opened in cmd.exe",
					};
				}
				spawn("cmd.exe", args, {
					detached: true,
					stdio: "ignore",
					windowsVerbatimArguments: true,
				}).unref();
			} else if (commands.length > 0) {
				spawn(commands[0], [...commands.slice(1), dirPath], {
					detached: true,
					stdio: "ignore",
				}).unref();
			}
		} else {
			// Linux: Use the configured terminal with execFileAsync
			if (terminal === "system") {
				// Try common terminal emulators with proper argument arrays
				try {
					await execFileAsync("x-terminal-emulator", [
						"--working-directory",
						dirPath,
						"-e",
						"bash",
					]);
				} catch {
					try {
						await execFileAsync("gnome-terminal", [
							"--working-directory",
							dirPath,
						]);
					} catch {
						// xterm has no --working-directory: start it in the directory
						await execFileAsync("xterm", ["-e", "bash"], { cwd: dirPath });
					}
				}
			} else {
				// Use execFileAsync with arguments array
				await execFileAsync(commands[0], [...commands.slice(1), dirPath]);
			}
		}

		return { success: true };
	} catch (error) {
		console.error(`Failed to open in terminal ${terminal}:`, error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Failed to open terminal",
		};
	}
}
