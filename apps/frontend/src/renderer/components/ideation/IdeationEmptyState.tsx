import { AlertCircle, Lightbulb, Settings2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { IdeationConfig, IdeationType } from "../../../shared/types";
import { cn } from "../../lib/utils";
import {
	CharterButton,
	ModuleHeader,
	Notice,
	Page,
	Section,
	toneClass,
} from "../charter";
import { Switch } from "../ui/switch";
import { ALL_IDEATION_TYPES, IDEATION_TYPE_TONES } from "./constants";
import { TypeIcon } from "./TypeIcon";

interface IdeationEmptyStateProps {
	readonly config: IdeationConfig;
	readonly hasToken: boolean | null;
	readonly isCheckingToken: boolean;
	readonly onGenerate: () => void;
	readonly onOpenConfig: () => void;
	readonly onToggleIdeationType: (type: IdeationType) => void;
}

/** Before the first run: pick the kinds of ideas, then generate. */
export function IdeationEmptyState({
	config,
	hasToken,
	isCheckingToken,
	onGenerate,
	onOpenConfig,
	onToggleIdeationType,
}: IdeationEmptyStateProps) {
	const { t } = useTranslation(["ideation", "common", "navigation"]);

	return (
		<>
			<ModuleHeader
				kicker={t("navigation:groups.explore")}
				title={t("ideation:header.title")}
				description={t("ideation:emptyState.description")}
				icon={Lightbulb}
				tone="amber"
				actions={
					<CharterButton
						variant="primary"
						icon={Sparkles}
						onClick={onGenerate}
						disabled={isCheckingToken}
					>
						{t("ideation:emptyState.generateIdeas")}
					</CharterButton>
				}
			/>
			<Page className="space-y-4 pt-1">
				{hasToken === false && !isCheckingToken && (
					<Notice tone="amber" icon={AlertCircle}>
						{t("ideation:emptyState.tokenMissing")}
					</Notice>
				)}
				<Section
					kicker={t("ideation:emptyState.title")}
					title={t("ideation:emptyState.enabledTypes")}
					meta={t("ideation:emptyState.enabledCount", {
						count: config.enabledTypes.length,
						total: ALL_IDEATION_TYPES.length,
					})}
					actions={
						<CharterButton
							size="sm"
							variant="ghost"
							icon={Settings2}
							onClick={onOpenConfig}
							aria-label={t("common:accessibility.configureAriaLabel")}
							title={t("common:accessibility.configureAriaLabel")}
						/>
					}
				>
					<div className="grid gap-2.5 sm:grid-cols-2">
						{ALL_IDEATION_TYPES.map((type) => {
							const enabled = config.enabledTypes.includes(type);
							return (
								<label
									key={type}
									htmlFor={`ideation-type-${type}`}
									className={cn(
										"wp-card wp-card-pad wp-rail flex cursor-pointer items-start gap-3",
										toneClass(IDEATION_TYPE_TONES[type]),
										!enabled && "opacity-60",
									)}
								>
									<span className="wp-empty-glyph h-8 w-8 shrink-0">
										<TypeIcon type={type} className="h-4 w-4" />
									</span>
									<span className="min-w-0 flex-1">
										<span className="wp-title block text-sm">
											{t(`ideation:types.${type}`)}
										</span>
										<span className="wp-muted mt-0.5 block text-xs">
											{t(`ideation:typeDescriptions.${type}`)}
										</span>
									</span>
									<Switch
										id={`ideation-type-${type}`}
										checked={enabled}
										onCheckedChange={() => onToggleIdeationType(type)}
										aria-label={t(`ideation:types.${type}`)}
									/>
								</label>
							);
						})}
					</div>
				</Section>
			</Page>
		</>
	);
}
