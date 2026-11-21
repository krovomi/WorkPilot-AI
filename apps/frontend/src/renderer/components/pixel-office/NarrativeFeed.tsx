import { Sparkles } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { NarrativeRole, ProviderFamily } from "../../../shared/types/pixel-office";
import type { NarrativeEvent } from "../../lib/pixel-office-narratives";
import type { Scene } from "./use-office-narratives";

function role(
	t: TFunction,
	name: NarrativeRole | undefined,
	family: ProviderFamily | undefined,
): string {
	if (!name) return "";
	const label = t(`pixelOffice:narratives.roles.${name}`);
	return family
		? t("pixelOffice:narratives.withEngine", {
				role: label,
				engine: t(`pixelOffice:providers.${family}`),
			})
		: label;
}

/** The scene written from its template, in the app's language. */
export function sceneText(t: TFunction, event: NarrativeEvent): string {
	const spec = event.spec
		? t("pixelOffice:narratives.spec", { number: event.spec })
		: t("pixelOffice:narratives.task", { title: event.title });
	return t(`pixelOffice:narratives.scenes.${event.kind}`, {
		from: role(t, event.from, event.fromFamily),
		to: role(t, event.to, event.toFamily),
		spec,
	});
}

interface NarrativeFeedProps {
	readonly scenes: readonly Scene[];
	/** Calm: scenes appear without a transition. */
	readonly calm: boolean;
}

/**
 * The office's mini-scenes, bottom left, newest last. A screen reader hears
 * each through a polite live region; in TV mode they show the same way.
 */
export function NarrativeFeed({ scenes, calm }: NarrativeFeedProps) {
	const { t } = useTranslation(["pixelOffice"]);
	return (
		<ol
			aria-live="polite"
			aria-label={t("pixelOffice:narratives.title")}
			className="absolute left-3 bottom-24 flex max-w-md flex-col gap-1.5 pointer-events-none"
			style={{ zIndex: 20 }}
		>
			{scenes.map((scene) => (
				<li
					key={scene.id}
					data-testid="office-scene"
					data-ai={scene.text ? "true" : "false"}
					className={`flex items-start gap-2 rounded-lg px-3 py-1.5 text-xs text-white/90 ${calm ? "" : "animate-in fade-in slide-in-from-bottom-1"}`}
					style={{ background: "rgba(20,14,50,0.85)" }}
				>
					<Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-white/50" aria-hidden />
					<span>{scene.text ?? sceneText(t, scene.event)}</span>
				</li>
			))}
		</ol>
	);
}
