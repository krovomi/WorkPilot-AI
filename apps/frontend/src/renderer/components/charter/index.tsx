/**
 * WorkPilot UI charter primitives (docs/architecture/ui-charter.md).
 *
 * The look of "Visuel vers Code" / "Import Design" for every feature module
 * and Settings page: a stage with a dot grid and a warm glow, columns opened
 * by a mono kicker, solid cards with an accent rail, mono chips, one glowing
 * primary action. Build a view from these instead of hand-written Tailwind so
 * moving from one module to the next keeps the same type scale, spacing and
 * colours. The classes live in charter.css (`.wp-*`).
 */
import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils";
import "./charter.css";

export type Tone =
	| "accent"
	| "blue"
	| "amber"
	| "violet"
	| "orange"
	| "green"
	| "pink"
	| "red"
	| "muted";

export const toneClass = (tone: Tone | undefined): string | undefined =>
	tone ? `wp-tone-${tone}` : undefined;

// ── Stage & layout ──────────────────────────────────────────────────────────

export interface ModuleStageProps {
	readonly children: React.ReactNode;
	/** `page`: the whole stage scrolls (Settings, single-column modules). */
	readonly scroll?: "columns" | "page";
	readonly className?: string;
	readonly "data-testid"?: string;
}

/** The root of a module: theme background, dot grid, warm ambient glow. */
export function ModuleStage({
	children,
	scroll = "columns",
	className,
	...rest
}: ModuleStageProps): React.ReactElement {
	return (
		<div
			className={cn("wp-stage", scroll === "page" && "wp-stage-page", className)}
			data-testid={rest["data-testid"]}
		>
			<div className="wp-ambient" aria-hidden="true" />
			{children}
		</div>
	);
}

export interface ModuleHeaderProps {
	readonly kicker: React.ReactNode;
	readonly title: React.ReactNode;
	readonly description?: React.ReactNode;
	readonly icon?: LucideIcon;
	readonly actions?: React.ReactNode;
	readonly tone?: Tone;
}

/** The band a module opens with: kicker, title, one line, actions. */
export function ModuleHeader({
	kicker,
	title,
	description,
	icon: Icon,
	actions,
	tone,
}: ModuleHeaderProps): React.ReactElement {
	return (
		<header className={cn("wp-header", toneClass(tone))}>
			<div className="flex min-w-0 items-center gap-3">
				{Icon && (
					<span className="wp-empty-glyph h-9 w-9 shrink-0" aria-hidden="true">
						<Icon className="h-4 w-4" />
					</span>
				)}
				<div className="wp-header-text">
					<span className="wp-kicker">{kicker}</span>
					<h1 className="wp-title wp-title-lg">{title}</h1>
					{description && <p className="wp-header-desc">{description}</p>}
				</div>
			</div>
			{actions && <div className="wp-header-actions">{actions}</div>}
		</header>
	);
}

export interface ColumnsProps {
	readonly children: React.ReactNode;
	/** A CSS grid-template-columns value; three equal columns by default. */
	readonly template?: string;
	readonly className?: string;
}

/** Side-by-side columns separated by a dashed rule (one column under 1100px). */
export function Columns({ children, template, className }: ColumnsProps): React.ReactElement {
	return (
		<div
			className={cn("wp-columns", className)}
			style={template ? ({ "--wp-cols": template } as React.CSSProperties) : undefined}
		>
			{children}
		</div>
	);
}

export interface ColumnProps {
	readonly kicker: React.ReactNode;
	readonly title: React.ReactNode;
	readonly meta?: React.ReactNode;
	readonly tone?: Tone;
	readonly actions?: React.ReactNode;
	readonly children: React.ReactNode;
	readonly className?: string;
	readonly "aria-label"?: string;
}

/** One column: kicker + title + meta on the right, then its content. */
export function Column({
	kicker,
	title,
	meta,
	tone,
	actions,
	children,
	className,
	...rest
}: ColumnProps): React.ReactElement {
	return (
		<section className={cn("wp-col", className)} aria-label={rest["aria-label"]}>
			<ColumnHead kicker={kicker} title={title} meta={meta} tone={tone} actions={actions} />
			{children}
		</section>
	);
}

export function ColumnHead({
	kicker,
	title,
	meta,
	tone,
	actions,
}: Omit<ColumnProps, "children" | "className">): React.ReactElement {
	return (
		<div className={cn("wp-colhead", toneClass(tone))}>
			<div className="min-w-0">
				<div className="wp-kicker">{kicker}</div>
				<h2 className="wp-title truncate">{title}</h2>
			</div>
			{(meta || actions) && (
				<div className="flex shrink-0 items-center gap-2">
					{meta && <span className="wp-meta">{meta}</span>}
					{actions}
				</div>
			)}
		</div>
	);
}

/** A scrolling single-column page with sections (Settings, simple modules). */
export function Page({
	children,
	className,
}: {
	readonly children: React.ReactNode;
	readonly className?: string;
}): React.ReactElement {
	return <div className={cn("wp-page", className)}>{children}</div>;
}

export interface SectionProps {
	readonly kicker: React.ReactNode;
	readonly title: React.ReactNode;
	readonly description?: React.ReactNode;
	readonly meta?: React.ReactNode;
	readonly tone?: Tone;
	readonly actions?: React.ReactNode;
	readonly children?: React.ReactNode;
	readonly className?: string;
}

/** A section of a page: same head as a column, dashed rule between sections. */
export function Section({
	kicker,
	title,
	description,
	meta,
	tone,
	actions,
	children,
	className,
}: SectionProps): React.ReactElement {
	return (
		<section className={cn("wp-section", className)}>
			<ColumnHead kicker={kicker} title={title} meta={meta} tone={tone} actions={actions} />
			{description && <p className="wp-header-desc -mt-1 mb-3">{description}</p>}
			{children}
		</section>
	);
}

// ── Surfaces ────────────────────────────────────────────────────────────────

export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
	readonly tone?: Tone;
	/** Accent rail on the left, the canvas block look. */
	readonly rail?: boolean;
	readonly padded?: boolean;
}

export function Panel({
	tone,
	rail,
	padded = true,
	className,
	children,
	...rest
}: PanelProps): React.ReactElement {
	return (
		<div
			className={cn("wp-card", padded && "wp-card-pad", rail && "wp-rail", toneClass(tone), className)}
			{...rest}
		>
			{children}
		</div>
	);
}

export interface StepCardProps {
	readonly index?: number;
	readonly kicker: React.ReactNode;
	readonly title: React.ReactNode;
	readonly meta?: React.ReactNode;
	readonly tone?: Tone;
	readonly active?: boolean;
	readonly status?: React.ReactNode;
	readonly onClick?: () => void;
	readonly children?: React.ReactNode;
	readonly className?: string;
}

/** "01 · VISION" / title / mono meta, with an accent rail; clickable when onClick. */
export function StepCard({
	index,
	kicker,
	title,
	meta,
	tone,
	active,
	status,
	onClick,
	children,
	className,
}: StepCardProps): React.ReactElement {
	const body = (
		<>
			<span className="wp-step-top">
				<span className="wp-kicker">
					{index !== undefined && `${String(index).padStart(2, "0")} · `}
					{kicker}
				</span>
				{status}
			</span>
			<span className="wp-step-title">{title}</span>
			{meta && <span className="wp-step-meta">{meta}</span>}
			{children}
		</>
	);
	const classes = cn("wp-card wp-rail wp-step", toneClass(tone), className);
	if (onClick) {
		return (
			<button
				type="button"
				className={classes}
				data-active={active ? "true" : undefined}
				aria-pressed={active}
				onClick={onClick}
			>
				{body}
			</button>
		);
	}
	return (
		<div className={classes} data-active={active ? "true" : undefined}>
			{body}
		</div>
	);
}

// ── Chips & buttons ─────────────────────────────────────────────────────────

export interface ChipProps {
	readonly children: React.ReactNode;
	readonly tone?: Tone;
	readonly dot?: boolean;
	/** Makes the chip a toggle (filters). */
	readonly pressed?: boolean;
	readonly onClick?: () => void;
	readonly title?: string;
}

export function Chip({ children, tone, dot = true, pressed, onClick, title }: ChipProps): React.ReactElement {
	const cls = cn("wp-chip", toneClass(tone));
	if (onClick) {
		return (
			<button
				type="button"
				className={cls}
				data-dot={dot ? undefined : "false"}
				aria-pressed={pressed}
				onClick={onClick}
				title={title}
			>
				{children}
			</button>
		);
	}
	return (
		<span className={cls} data-dot={dot ? undefined : "false"} title={title}>
			{children}
		</span>
	);
}

export function Chips({ children }: { readonly children: React.ReactNode }): React.ReactElement {
	return <div className="wp-chips">{children}</div>;
}

export interface CharterButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	readonly variant?: "default" | "primary" | "ghost" | "danger";
	readonly size?: "md" | "sm";
	readonly icon?: LucideIcon;
	readonly busy?: boolean;
}

/** Charter button: one `primary` per screen (the glowing warm action). */
export function CharterButton({
	variant = "default",
	size = "md",
	icon: Icon,
	busy,
	className,
	children,
	type = "button",
	...rest
}: CharterButtonProps): React.ReactElement {
	return (
		<button
			type={type}
			className={cn(
				"wp-btn",
				variant !== "default" && `wp-btn-${variant}`,
				size === "sm" && "wp-btn-sm",
				className,
			)}
			aria-busy={busy || undefined}
			{...rest}
		>
			{Icon && <Icon className={cn("h-3.5 w-3.5", busy && "animate-spin")} aria-hidden="true" />}
			{children}
		</button>
	);
}

// ── Feedback ────────────────────────────────────────────────────────────────

export interface NoticeProps {
	readonly tone?: Tone;
	readonly icon?: LucideIcon;
	readonly children: React.ReactNode;
	readonly role?: "alert" | "status";
	readonly className?: string;
}

export function Notice({ tone = "accent", icon: Icon, children, role, className }: NoticeProps): React.ReactElement {
	return (
		<div className={cn("wp-notice", toneClass(tone), className)} role={role}>
			{Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}

export interface StatProps {
	readonly label: React.ReactNode;
	readonly value: React.ReactNode;
	readonly tone?: Tone;
}

export function Stat({ label, value, tone }: StatProps): React.ReactElement {
	return (
		<div className={cn("wp-card wp-stat", toneClass(tone))}>
			<span className="wp-kicker wp-faint" style={{ color: "var(--wp-faint)" }}>
				{label}
			</span>
			<span className="wp-stat-value">{value}</span>
		</div>
	);
}

export function Stats({ children }: { readonly children: React.ReactNode }): React.ReactElement {
	return <div className="wp-stats">{children}</div>;
}

export interface EmptyStageProps {
	readonly icon: LucideIcon;
	readonly title: React.ReactNode;
	readonly children?: React.ReactNode;
	readonly tone?: Tone;
	readonly action?: React.ReactNode;
}

/** What a column shows before there is anything to show. */
export function EmptyStage({ icon: Icon, title, children, tone, action }: EmptyStageProps): React.ReactElement {
	return (
		<div className={cn("wp-empty", toneClass(tone))}>
			<span className="wp-empty-glyph" aria-hidden="true">
				<Icon className="h-4 w-4" />
			</span>
			<span className="wp-empty-title">{title}</span>
			{children && <span className="max-w-xs">{children}</span>}
			{action}
		</div>
	);
}

/** A thin animated line while something runs. */
export function ScanLine({ label }: { readonly label?: React.ReactNode }): React.ReactElement {
	return (
		<div className="flex flex-col gap-1.5" role="status" aria-live="polite">
			<div className="wp-scanline" />
			{label && <span className="wp-meta">{label}</span>}
		</div>
	);
}

export interface GaugeProps {
	readonly value: number;
	readonly tone?: Tone;
	readonly size?: number;
	readonly label?: React.ReactNode;
}

/** A ring gauge, 0-100. */
export function Gauge({ value, tone, size = 84, label }: GaugeProps): React.ReactElement {
	const clamped = Math.max(0, Math.min(100, value));
	return (
		<div className={cn("wp-gauge", toneClass(tone))} style={{ width: size, height: size }}>
			<svg width={size} height={size} viewBox="0 0 36 36" aria-hidden="true">
				<circle className="wp-gauge-track" cx="18" cy="18" r="15.9155" fill="none" strokeWidth="3" />
				<circle
					className="wp-gauge-value"
					cx="18"
					cy="18"
					r="15.9155"
					fill="none"
					strokeWidth="3"
					strokeLinecap="round"
					strokeDasharray={`${clamped} 100`}
				/>
			</svg>
			<span className="wp-gauge-label">{label ?? `${Math.round(clamped)}%`}</span>
		</div>
	);
}

/** A thin horizontal bar, 0-100. */
export function Bar({ value, tone }: { readonly value: number; readonly tone?: Tone }): React.ReactElement {
	return (
		<span className={cn("wp-bar block", toneClass(tone))} aria-hidden="true">
			<i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
		</span>
	);
}

// ── Composer ────────────────────────────────────────────────────────────────

export interface ComposerProps {
	/** The prompt row's left part (an input, a path picker...). */
	readonly prompt?: React.ReactNode;
	readonly actions?: React.ReactNode;
	/** Options shown under the prompt (fields: "Source  Screenshot ▾", chips). */
	readonly options?: React.ReactNode;
	/** A one-line hint shown in the options row when there are no options. */
	readonly hint?: React.ReactNode;
}

/**
 * The bottom bar of a module: "> prompt" and the actions on top, options (or
 * a hint) underneath. The second row is always there: it keeps the actions
 * above the activity pill that floats at the bottom right of the window.
 */
export function Composer({ prompt, actions, options, hint }: ComposerProps): React.ReactElement {
	return (
		<div className="wp-card wp-composer">
			<div className="wp-composer-row">
				{prompt && <div className="wp-prompt">{prompt}</div>}
				{actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
			</div>
			<div className="wp-composer-row min-h-[1.6rem] pr-[16rem]">
				{options ?? <span className="wp-meta whitespace-normal">{hint}</span>}
			</div>
		</div>
	);
}

/** "Label  value" field shown in a composer's options row. */
export function Field({ label, children }: { readonly label: React.ReactNode; readonly children: React.ReactNode }): React.ReactElement {
	return (
		<span className="wp-field">
			{label}
			<b>{children}</b>
		</span>
	);
}
