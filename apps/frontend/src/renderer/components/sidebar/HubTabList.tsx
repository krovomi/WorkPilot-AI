import { type KeyboardEvent, useRef } from "react";
import { cn } from "../../lib/utils";

export interface HubTabItem {
	readonly id: string;
	readonly label: string;
	readonly icon?: React.ElementType;
}

interface HubTabListProps {
	readonly label: string;
	readonly tabs: readonly HubTabItem[];
	readonly selectedId: string;
	readonly onSelect: (id: string) => void;
	/** The id of the panel the tabs control. */
	readonly panelId: string;
	/** Prefix of each tab's DOM id, so the panel can name its tab. */
	readonly idPrefix: string;
}

export function hubTabDomId(idPrefix: string, id: string): string {
	return `${idPrefix}-tab-${id}`;
}

/**
 * A WAI-ARIA tab list (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/): one
 * tab in the page's tab order, arrow keys, Home and End move between tabs,
 * Enter or Space opens one. Activation is manual: a tab is a whole page,
 * so moving focus does not load it.
 */
export function HubTabList({
	label,
	tabs,
	selectedId,
	onSelect,
	panelId,
	idPrefix,
}: HubTabListProps) {
	const refs = useRef(new Map<string, HTMLButtonElement>());

	const focusAt = (index: number) => {
		const target = tabs[(index + tabs.length) % tabs.length];
		if (target) refs.current.get(target.id)?.focus();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
		const moves: Record<string, number> = {
			ArrowRight: index + 1,
			ArrowLeft: index - 1,
			Home: 0,
			End: tabs.length - 1,
		};
		const next = moves[event.key];
		if (next === undefined) return;
		event.preventDefault();
		focusAt(next);
	};

	return (
		<div
			role="tablist"
			aria-label={label}
			aria-orientation="horizontal"
			className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-4 pt-2"
		>
			{tabs.map((tab, index) => {
				const selected = tab.id === selectedId;
				const Icon = tab.icon;
				return (
					<button
						key={tab.id}
						ref={(node) => {
							if (node) refs.current.set(tab.id, node);
							else refs.current.delete(tab.id);
						}}
						type="button"
						role="tab"
						id={hubTabDomId(idPrefix, tab.id)}
						aria-selected={selected}
						aria-controls={panelId}
						tabIndex={selected ? 0 : -1}
						onClick={() => onSelect(tab.id)}
						onKeyDown={(event) => onKeyDown(event, index)}
						className={cn(
							"-mb-px flex items-center gap-2 whitespace-nowrap rounded-t-md border-b-2 px-3 py-2 text-sm transition-colors",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							selected
								? "border-primary font-medium text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground",
						)}
					>
						{Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
						{tab.label}
					</button>
				);
			})}
		</div>
	);
}
