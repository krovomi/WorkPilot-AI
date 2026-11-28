import { Check } from "lucide-react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import {
	CARD_TYPES,
	type CardType,
	type CardTypeFamily,
} from "../../../shared/constants/card-types";
import type { TaskPriority } from "../../../shared/types";
import {
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
} from "../ui/dropdown-menu";
import { CARD_TYPE_ICONS } from "./CardTypeChip";

export const CARD_PRIORITIES: readonly TaskPriority[] = [
	"low",
	"medium",
	"high",
	"urgent",
];

const FAMILIES: readonly CardTypeFamily[] = [
	"build",
	"fix",
	"quality",
	"know",
	"ops",
];

interface CardTypeMenuItemsProps {
	current?: CardType | null;
	onSelect: (type: CardType) => void;
	/** Shown first: "no type" (the quick-add box lets the type be detected). */
	noneLabel?: string;
	onSelectNone?: () => void;
}

/**
 * The 14 card types, grouped by family, as menu items: used by the
 * quick-add box, the card menu (⋮ and right-click) and the bulk bar, so a
 * type is picked the same way everywhere.
 */
export function CardTypeMenuItems({
	current,
	onSelect,
	noneLabel,
	onSelectNone,
}: CardTypeMenuItemsProps) {
	const { t } = useTranslation(["tasks"]);
	return (
		<>
			{noneLabel && onSelectNone && (
				<DropdownMenuItem onSelect={onSelectNone}>{noneLabel}</DropdownMenuItem>
			)}
			{FAMILIES.map((family, index) => (
				<Fragment key={family}>
					{(index > 0 || noneLabel) && <DropdownMenuSeparator />}
					<DropdownMenuLabel className="text-2xs uppercase tracking-wide text-muted-foreground">
						{t(`tasks:cardType.families.${family}`)}
					</DropdownMenuLabel>
					{CARD_TYPES.filter((type) => type.family === family).map((type) => {
						const Icon = CARD_TYPE_ICONS[type.id];
						return (
							<DropdownMenuItem
								key={type.id}
								onSelect={() => onSelect(type.id)}
								className="gap-2"
							>
								<Icon
									className="h-3.5 w-3.5"
									style={{ color: type.color }}
									aria-hidden="true"
								/>
								{t(`tasks:cardType.values.${type.id}`)}
								{current === type.id && (
									<Check className="ml-auto h-3.5 w-3.5" aria-hidden="true" />
								)}
							</DropdownMenuItem>
						);
					})}
				</Fragment>
			))}
		</>
	);
}

interface PriorityMenuItemsProps {
	current?: TaskPriority | null;
	onSelect: (priority: TaskPriority) => void;
	noneLabel?: string;
	onSelectNone?: () => void;
}

/** Low, medium, high, urgent as menu items (same places as the types). */
export function PriorityMenuItems({
	current,
	onSelect,
	noneLabel,
	onSelectNone,
}: PriorityMenuItemsProps) {
	const { t } = useTranslation(["tasks"]);
	return (
		<>
			{noneLabel && onSelectNone && (
				<>
					<DropdownMenuItem onSelect={onSelectNone}>{noneLabel}</DropdownMenuItem>
					<DropdownMenuSeparator />
				</>
			)}
			{CARD_PRIORITIES.map((priority) => (
				<DropdownMenuItem key={priority} onSelect={() => onSelect(priority)}>
					{t(`tasks:form.classification.values.priority.${priority}`)}
					{current === priority && (
						<Check className="ml-2 h-3.5 w-3.5" aria-hidden="true" />
					)}
				</DropdownMenuItem>
			))}
		</>
	);
}
