import type { ReactNode } from "react";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

/** One themed block of the General settings: a title, one line on what it covers. */
export function SettingsGroup({
	title,
	description,
	children,
}: {
	readonly title: string;
	readonly description?: string;
	readonly children: ReactNode;
}) {
	return (
		<section className="space-y-4">
			<div className="space-y-0.5">
				<h3 className="text-sm font-semibold text-foreground">{title}</h3>
				{description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
			</div>
			<div className="space-y-4">{children}</div>
		</section>
	);
}

/** A setting that is a switch, with its label and what it does. */
export function SwitchRow({
	id,
	label,
	description,
	checked,
	onCheckedChange,
}: {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly checked: boolean;
	readonly onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex items-center justify-between gap-4">
			<div className="space-y-0.5">
				<Label htmlFor={id} className="font-normal text-foreground">
					{label}
				</Label>
				{description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
			</div>
			<Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
		</div>
	);
}
