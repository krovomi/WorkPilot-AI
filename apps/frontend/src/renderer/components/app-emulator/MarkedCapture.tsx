import { useTranslation } from "react-i18next";
import type { DeviceCapture, ResponsiveIssueKind } from "../../../shared/types/device-matrix";
import { issueMarkers } from "../../../shared/utils/issue-markers";

/** La clé du texte de chaque sorte de bug, partagée avec le résumé du rapport. */
export const ISSUE_KEYS: Record<ResponsiveIssueKind, string> = {
	"horizontal-overflow": "matrix.issues.horizontalOverflow",
	"overflowing-media": "matrix.issues.overflowingMedia",
	"small-touch-target": "matrix.issues.smallTouchTarget",
	"small-text": "matrix.issues.smallText",
	"overlapping-elements": "matrix.issues.overlappingElements",
	"truncated-text": "matrix.issues.truncatedText",
	"broken-navigation": "matrix.issues.brokenNavigation",
};

const percent = (share: number) => `${share * 100}%`;

/**
 * Une capture de la matrice, les éléments fautifs encadrés par-dessus quand
 * `markers` est vrai. Les cadres sont posés en part de l'image, à partir des
 * nombres du rapport que le main a remis en forme : rien de la page n'est
 * interprété ici.
 */
export function MarkedCapture({ capture, name, markers }: { capture: DeviceCapture; name: string; markers: boolean }) {
	const { t } = useTranslation("appEmulator");
	const boxes = markers ? issueMarkers(capture.report, capture.width, capture.height) : [];
	return (
		<div className="relative">
			<img
				src={capture.image}
				alt={t("matrix.imageAlt", { device: name })}
				className="block h-auto w-full border border-border bg-white"
			/>
			{boxes.map((box) => (
				<span
					key={`${box.kind}-${box.selector}-${box.x}-${box.y}-${box.width}-${box.height}`}
					data-marker={box.kind}
					title={`${t(ISSUE_KEYS[box.kind], { count: 1 })} · ${box.selector}`}
					className="pointer-events-auto absolute border-2 border-warning bg-warning/10"
					style={{
						left: percent(box.x),
						top: percent(box.y),
						width: percent(box.width),
						height: percent(box.height),
					}}
				/>
			))}
		</div>
	);
}
