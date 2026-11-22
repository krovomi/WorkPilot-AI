import { useTranslation } from "react-i18next";
import { isMacOS } from "../../lib/os-detection";
import { useShortcutsHelpStore } from "../../stores/shortcuts-help-store";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";

/**
 * One line of the help: the keys and what they do. MOD is Ctrl, or ⌘ on
 * macOS; a key named with @ is translated (Shift reads Maj in French).
 */
const GROUPS = [
	{
		id: "cards",
		rows: [
			{ id: "navigate", keys: ["↑", "↓", "←", "→"] },
			{ id: "open", keys: ["@enter"] },
			{ id: "rename", keys: ["F2"] },
			{ id: "menu", keys: ["@shift", "F10"] },
		],
	},
	{
		id: "selection",
		rows: [
			{ id: "toggle", keys: ["MOD", "@click"] },
			{ id: "range", keys: ["@shift", "@click"] },
			{ id: "column", keys: ["MOD", "A"] },
			{ id: "clear", keys: ["@escape"] },
			{ id: "delete", keys: ["@delete"] },
		],
	},
	{
		id: "board",
		rows: [
			{ id: "add", keys: ["N"] },
			{ id: "undo", keys: ["MOD", "Z"] },
			{ id: "help", keys: ["MOD", "/"] },
		],
	},
] as const;

/**
 * Every key of the board on one page. Design:
 * docs/architecture/kanban-quick-edit.md.
 */
export function ShortcutsHelpDialog() {
	const { t } = useTranslation(["tasks"]);
	const open = useShortcutsHelpStore((s) => s.open);
	const setOpen = useShortcutsHelpStore((s) => s.setOpen);
	const mod = isMacOS() ? "⌘" : "Ctrl";
	const keyLabel = (key: string) => {
		if (key === "MOD") return mod;
		return key.startsWith("@") ? t(`tasks:kanban.shortcuts.keys.${key.slice(1)}`) : key;
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="max-w-md" maximizable={false}>
				<DialogHeader>
					<DialogTitle>{t("tasks:kanban.shortcuts.title")}</DialogTitle>
					<DialogDescription>{t("tasks:kanban.shortcuts.description")}</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					{GROUPS.map((group) => (
						<section key={group.id} aria-labelledby={`shortcuts-${group.id}`}>
							<h3
								id={`shortcuts-${group.id}`}
								className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
							>
								{t(`tasks:kanban.shortcuts.groups.${group.id}`)}
							</h3>
							<dl className="space-y-1">
								{group.rows.map((row) => (
									<div key={row.id} className="flex items-center justify-between gap-4 text-sm">
										<dt className="text-foreground">
											{t(`tasks:kanban.shortcuts.rows.${row.id}`)}
										</dt>
										<dd className="flex shrink-0 gap-1">
											{row.keys.map((key) => (
												<kbd
													key={key}
													className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
												>
													{keyLabel(key)}
												</kbd>
											))}
										</dd>
									</div>
								))}
							</dl>
						</section>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
