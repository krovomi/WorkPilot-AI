import type React from "react";
import { useTranslation } from "react-i18next";
import type { A11ySeverity, A11yViolation } from "../../../shared/types/accessibility";
import { Chip, Panel, type Tone } from "../charter";

export const SEVERITY_TONES: Record<A11ySeverity, Tone> = {
	critical: "red",
	serious: "orange",
	moderate: "amber",
	minor: "blue",
};

interface Props {
	readonly violation: A11yViolation;
	readonly selected?: boolean;
	readonly onToggleFix?: (fixId: string) => void;
}

/** One violation: where, why, what to write, and its one-click fix when there is one. */
export function A11yViolationCard({ violation: v, selected, onToggleFix }: Props): React.ReactElement {
	const { t } = useTranslation("accessibility");
	const fixId = v.fixId;
	return (
		<Panel rail tone={SEVERITY_TONES[v.severity]}>
			<div className="flex flex-wrap items-center gap-2">
				<Chip tone={SEVERITY_TONES[v.severity]}>{t(`severities.${v.severity}`, { defaultValue: v.severity })}</Chip>
				<span className="wp-meta font-mono">
					{v.ruleId} · {t("wcagCriterion", { criterion: v.wcagCriteria })} ({v.wcagLevel})
				</span>
				{v.dynamic && (
					<Chip tone="blue" dot={false}>
						{t("notes.dynamic")}
					</Chip>
				)}
				{v.conditional && (
					<Chip tone="muted" dot={false} title={t("notes.conditionalHint")}>
						{t("notes.conditional")}
					</Chip>
				)}
				{v.external && (
					<Chip tone="muted" dot={false} title={t("notes.externalHint")}>
						{t("notes.external")}
					</Chip>
				)}
			</div>
			<p className="mt-1.5 text-sm">{t(`rules.${v.ruleId}.description`, { defaultValue: v.description })}</p>
			{v.detail && <p className="wp-meta mt-0.5 font-mono">{v.detail}</p>}
			<p className="wp-meta mt-1 font-mono">{v.line > 0 ? `${v.file}:${v.line}` : v.file}</p>
			{v.element && <p className="wp-meta mt-0.5 truncate font-mono text-xs">{v.element}</p>}
			{v.suggestion && (
				<p className="wp-tone-green wp-ink mt-1 text-xs">
					{t(`rules.${v.ruleId}.suggestion`, { defaultValue: v.suggestion })}
				</p>
			)}
			{fixId && v.fix && onToggleFix && (
				<label className="mt-2 flex cursor-pointer items-center gap-2 text-xs">
					<input type="checkbox" checked={selected === true} onChange={() => onToggleFix(fixId)} />
					<span>
						{t("fix.propose")} <code className="font-mono">{`${v.fix.attribute}="${v.fix.value}"`}</code>
					</span>
				</label>
			)}
		</Panel>
	);
}
