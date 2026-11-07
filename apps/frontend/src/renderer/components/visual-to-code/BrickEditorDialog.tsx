import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	BRICK_ICONS,
	BRICK_LIMITS,
	type BrickInput,
	type CustomBrick,
	DEFAULT_BRICK_ACCENT,
	DEFAULT_BRICK_ICON,
	resolveLook,
} from "../../lib/custom-bricks";
import { useCustomBricksStore } from "../../stores/custom-bricks-store";
import { Button, Input, Textarea } from "../ui";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "../ui/dialog";
import { ColorSwatches } from "./ColorSwatches";
import { FlowCard } from "./FlowCard";

interface BrickEditorDialogProps {
	open: boolean;
	/** The brick being edited; `null` creates a new one. */
	brick: CustomBrick | null;
	onOpenChange: (open: boolean) => void;
}

const EMPTY: BrickInput = {
	name: "",
	kicker: "",
	accent: DEFAULT_BRICK_ACCENT,
	icon: DEFAULT_BRICK_ICON,
	description: "",
	stack: "",
};

/**
 * Make or change a brick of one's own: its name, the role written above it,
 * its colour and icon, what it does and the technology it starts with. The
 * preview is the card the canvas will draw, from the same component.
 */
export function BrickEditorDialog({
	open,
	brick,
	onOpenChange,
}: BrickEditorDialogProps) {
	const { t } = useTranslation("visualProgramming");
	const addBrick = useCustomBricksStore((s) => s.addBrick);
	const updateBrick = useCustomBricksStore((s) => s.updateBrick);
	const removeBrick = useCustomBricksStore((s) => s.removeBrick);
	const [draft, setDraft] = useState<BrickInput>(EMPTY);

	useEffect(() => {
		if (open) setDraft(brick ? { ...brick } : EMPTY);
	}, [open, brick]);

	const set = <K extends keyof BrickInput>(key: K, value: BrickInput[K]) =>
		setDraft((d) => ({ ...d, [key]: value }));

	const canSave = draft.name.trim().length > 0;
	const look = resolveLook({ type: "custom", ...draft });

	const save = () => {
		if (!canSave) return;
		const ok = brick ? updateBrick(brick.id, draft) : addBrick(draft) !== null;
		if (ok) onOpenChange(false);
	};

	const remove = () => {
		if (!brick) return;
		removeBrick(brick.id);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-xl">
				<DialogTitle>
					{brick
						? t("brickEditTitle", "Modifier la brique")
						: t("brickCreateTitle", "Nouvelle brique")}
				</DialogTitle>
				<DialogDescription>
					{t(
						"brickEditorDesc",
						"Une brique à vous, réutilisable dans toutes vos architectures. Sa description part dans la spécification envoyée aux agents.",
					)}
				</DialogDescription>

				{/* What the canvas will draw. */}
				<div className="vtc-flow relative mt-2 flex items-center justify-center overflow-hidden rounded-lg border py-6">
					<div className="vtc-ambient" />
					<FlowCard
						look={look}
						kicker={look.kicker ?? t("customBlock", "Bloc personnalisé")}
						stack={draft.stack.trim() || undefined}
						selected
					>
						<p className="truncate">
							{draft.name.trim() || t("brickNamePlaceholder", "Nom de la brique")}
						</p>
					</FlowCard>
				</div>

				<div className="mt-3 grid grid-cols-2 gap-3">
					<div>
						<label
							htmlFor="brick-name"
							className="mb-1 block text-xs font-medium text-muted-foreground"
						>
							{t("brickName", "Nom")}
						</label>
						<Input
							id="brick-name"
							value={draft.name}
							maxLength={BRICK_LIMITS.name}
							onChange={(e) => set("name", e.target.value)}
							placeholder={t("brickNameExample", "ex. Hermes")}
							className="h-8 text-sm"
						/>
					</div>
					<div>
						<label
							htmlFor="brick-kicker"
							className="mb-1 block text-xs font-medium text-muted-foreground"
						>
							{t("brickKicker", "Rôle (au-dessus du nom)")}
						</label>
						<Input
							id="brick-kicker"
							value={draft.kicker}
							maxLength={BRICK_LIMITS.kicker}
							onChange={(e) => set("kicker", e.target.value)}
							placeholder={t("brickKickerExample", "ex. Agent principal")}
							className="h-8 text-sm"
						/>
					</div>
				</div>

				<div className="mt-3">
					<span className="mb-1 block text-xs font-medium text-muted-foreground">
						{t("brickColor", "Couleur")}
					</span>
					<ColorSwatches
						value={draft.accent}
						onChange={(accent) => set("accent", accent ?? DEFAULT_BRICK_ACCENT)}
						label={t("brickColor", "Couleur")}
					/>
				</div>

				<div className="mt-3">
					<span className="mb-1 block text-xs font-medium text-muted-foreground">
						{t("brickIcon", "Icône")}
					</span>
					<div className="grid grid-cols-11 gap-1">
						{Object.entries(BRICK_ICONS).map(([key, Icon]) => (
							<button
								key={key}
								type="button"
								onClick={() => set("icon", key)}
								aria-label={key}
								aria-pressed={draft.icon === key}
								className="flex h-8 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-pressed:border-border aria-pressed:bg-accent aria-pressed:text-foreground"
								style={
									draft.icon === key ? { color: draft.accent } : undefined
								}
							>
								<Icon className="h-4 w-4" />
							</button>
						))}
					</div>
				</div>

				<div className="mt-3">
					<label
						htmlFor="brick-stack"
						className="mb-1 block text-xs font-medium text-muted-foreground"
					>
						{t("brickStack", "Technologie par défaut (facultatif)")}
					</label>
					<Input
						id="brick-stack"
						value={draft.stack}
						maxLength={BRICK_LIMITS.stack}
						onChange={(e) => set("stack", e.target.value)}
						placeholder={t("otherStackPlaceholder", "ex. Quarkus")}
						className="h-8 text-sm"
					/>
				</div>

				<div className="mt-3">
					<label
						htmlFor="brick-description"
						className="mb-1 block text-xs font-medium text-muted-foreground"
					>
						{t("brickDescription", "Ce qu'elle fait")}
					</label>
					<Textarea
						id="brick-description"
						value={draft.description}
						maxLength={BRICK_LIMITS.description}
						onChange={(e) => set("description", e.target.value)}
						rows={3}
						placeholder={t(
							"brickDescriptionExample",
							"ex. Orchestre les sous-agents et répartit les tâches par modèle.",
						)}
						className="text-sm"
					/>
				</div>

				<DialogFooter className="mt-4">
					{brick ? (
						<Button
							variant="ghost"
							onClick={remove}
							className="mr-auto gap-1.5 text-destructive hover:text-destructive"
						>
							<Trash2 className="h-3.5 w-3.5" />
							{t("brickDelete", "Supprimer la brique")}
						</Button>
					) : null}
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{t("cancel", "Annuler")}
					</Button>
					<Button onClick={save} disabled={!canSave}>
						{brick
							? t("brickSave", "Enregistrer")
							: t("brickCreate", "Créer la brique")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
