/**
 * AddFeatureDialog - Dialog for adding new features to the roadmap
 *
 * Allows users to create new roadmap features with title, description,
 * priority, phase, complexity, and impact fields.
 * Follows the same dialog pattern as TaskEditDialog for consistency.
 *
 * Features:
 * - Add is enabled once the title, the description and a phase are set
 * - Selectable classification fields (priority, phase, complexity, impact)
 * - Adds the feature to the roadmap store and saves the roadmap; a failed
 *   save takes the feature back out and says why
 */

import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ROADMAP_PRIORITIES } from "./roadmap/tones";
import type {
	Roadmap,
	RoadmapFeaturePriority,
	RoadmapFeatureStatus,
	RoadmapPhase,
} from "../../shared/types";
import { useRoadmapStore } from "../stores/roadmap-store";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";
import { Textarea } from "./ui/textarea";

// Type alias for complexity and impact levels
type ComplexityLevel = (typeof LEVELS)[number];
type ImpactLevel = ComplexityLevel;

/**
 * Props for the AddFeatureDialog component
 */
interface AddFeatureDialogProps {
	/** Available phases to select from */
	readonly phases: RoadmapPhase[];
	/** Whether the dialog is open */
	readonly open: boolean;
	/** Callback when the dialog open state changes */
	readonly onOpenChange: (open: boolean) => void;
}

const LEVELS = ["low", "medium", "high"] as const;

export function AddFeatureDialog({
	phases,
	open,
	onOpenChange,
}: AddFeatureDialogProps) {
	const { t } = useTranslation("dialogs");

	// Form state
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [rationale, setRationale] = useState("");
	const [priority, setPriority] = useState<RoadmapFeaturePriority>("should");
	const [phaseId, setPhaseId] = useState<string>("");
	const [complexity, setComplexity] = useState<ComplexityLevel>("medium");
	const [impact, setImpact] = useState<ImpactLevel>("medium");

	// UI state
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Store actions
	const addFeature = useRoadmapStore((state) => state.addFeature);
	const deleteFeature = useRoadmapStore((state) => state.deleteFeature);

	// Reset form when dialog opens/closes
	useEffect(() => {
		if (open) {
			setTitle("");
			setDescription("");
			setRationale("");
			setPriority("should");
			setPhaseId(phases[0]?.id ?? "");
			setComplexity("medium");
			setImpact("medium");
			setError(null);
		}
	}, [open, phases]);

	// Add is only enabled once the form is valid (isValid below).
	const handleSave = async () => {
		setIsSaving(true);
		setError(null);
		const newFeatureId = addFeature({
			title: title.trim(),
			description: description.trim(),
			rationale: rationale.trim() || t("addFeature.defaultRationale"),
			priority,
			complexity,
			impact,
			phaseId,
			dependencies: [],
			status: "under_review" as RoadmapFeatureStatus,
			acceptanceCriteria: [],
			userStories: [],
			source: { provider: "internal" },
		});

		// The view only offers this dialog with a roadmap open, and addFeature
		// added to it: save it.
		const roadmap = useRoadmapStore.getState().roadmap as Roadmap;
		try {
			const result = await globalThis.electronAPI.saveRoadmap(roadmap.projectId, roadmap);
			if (!result.success) throw new Error(result.error);
			onOpenChange(false);
		} catch (err) {
			// Not saved: the feature leaves the board again rather than looking kept.
			deleteFeature(newFeatureId);
			setError(err instanceof Error && err.message ? err.message : t("addFeature.failedToAdd"));
		} finally {
			setIsSaving(false);
		}
	};

	const handleClose = () => {
		if (!isSaving) {
			onOpenChange(false);
		}
	};

	// Form validation
	const isValid =
		title.trim().length > 0 && description.trim().length > 0 && phaseId !== "";

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-[550px] max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle className="text-foreground">
						{t("addFeature.title")}
					</DialogTitle>
					<DialogDescription>{t("addFeature.description")}</DialogDescription>
				</DialogHeader>

				<div className="space-y-5 py-4">
					{/* Title (Required) */}
					<div className="space-y-2">
						<Label
							htmlFor="add-feature-title"
							className="text-sm font-medium text-foreground"
						>
							{t("addFeature.featureTitle")}{" "}
							<span className="text-destructive">*</span>
						</Label>
						<Input
							id="add-feature-title"
							placeholder={t("addFeature.featureTitlePlaceholder")}
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							disabled={isSaving}
							aria-required="true"
						/>
					</div>

					{/* Description (Required) */}
					<div className="space-y-2">
						<Label
							htmlFor="add-feature-description"
							className="text-sm font-medium text-foreground"
						>
							{t("addFeature.featureDescription")}{" "}
							<span className="text-destructive">*</span>
						</Label>
						<Textarea
							id="add-feature-description"
							placeholder={t("addFeature.featureDescriptionPlaceholder")}
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={3}
							disabled={isSaving}
							aria-required="true"
						/>
					</div>

					{/* Rationale (Optional) */}
					<div className="space-y-2">
						<Label
							htmlFor="add-feature-rationale"
							className="text-sm font-medium text-foreground"
						>
							{t("addFeature.rationale")}{" "}
							<span className="text-muted-foreground font-normal">
								({t("addFeature.optional")})
							</span>
						</Label>
						<Textarea
							id="add-feature-rationale"
							placeholder={t("addFeature.rationalePlaceholder")}
							value={rationale}
							onChange={(e) => setRationale(e.target.value)}
							rows={2}
							disabled={isSaving}
						/>
					</div>

					{/* Classification Fields */}
					<div className="grid grid-cols-2 gap-4">
						{/* Phase */}
						<div className="space-y-2">
							<Label
								htmlFor="add-feature-phase"
								className="text-sm font-medium text-foreground"
							>
								{t("addFeature.phase")}{" "}
								<span className="text-destructive">*</span>
							</Label>
							<Select
								value={phaseId}
								onValueChange={setPhaseId}
								disabled={isSaving}
							>
								<SelectTrigger id="add-feature-phase" aria-required="true">
									<SelectValue placeholder={t("addFeature.selectPhase")} />
								</SelectTrigger>
								<SelectContent>
									{phases.map((phase) => (
										<SelectItem key={phase.id} value={phase.id}>
											{phase.order}. {phase.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{/* Priority */}
						<div className="space-y-2">
							<Label
								htmlFor="add-feature-priority"
								className="text-sm font-medium text-foreground"
							>
								{t("addFeature.priority")}
							</Label>
							<Select
								value={priority}
								onValueChange={(value) =>
									setPriority(value as RoadmapFeaturePriority)
								}
								disabled={isSaving}
							>
								<SelectTrigger id="add-feature-priority">
									<SelectValue placeholder={t("addFeature.selectPriority")} />
								</SelectTrigger>
								<SelectContent>
									{ROADMAP_PRIORITIES.map((value) => (
										<SelectItem key={value} value={value}>
											{t(`roadmap:priorityLabels.${value}`)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{/* Complexity */}
						<div className="space-y-2">
							<Label
								htmlFor="add-feature-complexity"
								className="text-sm font-medium text-foreground"
							>
								{t("addFeature.complexity")}
							</Label>
							<Select
								value={complexity}
								onValueChange={(value) =>
									setComplexity(value as ComplexityLevel)
								}
								disabled={isSaving}
							>
								<SelectTrigger id="add-feature-complexity">
									<SelectValue placeholder={t("addFeature.selectComplexity")} />
								</SelectTrigger>
								<SelectContent>
									{LEVELS.map((value) => (
										<SelectItem key={value} value={value}>
											{t(`roadmap:levels.complexity.${value}`)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{/* Impact */}
						<div className="space-y-2">
							<Label
								htmlFor="add-feature-impact"
								className="text-sm font-medium text-foreground"
							>
								{t("addFeature.impact")}
							</Label>
							<Select
								value={impact}
								onValueChange={(value) => setImpact(value as ImpactLevel)}
								disabled={isSaving}
							>
								<SelectTrigger id="add-feature-impact">
									<SelectValue placeholder={t("addFeature.selectImpact")} />
								</SelectTrigger>
								<SelectContent>
									{LEVELS.map((value) => (
										<SelectItem key={value} value={value}>
											{t(`roadmap:levels.impactBadge.${value}`)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					{/* Error */}
					{error && (
						<div
							className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive"
							role="alert"
						>
							<X className="h-4 w-4 mt-0.5 shrink-0" />
							<span>{error}</span>
						</div>
					)}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={handleClose} disabled={isSaving}>
						{t("addFeature.cancel")}
					</Button>
					<Button onClick={handleSave} disabled={isSaving || !isValid}>
						{isSaving ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								{t("addFeature.adding")}
							</>
						) : (
							t("addFeature.addFeature")
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
