/**
 * The engine (provider, model, effort) and priority of a new card. Each starts
 * on "default": a card created without touching them runs as the deployment
 * decides. The providers come from the server; an older server that does not
 * list them gets the priority only.
 */

import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Field } from "../ui/components";
import { SPACE, useTheme } from "../ui/theme";
import { type Choice, ChoiceChips } from "./ChoiceChips";
import {
	EFFORT_LEVELS,
	type EffortLevel,
	type EngineChoice,
	type EngineOption,
	isModelValid,
	PRIORITIES,
	type Priority,
} from "./engine";

export function EngineSection({
	engines,
	choice,
	onChange,
}: {
	engines: readonly EngineOption[];
	choice: EngineChoice;
	onChange: (choice: EngineChoice) => void;
}) {
	const { t } = useTranslation();
	const theme = useTheme();
	const byDefault = t("newCard.default");
	const option = engines.find((e) => e.provider === choice.provider);

	const providers: Choice<string | null>[] = [
		{ value: null, label: byDefault },
		...engines.map((e) => ({ value: e.provider, label: e.label })),
	];
	const efforts: Choice<EffortLevel | null>[] = [
		{ value: null, label: byDefault },
		...EFFORT_LEVELS.map((level) => ({ value: level, label: t(`newCard.effort_${level}`) })),
	];
	const priorities: Choice<Priority | null>[] = [
		{ value: null, label: byDefault },
		...PRIORITIES.map((p) => ({ value: p, label: t(`card.priority_${p}`) })),
	];

	return (
		<View style={{ gap: SPACE.lg }}>
			{engines.length ? (
				<ChoiceChips
					label={t("newCard.provider")}
					choices={providers}
					selected={option ? choice.provider : null}
					onSelect={(provider) => onChange({ ...choice, provider, model: "", effort: null })}
				/>
			) : null}
			{option?.models.length ? (
				<ChoiceChips<string>
					label={t("newCard.model")}
					choices={[{ value: "", label: byDefault }, ...option.models.map((m) => ({ value: m.id, label: m.label }))]}
					selected={choice.model}
					onSelect={(model) => onChange({ ...choice, model })}
				/>
			) : null}
			{option && !option.models.length ? (
				<View style={{ gap: SPACE.xs }}>
					<Field
						label={t("newCard.model")}
						placeholder={t("newCard.modelPlaceholder")}
						value={choice.model}
						onChangeText={(model) => onChange({ ...choice, model })}
						autoCapitalize="none"
						autoCorrect={false}
						maxLength={200}
					/>
					{isModelValid(choice.model) ? null : (
						<Text accessibilityRole="alert" style={{ color: theme.danger, fontSize: 13 }}>
							{t("newCard.modelInvalid")}
						</Text>
					)}
				</View>
			) : null}
			{option && option.effort !== "none" ? (
				<ChoiceChips
					label={t("newCard.effort")}
					choices={efforts}
					selected={choice.effort}
					onSelect={(effort) => onChange({ ...choice, effort })}
				/>
			) : null}
			<ChoiceChips
				label={t("newCard.priority")}
				choices={priorities}
				selected={choice.priority}
				onSelect={(priority) => onChange({ ...choice, priority })}
			/>
		</View>
	);
}
