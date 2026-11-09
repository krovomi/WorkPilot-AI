import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { SidebarView } from "../Sidebar";
import type { NavItem } from "./nav-model";

interface LaboPanelProps {
	/** The beta pages the menu shows (`laboItemsOf`). */
	readonly items: readonly NavItem[];
	readonly activeView: SidebarView;
	readonly disabled: boolean;
	readonly onOpen: (item: NavItem) => void;
}

/**
 * The Labo (F181, lot 3): every page still in beta, one card each with what
 * it does. A page leaves it once it has a design file or a test.
 */
export function LaboPanel({ items, activeView, disabled, onOpen }: LaboPanelProps) {
	const { t } = useTranslation("navigation");
	return (
		<div className="space-y-2 px-1" data-testid="labo-panel">
			<p className="px-2 pt-1 text-xs text-muted-foreground">{t("labo.intro")}</p>
			<ul className="space-y-1.5">
				{items.map((item) => {
					const Icon = item.icon;
					return (
						<li key={item.id}>
							<button
								type="button"
								onClick={() => onOpen(item)}
								disabled={disabled}
								aria-current={item.id === activeView ? "page" : undefined}
								className={cn(
									"flex w-full items-start gap-3 rounded-lg border border-border bg-card/40 p-2.5 text-left transition-colors",
									"hover:border-primary/40 hover:bg-accent hover:text-accent-foreground",
									"disabled:pointer-events-none disabled:opacity-50",
									item.id === activeView && "border-primary/50 bg-primary/10",
								)}
							>
								<Icon className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
								<span className="min-w-0">
									<span className="block truncate text-sm font-medium">{t(item.labelKey)}</span>
									<span className="mt-0.5 block text-xs text-muted-foreground">
										{t(`labo.about.${item.id}`)}
									</span>
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
