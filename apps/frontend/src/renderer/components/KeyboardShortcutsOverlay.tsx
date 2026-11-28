import { Keyboard, X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { type NavIndexEntry, useNavIndexStore } from "./sidebar/nav-index";

// ---------------------------------------------------------------------------
// Shortcut definitions
// ---------------------------------------------------------------------------

interface ShortcutEntry {
	readonly keys: string;
	/** A key of `common:shortcutsOverlay.items`. */
	readonly label: string;
}

interface ShortcutGroup {
	/** A key of `common:shortcutsOverlay.groups`. */
	readonly title: string;
	readonly shortcuts: readonly ShortcutEntry[];
}

interface KeyboardShortcutsOverlayProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
}

// What `useKeyboardShortcuts`, `App.tsx`, `TerminalGrid.tsx`, the voice
// assistant and the stop-all button listen for. The menu's own two-letter
// shortcuts are read from the menu itself (`useNavIndexStore`).
const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
	{
		title: "navigation",
		shortcuts: [
			{ keys: "Ctrl+1", label: "goKanban" },
			{ keys: "Ctrl+2", label: "goTerminals" },
			{ keys: "Ctrl+3", label: "goInsights" },
			{ keys: "Ctrl+4", label: "goRoadmap" },
			{ keys: "Ctrl+5", label: "openSettings" },
		],
	},
	{
		title: "general",
		shortcuts: [
			{ keys: "Ctrl+K", label: "commandPalette" },
			{ keys: "Ctrl+/", label: "shortcuts" },
			{ keys: "Ctrl+N", label: "newTask" },
			{ keys: "Ctrl+,", label: "openSettings" },
			{ keys: "Ctrl+T", label: "addProject" },
			// The default; Settings → Voice assistant changes it.
			{ keys: "Ctrl+Shift+Space", label: "voiceAssistant" },
			// Pauses every running task; each resumes from its card.
			{ keys: "Ctrl+Shift+.", label: "stopAgents" },
			{ keys: "Escape", label: "closeDialog" },
		],
	},
	{
		title: "terminal",
		shortcuts: [
			{ keys: "Ctrl+T", label: "newTerminal" },
			{ keys: "Ctrl+W", label: "closeTerminal" },
		],
	},
];

// ---------------------------------------------------------------------------
// Kbd component
// ---------------------------------------------------------------------------

function Kbd({ children }: { readonly children: string }) {
	const parts = children.split("+");
	return (
		<span className="inline-flex items-center gap-0.5">
			{parts.map((part, i) => (
				<span key={part}>
					{i > 0 && <span className="mx-0.5 text-muted-foreground/50">+</span>}
					<kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-secondary px-1.5 font-mono text-2xs font-medium text-foreground shadow-sm">
						{part}
					</kbd>
				</span>
			))}
		</span>
	);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function KeyboardShortcutsOverlay({
	open,
	onOpenChange,
}: KeyboardShortcutsOverlayProps) {
	const { t } = useTranslation(["common", "navigation"]);
	// The pages the menu shows right now, each with its two-letter shortcut
	const navEntries = useNavIndexStore((state) => state.entries);
	const menuShortcuts = navEntries.filter(
		(entry): entry is NavIndexEntry & { shortcut: string } => Boolean(entry.shortcut),
	);

	useEffect(() => {
		if (!open) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onOpenChange(false);
			}
		};

		globalThis.addEventListener("keydown", handleKeyDown);
		return () => globalThis.removeEventListener("keydown", handleKeyDown);
	}, [open, onOpenChange]);

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-100 flex items-center justify-center">
			{/* Backdrop: a click outside the panel closes it */}
			<button
				type="button"
				tabIndex={-1}
				aria-label={t("common:buttons.close")}
				className="absolute inset-0 bg-black/50 backdrop-blur-sm"
				onClick={() => onOpenChange(false)}
			/>

			{/* Panel */}
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="keyboard-shortcuts-title"
				className="relative w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-xl border border-border bg-card shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200"
			>
				{/* Header */}
				<div className="flex items-center justify-between border-b border-border px-6 py-4">
					<div className="flex items-center gap-3">
						<Keyboard className="h-5 w-5 text-primary" />
						<h2
							id="keyboard-shortcuts-title"
							className="text-lg font-semibold text-foreground"
						>
							{t("common:shortcutsOverlay.title")}
						</h2>
					</div>
					<button
						type="button"
						onClick={() => onOpenChange(false)}
						aria-label={t("common:buttons.close")}
						className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				{/* Content */}
				<div className="overflow-y-auto p-6 max-h-[calc(80vh-130px)]">
					<div className="grid grid-cols-2 gap-8">
						{SHORTCUT_GROUPS.map((group) => (
							<ShortcutSection
								key={group.title}
								title={t(`common:shortcutsOverlay.groups.${group.title}`)}
								rows={group.shortcuts.map((shortcut) => ({
									keys: shortcut.keys,
									label: t(`common:shortcutsOverlay.items.${shortcut.label}`),
								}))}
							/>
						))}
						{menuShortcuts.length > 0 && (
							<ShortcutSection
								title={t("common:shortcutsOverlay.groups.menu")}
								rows={menuShortcuts.map((entry) => ({
									keys: entry.shortcut,
									label: t(entry.labelKey),
								}))}
							/>
						)}
					</div>
				</div>

				{/* Footer */}
				<div className="border-t border-border px-6 py-3 text-center text-xs text-muted-foreground">
					{t("common:shortcutsOverlay.pressBefore")} <Kbd>{t("common:shortcutsOverlay.escapeKey")}</Kbd> {t("common:shortcutsOverlay.pressAfter")}
				</div>
			</div>
		</div>
	);
}

function ShortcutSection({
	title,
	rows,
}: {
	readonly title: string;
	readonly rows: readonly { keys: string; label: string }[];
}) {
	return (
		<div>
			<h3 className="mb-3 text-sm font-semibold text-foreground uppercase tracking-wider">
				{title}
			</h3>
			<div className="space-y-2">
				{rows.map((row) => (
					<div
						key={row.keys}
						className="flex items-center justify-between gap-4 rounded-lg px-2 py-1.5 hover:bg-accent/30 transition-colors"
					>
						<span className="text-sm text-foreground">{row.label}</span>
						<Kbd>{row.keys}</Kbd>
					</div>
				))}
			</div>
		</div>
	);
}
