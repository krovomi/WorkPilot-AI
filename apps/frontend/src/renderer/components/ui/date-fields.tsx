/**
 * Date, month and time fields written in the app's language.
 *
 * A native `<input type="date">` (and `time`, `month`) draws its text with the
 * operating system's region, not the app's language: a French app on an
 * English Windows showed mm/dd/yyyy. These fields draw their own text and
 * picker from `lib/date-input.ts`: 28/11/2026 and 14:30 in French, the
 * English format unchanged (11/28/2026, 02:30 PM). Their values are the ones
 * a native field gives (YYYY-MM-DD, YYYY-MM, 24-hour HH:MM), so callers keep
 * their state as it was. A guard test (`ui/__tests__/date-fields.test.tsx`)
 * refuses a native date, time or month input anywhere in the renderer.
 */
import { Calendar, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { formatDateIn } from "../../../shared/utils/date-format";
import {
	calendarCells,
	dayOf,
	formatDayField,
	formatMonthField,
	formatTimeField,
	isoMonth,
	monthNames,
	monthTitle,
	parseDayField,
	parseIsoDay,
	parseIsoMonth,
	parseIsoTime,
	parseTimeField,
	shiftDay,
	shiftMonth,
	timeSlots,
	weekdayNames,
	withinBounds,
} from "../../lib/date-input";
import { cn } from "../../lib/utils";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

interface FieldProps {
	id?: string;
	/** YYYY-MM-DD (DateField), YYYY-MM (MonthField) or HH:MM (TimeField); "" when empty. */
	value: string;
	onValueChange: (value: string) => void;
	disabled?: boolean;
	className?: string;
	"aria-label"?: string;
	"aria-describedby"?: string;
}

interface BoundedFieldProps extends FieldProps {
	/** Same shape as the value; the picker and the typing refuse what lies outside. */
	min?: string;
	max?: string;
}

const ICON_BUTTON =
	"absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

const CELL =
	"rounded-md text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30";

/**
 * The text of a field the person types in: shown formatted while it is not
 * being edited, passed up as soon as it means a value, put back as the value
 * when the person leaves it.
 */
function useTypedField(
	value: string,
	format: (value: string) => string,
	parse: (text: string) => string | null,
	accept: (value: string) => boolean,
	onValueChange: (value: string) => void,
) {
	const formatted = format(value);
	const [draft, setDraft] = React.useState(formatted);
	const editing = React.useRef(false);

	React.useEffect(() => {
		if (!editing.current) setDraft(formatted);
	}, [formatted]);

	const parsed = parse(draft);
	const invalid = parsed === null || (parsed !== "" && !accept(parsed));

	return {
		draft,
		invalid,
		onFocus: () => {
			editing.current = true;
		},
		onBlur: () => {
			editing.current = false;
			setDraft(formatted);
		},
		onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
			const text = event.target.value;
			setDraft(text);
			const next = parse(text);
			if (next !== null && (next === "" || accept(next))) onValueChange(next);
		},
	};
}

/** A day typed as 28/11/2026 (French) or 11/28/2026 (English), with a calendar. */
export function DateField({
	id,
	value,
	onValueChange,
	disabled,
	min,
	max,
	className,
	...aria
}: BoundedFieldProps) {
	const { t, i18n } = useTranslation("common");
	// Optional like in Input: some tests stub react-i18next with `t` alone.
	const language = i18n?.language;
	const [open, setOpen] = React.useState(false);
	const field = useTypedField(
		value,
		(day) => formatDayField(day, language),
		(text) => parseDayField(text, language),
		(day) => withinBounds(day, min, max),
		onValueChange,
	);

	const pick = (day: string) => {
		onValueChange(day);
		setOpen(false);
	};

	return (
		<div className={cn("relative", className)}>
			<Input
				id={id}
				type="text"
				inputMode="numeric"
				autoComplete="off"
				spellCheck={false}
				placeholder={t("dateField.placeholder")}
				value={field.draft}
				onChange={field.onChange}
				onFocus={field.onFocus}
				onBlur={field.onBlur}
				disabled={disabled}
				aria-invalid={field.invalid || undefined}
				className="pr-10"
				{...aria}
			/>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<button type="button" disabled={disabled} aria-label={t("dateField.openCalendar")} className={ICON_BUTTON}>
						<Calendar className="h-4 w-4" aria-hidden="true" />
					</button>
				</PopoverTrigger>
				<PopoverContent align="end" className="w-auto p-3">
					<DayCalendar value={value} min={min} max={max} language={language} onPick={pick} />
				</PopoverContent>
			</Popover>
		</div>
	);
}

interface DayCalendarProps {
	value: string;
	min?: string;
	max?: string;
	language: string | undefined;
	onPick: (day: string) => void;
}

const ARROW_STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

/** A month of days, first weekday of the language first; the arrows move between days. */
function DayCalendar({ value, min, max, language, onPick }: DayCalendarProps) {
	const { t } = useTranslation("common");
	const today = dayOf(new Date());
	const [focusDay, setFocusDay] = React.useState(parseIsoDay(value) ? value : today);
	const grid = React.useRef<HTMLDivElement>(null);
	// The grid takes the focus when it opens and when the arrows move it, not when the month buttons do.
	const focusGrid = React.useRef(true);
	const [year, month] = focusDay.split("-").map(Number);

	React.useEffect(() => {
		if (!focusGrid.current) return;
		focusGrid.current = false;
		grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus();
	}, [focusDay]);

	const goToMonth = (delta: number) => {
		const next = shiftMonth(year, month, delta);
		setFocusDay(`${isoMonth(next.year, next.month)}-01`);
	};

	const onKeyDown = (event: React.KeyboardEvent) => {
		const step = ARROW_STEPS[event.key];
		if (!step) return;
		event.preventDefault();
		focusGrid.current = true;
		setFocusDay(shiftDay(focusDay, step));
	};

	return (
		<div className="w-64 space-y-2">
			<div className="flex items-center justify-between">
				<button type="button" className={cn(CELL, "p-1.5 hover:bg-accent")} aria-label={t("dateField.previousMonth")} onClick={() => goToMonth(-1)}>
					<ChevronLeft className="h-4 w-4" aria-hidden="true" />
				</button>
				<span className="text-sm font-medium" aria-live="polite">
					{monthTitle(year, month, language)}
				</span>
				<button type="button" className={cn(CELL, "p-1.5 hover:bg-accent")} aria-label={t("dateField.nextMonth")} onClick={() => goToMonth(1)}>
					<ChevronRight className="h-4 w-4" aria-hidden="true" />
				</button>
			</div>
			<div className="grid grid-cols-7 gap-0.5 text-center text-xs text-muted-foreground" aria-hidden="true">
				{weekdayNames(language).map((name) => (
					<span key={name}>{name}</span>
				))}
			</div>
			<div ref={grid} className="grid grid-cols-7 gap-0.5">
				{calendarCells(year, month, language).map(({ day, inMonth }) => {
					const [y, m, d] = day.split("-").map(Number);
					return (
						<button
							key={day}
							type="button"
							data-day={day}
							tabIndex={day === focusDay ? 0 : -1}
							disabled={!withinBounds(day, min, max)}
							aria-pressed={day === value}
							aria-label={formatDateIn(new Date(y, m - 1, d), language, { dateStyle: "full" })}
							onClick={() => onPick(day)}
							onKeyDown={onKeyDown}
							className={cn(
								CELL,
								"h-8",
								day === value ? "bg-primary text-primary-foreground" : "hover:bg-accent",
								day === today && day !== value && "border border-primary",
								!inMonth && day !== value && "text-muted-foreground/60",
							)}
						>
							{d}
						</button>
					);
				})}
			</div>
			<div className="flex justify-between border-t border-border pt-2">
				<button
					type="button"
					className={cn(CELL, "px-2 py-1 text-primary hover:bg-accent")}
					disabled={!withinBounds(today, min, max)}
					onClick={() => onPick(today)}
				>
					{t("dateField.today")}
				</button>
				<button type="button" className={cn(CELL, "px-2 py-1 hover:bg-accent")} onClick={() => onPick("")}>
					{t("dateField.clear")}
				</button>
			</div>
		</div>
	);
}

/** A month shown as "novembre 2026" / "November 2026", picked from a year of months. */
export function MonthField({
	id,
	value,
	onValueChange,
	disabled,
	min,
	max,
	className,
	...aria
}: BoundedFieldProps) {
	const { t, i18n } = useTranslation("common");
	// Optional like in Input: some tests stub react-i18next with `t` alone.
	const language = i18n?.language;
	const [open, setOpen] = React.useState(false);
	const now = new Date();
	const thisMonth = isoMonth(now.getFullYear(), now.getMonth() + 1);
	const shownYear = parseIsoMonth(value)?.year ?? now.getFullYear();
	const [year, setYear] = React.useState(shownYear);
	const label = formatMonthField(value, language);

	const pick = (next: string) => {
		onValueChange(next);
		setOpen(false);
	};

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (next) setYear(shownYear);
				setOpen(next);
			}}
		>
			<PopoverTrigger asChild>
				<button
					id={id}
					type="button"
					disabled={disabled}
					className={cn(
						"inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-foreground",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
						className,
					)}
					{...aria}
				>
					<span className={cn(!label && "text-muted-foreground")}>{label || t("dateField.monthPlaceholder")}</span>
					<Calendar className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64 space-y-2 p-3">
				<div className="flex items-center justify-between">
					<button type="button" className={cn(CELL, "p-1.5 hover:bg-accent")} aria-label={t("dateField.previousYear")} onClick={() => setYear(year - 1)}>
						<ChevronLeft className="h-4 w-4" aria-hidden="true" />
					</button>
					<span className="text-sm font-medium" aria-live="polite">
						{year}
					</span>
					<button type="button" className={cn(CELL, "p-1.5 hover:bg-accent")} aria-label={t("dateField.nextYear")} onClick={() => setYear(year + 1)}>
						<ChevronRight className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>
				<div className="grid grid-cols-3 gap-1">
					{monthNames(language).map((name, index) => {
						const candidate = isoMonth(year, index + 1);
						return (
							<button
								key={candidate}
								type="button"
								disabled={!withinBounds(candidate, min, max)}
								aria-pressed={candidate === value}
								aria-label={monthTitle(year, index + 1, language)}
								onClick={() => pick(candidate)}
								className={cn(CELL, "h-9", candidate === value ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
							>
								{name}
							</button>
						);
					})}
				</div>
				<div className="flex justify-between border-t border-border pt-2">
					<button
						type="button"
						className={cn(CELL, "px-2 py-1 text-primary hover:bg-accent")}
						disabled={!withinBounds(thisMonth, min, max)}
						onClick={() => pick(thisMonth)}
					>
						{t("dateField.thisMonth")}
					</button>
					<button type="button" className={cn(CELL, "px-2 py-1 hover:bg-accent")} onClick={() => pick("")}>
						{t("dateField.clear")}
					</button>
				</div>
			</PopoverContent>
		</Popover>
	);
}

/** A time typed as 14:30 (French) or 02:30 PM (English), with a list of half hours. */
export function TimeField({ id, value, onValueChange, disabled, className, ...aria }: FieldProps) {
	const { t, i18n } = useTranslation("common");
	// Optional like in Input: some tests stub react-i18next with `t` alone.
	const language = i18n?.language;
	const [open, setOpen] = React.useState(false);
	const list = React.useRef<HTMLDivElement>(null);
	const field = useTypedField(
		value,
		(time) => formatTimeField(time, language),
		parseTimeField,
		() => true,
		onValueChange,
	);
	// The half hour the list opens on: the value's, rounded down.
	const time = parseIsoTime(value);
	const nearest = time ? `${String(time.hours).padStart(2, "0")}:${time.minutes < 30 ? "00" : "30"}` : "09:00";

	const pick = (slot: string) => {
		onValueChange(slot);
		setOpen(false);
	};

	return (
		<div className={cn("relative", className)}>
			<Input
				id={id}
				type="text"
				inputMode="numeric"
				autoComplete="off"
				spellCheck={false}
				placeholder={t("dateField.timePlaceholder")}
				value={field.draft}
				onChange={field.onChange}
				onFocus={field.onFocus}
				onBlur={field.onBlur}
				disabled={disabled}
				aria-invalid={field.invalid || undefined}
				className="pr-10"
				{...aria}
			/>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<button type="button" disabled={disabled} aria-label={t("dateField.openTimes")} className={ICON_BUTTON}>
						<Clock className="h-4 w-4" aria-hidden="true" />
					</button>
				</PopoverTrigger>
				<PopoverContent
					align="end"
					className="w-36 p-1"
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						list.current?.querySelector<HTMLButtonElement>(`[data-time="${nearest}"]`)?.focus();
					}}
				>
					<div ref={list} className="max-h-60 overflow-y-auto">
						{timeSlots().map((slot) => (
							<button
								key={slot}
								type="button"
								data-time={slot}
								aria-pressed={slot === value}
								onClick={() => pick(slot)}
								className={cn(
									CELL,
									"block w-full px-2 py-1 text-left",
									slot === value ? "bg-primary text-primary-foreground" : "hover:bg-accent",
								)}
							>
								{formatTimeField(slot, language)}
							</button>
						))}
					</div>
				</PopoverContent>
			</Popover>
		</div>
	);
}
