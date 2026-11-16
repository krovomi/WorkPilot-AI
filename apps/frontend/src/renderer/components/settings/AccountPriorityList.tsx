/**
 * The failover chain of Settings → AI accounts: every connected account, in the
 * order a stopped task moves through them. Drag (or keyboard) to reorder; the
 * switch takes an account out of the chain without forgetting its place.
 */
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Chip } from "../charter";
import { Switch } from "../ui/switch";
import type { FailoverAccount } from "./failover-accounts";
import { ProviderIcon } from "./provider-icons";

interface AccountRowProps {
	readonly account: FailoverAccount;
	readonly rank: number | null;
	readonly providerLabel: string;
	readonly disabled: boolean;
	readonly onInclude: (id: string, included: boolean) => void;
}

function AccountRow({ account, rank, providerLabel, disabled, onInclude }: AccountRowProps) {
	const { t } = useTranslation("settings");
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: account.id,
		disabled,
	});
	const included = rank !== null;
	const usage = account.sessionPercent;

	return (
		<li
			ref={setNodeRef}
			style={{ transform: CSS.Transform.toString(transform), transition }}
			className={cn(
				"wp-card flex items-center gap-3 px-3 py-2.5",
				isDragging && "z-10 shadow-lg",
				!included && "opacity-55",
			)}
			data-account={account.id}
		>
			<button
				type="button"
				{...attributes}
				{...listeners}
				aria-label={t("aiAccounts.failover.dragHandle", { name: account.label })}
				className="cursor-grab rounded p-1 text-muted-foreground hover:text-foreground active:cursor-grabbing disabled:cursor-not-allowed"
				disabled={disabled}
			>
				<GripVertical className="h-4 w-4" aria-hidden="true" />
			</button>
			<span className="wp-mono w-5 shrink-0 text-center text-xs text-muted-foreground">
				{rank ?? "–"}
			</span>
			<ProviderIcon provider={account.provider} label={providerLabel} className="h-8 w-8" />
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span className="truncate text-sm font-medium text-foreground">{account.label}</span>
					<Chip tone="muted" dot={false}>
						{t(`aiAccounts.failover.kind.${account.kind}`)}
					</Chip>
					{account.isActive && <Chip tone="green">{t("aiAccounts.failover.active")}</Chip>}
				</div>
				{(account.detail || usage !== undefined) && (
					<p className="wp-meta mt-0.5 truncate">
						{[
							account.detail,
							usage !== undefined &&
								t("aiAccounts.card.usage", { session: Math.round(usage) }),
						]
							.filter(Boolean)
							.join(" · ")}
					</p>
				)}
			</div>
			<Switch
				checked={included}
				onCheckedChange={(checked) => onInclude(account.id, checked)}
				disabled={disabled}
				aria-label={t("aiAccounts.failover.include", { name: account.label })}
			/>
		</li>
	);
}

interface AccountPriorityListProps {
	readonly accounts: readonly FailoverAccount[];
	readonly excluded: (account: FailoverAccount) => boolean;
	readonly providerLabel: (provider: string) => string;
	readonly disabled?: boolean;
	readonly onReorder: (ids: string[]) => void;
	readonly onInclude: (id: string, included: boolean) => void;
}

export function AccountPriorityList({
	accounts,
	excluded,
	providerLabel,
	disabled = false,
	onReorder,
	onInclude,
}: AccountPriorityListProps) {
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);
	const ids = accounts.map((account) => account.id);

	const handleDragEnd = ({ active, over }: DragEndEvent) => {
		if (!over || active.id === over.id) return;
		onReorder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
	};

	let rank = 0;
	return (
		<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
			<SortableContext items={ids} strategy={verticalListSortingStrategy}>
				<ol className="flex flex-col gap-2">
					{accounts.map((account) => {
						const isExcluded = excluded(account);
						if (!isExcluded) rank += 1;
						return (
							<AccountRow
								key={account.id}
								account={account}
								rank={isExcluded ? null : rank}
								providerLabel={providerLabel(account.provider)}
								disabled={disabled}
								onInclude={onInclude}
							/>
						);
					})}
				</ol>
			</SortableContext>
		</DndContext>
	);
}
