import { ArrowDown, ArrowUp, Check, CornerDownRight, RotateCcw, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * « Personnaliser le menu »: each person arranges their own menu. The drag
 * is the quick way (`use-menu-dnd.ts`); these controls do the same with a
 * click or the keyboard, so nothing needs a pointer: move a page up or down,
 * move it to another space, move the space shown up or down the rail, go
 * back to the order as shipped.
 */

const FOOTER_BUTTON =
	"w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors";

/** The panel's entry into the customizing, and its way out. */
export function CustomizeMenuToggle({
	customizing,
	onToggle,
}: {
	readonly customizing: boolean;
	readonly onToggle: () => void;
}) {
	const { t } = useTranslation("navigation");
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-pressed={customizing}
			data-testid="customize-menu"
			className={FOOTER_BUTTON}
		>
			<SlidersHorizontal className="h-3 w-3" />
			{customizing ? t("customize.done") : t("customize.start")}
		</button>
	);
}

interface CustomizeBarProps {
	/** The space shown, when it is a group the rail can reorder. */
	readonly spaceName: string | null;
	readonly canMoveSpaceUp: boolean;
	readonly canMoveSpaceDown: boolean;
	readonly onMoveSpace: (delta: -1 | 1) => void;
	readonly orderChanged: boolean;
	readonly onResetOrder: () => void;
	readonly onDone: () => void;
}

/** Above the pages while customizing: how it works, the space's place, reset, done. */
export function CustomizeBar({
	spaceName,
	canMoveSpaceUp,
	canMoveSpaceDown,
	onMoveSpace,
	orderChanged,
	onResetOrder,
	onDone,
}: CustomizeBarProps) {
	const { t } = useTranslation("navigation");
	return (
		<section
			aria-label={t("customize.title")}
			data-testid="customize-bar"
			className="mx-1 mb-2 rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-xs text-muted-foreground"
		>
			<p className="font-medium text-foreground">{t("customize.title")}</p>
			<p className="mt-1">{t("customize.hint")}</p>
			{spaceName && (
				<div className="mt-2 flex items-center gap-1">
					<span className="min-w-0 flex-1 truncate">{t("customize.spacePlace", { name: spaceName })}</span>
					<IconButton
						label={t("customize.spaceUp", { name: spaceName })}
						disabled={!canMoveSpaceUp}
						onClick={() => onMoveSpace(-1)}
					>
						<ArrowUp className="h-3.5 w-3.5" />
					</IconButton>
					<IconButton
						label={t("customize.spaceDown", { name: spaceName })}
						disabled={!canMoveSpaceDown}
						onClick={() => onMoveSpace(1)}
					>
						<ArrowDown className="h-3.5 w-3.5" />
					</IconButton>
				</div>
			)}
			<div className="mt-2 flex flex-wrap gap-1.5">
				<Button
					size="sm"
					variant="outline"
					className="h-7 text-xs"
					disabled={!orderChanged}
					onClick={onResetOrder}
				>
					<RotateCcw className="mr-1 h-3 w-3" />
					{t("customize.resetOrder")}
				</Button>
				<Button size="sm" className="h-7 text-xs" onClick={onDone}>
					<Check className="mr-1 h-3 w-3" />
					{t("customize.done")}
				</Button>
			</div>
		</section>
	);
}

export interface MoveTarget {
	readonly id: string;
	readonly labelKey: string;
}

interface RowMoveControlsProps {
	/** The page's name, for the buttons' labels. */
	readonly name: string;
	readonly canMoveUp: boolean;
	readonly canMoveDown: boolean;
	readonly onMove: (delta: -1 | 1) => void;
	/** The other spaces the page can go to; none for a pin. */
	readonly targets?: readonly MoveTarget[];
	readonly onMoveTo?: (groupId: string) => void;
}

/** A page's own controls while customizing: up, down, to another space. */
export function RowMoveControls({
	name,
	canMoveUp,
	canMoveDown,
	onMove,
	targets = [],
	onMoveTo,
}: RowMoveControlsProps) {
	const { t } = useTranslation("navigation");
	return (
		<div className="flex shrink-0 items-center pr-1" data-testid="row-move-controls">
			<IconButton label={t("customize.up", { name })} disabled={!canMoveUp} onClick={() => onMove(-1)}>
				<ArrowUp className="h-3.5 w-3.5" />
			</IconButton>
			<IconButton label={t("customize.down", { name })} disabled={!canMoveDown} onClick={() => onMove(1)}>
				<ArrowDown className="h-3.5 w-3.5" />
			</IconButton>
			{onMoveTo && targets.length > 0 && (
				<DropdownMenu modal={false}>
					<DropdownMenuTrigger asChild>
						<button type="button" aria-label={t("customize.moveTo", { name })} className={ICON_BUTTON}>
							<CornerDownRight className="h-3.5 w-3.5" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" side="right">
						<DropdownMenuLabel className="text-xs">{t("customize.moveToTitle", { name })}</DropdownMenuLabel>
						{targets.map((target) => (
							<DropdownMenuItem key={target.id} onSelect={() => onMoveTo(target.id)}>
								{t(target.labelKey)}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}

const ICON_BUTTON = cn(
	"flex h-6 w-6 items-center justify-center rounded text-muted-foreground",
	"hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30",
);

function IconButton({
	label,
	disabled,
	onClick,
	children,
}: {
	readonly label: string;
	readonly disabled: boolean;
	readonly onClick: () => void;
	readonly children: ReactNode;
}) {
	return (
		<button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className={ICON_BUTTON}>
			{children}
		</button>
	);
}
