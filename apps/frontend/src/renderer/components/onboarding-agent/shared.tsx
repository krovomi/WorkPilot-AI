import type React from "react";
import { useTranslation } from "react-i18next";
import type { OnboardingText } from "../../../preload/api/modules/onboarding-agent-api";
import { Badge } from "../ui/badge";

/**
 * Pieces shared by the onboarding panels.
 *
 * The labels are translated by the caller: a component that translates on its
 * own would need a namespace of its own, and the six panels already share one.
 */

type BadgeVariant =
	| "default"
	| "secondary"
	| "destructive"
	| "outline"
	| "success"
	| "warning"
	| "info"
	| "purple"
	| "muted";

const DIFFICULTY_VARIANT: Record<string, BadgeVariant> = {
	easy: "success",
	medium: "warning",
	hard: "destructive",
};

const CATEGORY_VARIANT: Record<string, BadgeVariant> = {
	stack: "info",
	files: "purple",
	architecture: "secondary",
	commands: "info",
	conventions: "warning",
	todo: "warning",
	tests: "info",
	docs: "purple",
	explore: "muted",
	directory: "info",
	type: "purple",
	module: "secondary",
	identifier: "muted",
	setup: "info",
	run: "success",
	test: "warning",
	lint: "purple",
	build: "secondary",
};

export function DifficultyBadge({
	difficulty,
	label,
}: {
	readonly difficulty: string;
	readonly label: string;
}): React.ReactElement {
	return (
		<Badge variant={DIFFICULTY_VARIANT[difficulty] ?? "muted"}>{label}</Badge>
	);
}

export function CategoryBadge({
	category,
	label,
}: {
	readonly category: string;
	readonly label: string;
}): React.ReactElement {
	return <Badge variant={CATEGORY_VARIANT[category] ?? "muted"}>{label}</Badge>;
}

export function SectionTitle({
	icon,
	children,
	action,
}: {
	readonly icon?: React.ReactNode;
	readonly children: React.ReactNode;
	readonly action?: React.ReactNode;
}): React.ReactElement {
	return (
		<div className="flex items-center justify-between gap-3 mb-2">
			<h3 className="text-sm font-semibold flex items-center gap-2">
				{icon}
				{children}
			</h3>
			{action}
		</div>
	);
}

export function EmptyState({
	message,
}: {
	readonly message: string;
}): React.ReactElement {
	return (
		<p className="text-sm text-muted-foreground py-6 text-center">{message}</p>
	);
}

/** A command line the reader can copy in one click. */
export function CommandLine({
	command,
	copyLabel,
	onCopy,
}: {
	readonly command: string;
	readonly copyLabel: string;
	readonly onCopy: (command: string) => void;
}): React.ReactElement {
	return (
		<button
			type="button"
			title={copyLabel}
			onClick={() => onCopy(command)}
			className="w-full text-left px-3 py-1.5 rounded bg-muted/60 hover:bg-muted text-xs font-mono text-foreground/90 truncate"
		>
			<span className="text-muted-foreground select-none">$ </span>
			{command}
		</button>
	);
}


/**
 * Resolve a generated string produced by the backend.
 *
 * The onboarding package is written in Python, so its prose arrives as an i18n
 * key plus parameters rather than as a translated sentence. A parameter can
 * itself be a descriptor — a quiz question quoting the role of a directory —
 * so resolution recurses before interpolating. An empty key marks a value that
 * must not be translated (a path, a command, a tool name), and the English
 * fallback covers a key a locale file has not caught up with yet.
 */
export function useGeneratedText(): (
	value: OnboardingText | null | undefined,
	plain?: string,
) => string {
	const { t } = useTranslation("onboardingAgent");

	const resolve = (value: OnboardingText | null | undefined, plain = ""): string => {
		if (!value) return plain;
		if (!value.key) return value.fallback || plain;

		const params: Record<string, unknown> = {};
		for (const [name, param] of Object.entries(value.params ?? {})) {
			params[name] = isDescriptor(param) ? resolve(param) : param;
		}
		return t(value.key, { ...params, defaultValue: value.fallback || plain });
	};

	return resolve;
}

function isDescriptor(value: unknown): value is OnboardingText {
	return (
		typeof value === "object" &&
		value !== null &&
		"key" in value &&
		"fallback" in value
	);
}
