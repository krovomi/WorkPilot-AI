/**
 * The ready-made crews of Mission Control (#344): "Bug fix", "New feature",
 * "Refactor module", "Incident response", or let the work decide. The roles
 * each one brings are the backend's (`mission_control/templates.py`).
 */

import { useTranslation } from "react-i18next";
import {
	MISSION_CONTROL_TEMPLATES,
	type MissionControlTemplate,
} from "../../../shared/types/mission-control";
import { Chip, Chips } from "../charter";

export type TemplateChoice = MissionControlTemplate | "auto";

const CHOICES: readonly TemplateChoice[] = ["auto", ...MISSION_CONTROL_TEMPLATES];

interface SessionTemplatesProps {
	readonly value: TemplateChoice;
	readonly onChange: (value: TemplateChoice) => void;
}

export function SessionTemplates({ value, onChange }: SessionTemplatesProps) {
	const { t } = useTranslation("missionControl");
	return (
		<div className="space-y-1.5">
			<Chips>
				{CHOICES.map((choice) => (
					<Chip
						key={choice}
						tone="orange"
						dot={false}
						pressed={value === choice}
						onClick={() => onChange(choice)}
						title={t(`compose.templates.${choice}.hint`)}
					>
						{t(`compose.templates.${choice}.label`)}
					</Chip>
				))}
			</Chips>
			<p className="wp-meta">{t(`compose.templates.${value}.hint`)}</p>
		</div>
	);
}
