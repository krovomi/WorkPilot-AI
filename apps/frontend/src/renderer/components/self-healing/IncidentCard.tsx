import type { Incident } from "@shared/types/self-healing";
import {
	AlertTriangle,
	CheckCircle2,
	CircleDashed,
	FlaskConical,
	GitPullRequest,
	type LucideIcon,
	RotateCcw,
	Search,
	Wrench,
	X,
	XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatAppDateTime } from "@/lib/date-format";
import { CharterButton, Chip, Chips, Panel, type Tone } from "../charter";

interface IncidentCardProps {
	readonly incident: Incident;
	readonly onTriggerFix?: (id: string) => void;
	readonly onDismiss?: (id: string) => void;
	readonly onRetry?: (id: string) => void;
}

const SEVERITY_TONE: Record<string, Tone> = {
	critical: "red",
	high: "orange",
	medium: "amber",
	low: "blue",
	info: "muted",
};

const STATUS_ICON: Record<string, LucideIcon> = {
	pending: CircleDashed,
	analyzing: Search,
	fixing: Wrench,
	qa_running: FlaskConical,
	pr_created: GitPullRequest,
	resolved: CheckCircle2,
	escalated: AlertTriangle,
	failed: XCircle,
};

/** One incident: severity rail, what broke, the files it touches, its actions. */
export function IncidentCard({ incident, onTriggerFix, onDismiss, onRetry }: IncidentCardProps) {
	const { t } = useTranslation(["selfHealing", "common"]);
	const isActionable = ["pending", "failed", "escalated"].includes(incident.status);
	const tone = SEVERITY_TONE[incident.severity] ?? "muted";
	const StatusIcon = STATUS_ICON[incident.status] ?? CircleDashed;

	return (
		<Panel rail tone={tone}>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="mb-1 flex items-center gap-2">
						<StatusIcon className="h-3.5 w-3.5 text-[var(--wp-tone)]" aria-hidden="true" />
						<span className="wp-kicker">
							{incident.severity} · {incident.mode}
						</span>
					</div>
					<h4 className="wp-step-title truncate">{incident.title}</h4>
					<p className="wp-muted mt-1 line-clamp-2 text-xs">{incident.description}</p>
					{incident.status === "escalated" && (
						<p className="mt-1 text-xs text-warning">
							{t("selfHealing:needsReview")}
							{incident.error_message && ` — ${incident.error_message}`}
						</p>
					)}
					{incident.affected_files.length > 0 && (
						<div className="mt-2">
							<Chips>
								{incident.affected_files.slice(0, 3).map((file) => (
									<Chip key={file} tone="muted" dot={false} title={file}>
										{file.split("/").pop()}
									</Chip>
								))}
								{incident.affected_files.length > 3 && (
									<span className="wp-meta">+{incident.affected_files.length - 3}</span>
								)}
							</Chips>
						</div>
					)}
					{incident.fix_pr_url && (
						<a
							href={incident.fix_pr_url}
							className="mt-1 inline-block text-xs text-primary hover:underline"
							target="_blank"
							rel="noopener noreferrer"
						>
							{t("selfHealing:viewPR")}
						</a>
					)}
				</div>

				{isActionable && (
					<div className="flex flex-col gap-1">
						{incident.status === "pending" && onTriggerFix && (
							<CharterButton size="sm" icon={Wrench} onClick={() => onTriggerFix(incident.id)}>
								{t("selfHealing:fix")}
							</CharterButton>
						)}
						{incident.status === "failed" && onRetry && (
							<CharterButton size="sm" icon={RotateCcw} onClick={() => onRetry(incident.id)}>
								{t("selfHealing:retry")}
							</CharterButton>
						)}
						{onDismiss && (
							<CharterButton size="sm" variant="ghost" icon={X} onClick={() => onDismiss(incident.id)}>
								{t("selfHealing:dismiss")}
							</CharterButton>
						)}
					</div>
				)}
			</div>
			<div className="wp-meta mt-2">{formatAppDateTime(incident.created_at)}</div>
		</Panel>
	);
}
