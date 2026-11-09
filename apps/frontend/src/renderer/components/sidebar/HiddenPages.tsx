import { EyeOff } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import type { NavItem } from "./nav-model";
import { UNUSED_DAYS } from "./spaces";

interface HideSuggestionProps {
	/** The entries of the space not opened for `UNUSED_DAYS` days. */
	readonly unused: readonly NavItem[];
	readonly onHide: (ids: readonly string[]) => void;
	readonly onSnooze: () => void;
}

/**
 * Offers to hide the pages of a space nobody opened for a month (F181, lot 3).
 * Nothing is hidden without a click, and a hidden page is still one Ctrl K
 * away.
 */
export function HideSuggestion({ unused, onHide, onSnooze }: HideSuggestionProps) {
	const { t } = useTranslation("navigation");
	const [open, setOpen] = useState(false);
	const listId = useId();
	if (unused.length === 0) return null;
	return (
		<section
			aria-label={t("hidden.suggestTitle")}
			data-testid="hide-suggestion"
			className="mx-1 rounded-lg border border-dashed border-border p-2.5 text-xs text-muted-foreground"
		>
			<p>{t("hidden.suggest", { count: unused.length, days: UNUSED_DAYS })}</p>
			<div className="mt-2 flex flex-wrap gap-1.5">
				<Button
					size="sm"
					variant="outline"
					className="h-7 text-xs"
					aria-expanded={open}
					aria-controls={listId}
					onClick={() => setOpen((value) => !value)}
				>
					{t("hidden.review")}
				</Button>
				<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onSnooze}>
					{t("hidden.later")}
				</Button>
			</div>
			<ul id={listId} hidden={!open} className="mt-2 space-y-1">
				{unused.map((item) => (
					<li key={item.id} className="flex items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-foreground">{t(item.labelKey)}</span>
						<Button
							size="sm"
							variant="ghost"
							className="h-6 px-2 text-xs"
							aria-label={t("hidden.hideOne", { name: t(item.labelKey) })}
							onClick={() => onHide([item.id])}
						>
							<EyeOff className="h-3 w-3" />
						</Button>
					</li>
				))}
				<li>
					<Button
						size="sm"
						variant="outline"
						className="mt-1 h-7 w-full text-xs"
						onClick={() => onHide(unused.map((item) => item.id))}
					>
						{t("hidden.hideAll", { count: unused.length })}
					</Button>
				</li>
			</ul>
		</section>
	);
}

interface HiddenListProps {
	/** The entries of the space the user hid. */
	readonly hidden: readonly NavItem[];
	readonly onShow: (id: string) => void;
}

/** The pages hidden from a space, folded under one line, each to show again. */
export function HiddenList({ hidden, onShow }: HiddenListProps) {
	const { t } = useTranslation("navigation");
	const [open, setOpen] = useState(false);
	const listId = useId();
	if (hidden.length === 0) return null;
	return (
		<div data-testid="hidden-pages">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={listId}
				onClick={() => setOpen((value) => !value)}
				className="w-full rounded-md px-3 py-1.5 text-center text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
			>
				{t("hidden.count", { count: hidden.length })}
			</button>
			<ul id={listId} hidden={!open} className="space-y-0.5 px-1">
				{hidden.map((item) => (
					<li key={item.id} className="flex items-center gap-2 px-2 py-1 text-xs">
						<span className="min-w-0 flex-1 truncate text-muted-foreground">{t(item.labelKey)}</span>
						<Button
							size="sm"
							variant="ghost"
							className="h-6 px-2 text-xs"
							onClick={() => onShow(item.id)}
						>
							{t("hidden.show")}
						</Button>
					</li>
				))}
			</ul>
		</div>
	);
}
