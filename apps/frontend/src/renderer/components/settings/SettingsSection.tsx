import { createContext, useContext } from "react";
import { Section, type Tone } from "../charter";

/**
 * The group of the page on screen (Interface & Apparence, Sécurité…), set by the
 * Settings dialog: its title is the kicker above every page title, in its tone.
 */
export const SettingsPageContext = createContext<{
	readonly kicker?: string;
	readonly tone?: Tone;
}>({});

interface SettingsSectionProps {
	readonly title: string;
	readonly description: string;
	readonly children: React.ReactNode;
}

/** A Settings page: the charter section head (kicker, title, description), then the page. */
export function SettingsSection({ title, description, children }: SettingsSectionProps) {
	const { kicker, tone } = useContext(SettingsPageContext);
	return (
		<Section kicker={kicker} title={title} description={description} tone={tone} className="wp-settings-page">
			<div className="space-y-6 pt-2">{children}</div>
		</Section>
	);
}
