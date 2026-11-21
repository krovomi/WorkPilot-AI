import {
	BookOpen,
	Bug,
	CircleArrowUp,
	Flame,
	FlaskConical,
	Gauge,
	Lightbulb,
	Palette,
	RefreshCw,
	Search,
	Server,
	ShieldAlert,
	Sparkles,
	Terminal,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	CARD_TYPES,
	type CardType,
	type ResolvedCardType,
} from "../../../shared/constants/card-types";
import { cn } from "../../lib/utils";

export const CARD_TYPE_ICONS: Record<CardType, typeof Bug> = {
	feature: Sparkles,
	ux: Palette,
	bug: Bug,
	hotfix: Flame,
	security: ShieldAlert,
	perf: Gauge,
	refactor: RefreshCw,
	test: FlaskConical,
	investigation: Search,
	spike: Lightbulb,
	docs: BookOpen,
	run: Terminal,
	upgrade: CircleArrowUp,
	infra: Server,
};

const BASE_COLOR = Object.fromEntries(
	CARD_TYPES.map((t) => [t.id, t.color]),
) as Record<CardType, string>;

interface CardTypeChipProps {
	resolved: ResolvedCardType;
	className?: string;
}

/**
 * The one type chip of a Kanban card: icon + label in the type's colour
 * (`--ct-chip-*`, written per theme by `lib/card-type-tokens.ts`), dashed
 * when the automatic classification only proposes it, followed by a dot per
 * other type the card also carries.
 */
export function CardTypeChip({ resolved, className }: CardTypeChipProps) {
	const { t } = useTranslation(["tasks"]);
	const { type, proposed, secondary } = resolved;
	const Icon = CARD_TYPE_ICONS[type];
	const label = t(`tasks:cardType.values.${type}`);
	const title = proposed
		? t("tasks:cardType.proposedTitle", { type: label })
		: label;
	return (
		<span className={cn("inline-flex items-center gap-1", className)}>
			<span
				className={cn("card-type-chip", proposed && "card-type-chip--proposed")}
				data-card-type-chip={type}
				title={title}
			>
				<Icon className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
				{label}
				{proposed && <span aria-hidden="true">?</span>}
			</span>
			{secondary.map((other) => (
				<span
					key={other}
					className="card-type-dot"
					style={{ backgroundColor: BASE_COLOR[other] }}
					title={t("tasks:cardType.also", {
						type: t(`tasks:cardType.values.${other}`),
					})}
					role="img"
					aria-label={t("tasks:cardType.also", {
						type: t(`tasks:cardType.values.${other}`),
					})}
				/>
			))}
		</span>
	);
}
