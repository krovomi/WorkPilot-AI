import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

const FORMATS = [
	{ id: "phone", width: 390, height: 844 },
	{ id: "phoneSmall", width: 360, height: 640 },
	{ id: "phoneLarge", width: 430, height: 932 },
	{ id: "tablet", width: 768, height: 1024 },
	{ id: "desktop", width: 1440, height: 900 },
	...[640, 768, 1024, 1280, 1536].map((width) => ({
		id: `bp${width}`,
		width,
		height: 900,
	})),
];

/** CSS viewport simulation: dimensions change media queries, zoom only scales the preview. */
export function ResponsivePreview({
	url,
	refreshKey,
}: {
	url: string;
	refreshKey: number;
}) {
	const { t } = useTranslation("appEmulator");
	const viewRef = useRef<Electron.WebviewTag>(null);
	const [format, setFormat] = useState("fluid");
	const [size, setSize] = useState({ width: 390, height: 844 });
	const [zoom, setZoom] = useState(1);
	const [loading, setLoading] = useState(true);
	const [failure, setFailure] = useState<string | null>(null);
	const [retry, setRetry] = useState(0);
	// The key replaces the webview DOM node, so each replacement needs fresh listeners.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reattach after keyed webview replacement
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		let timer: ReturnType<typeof setTimeout>;
		const start = () => {
			clearTimeout(timer);
			setLoading(true);
			setFailure(null);
			timer = setTimeout(() => {
				setLoading(false);
				setFailure(t("preview.timeout"));
			}, 30000);
		};
		const finish = () => {
			clearTimeout(timer);
			setLoading(false);
		};
		const fail = (event: Event) => {
			const details = event as Electron.DidFailLoadEvent;
			if (details.errorCode === -3 || details.isMainFrame === false) return;
			finish();
			setFailure(
				`${t("preview.failed")} ${details.errorDescription || details.errorCode}`,
			);
		};
		const navigate = (event: Event) => {
			const code = (event as Event & { httpResponseCode: number }).httpResponseCode;
			if (code >= 400) {
				finish();
				setFailure(
					t(code === 404 ? "preview.notFound" : "preview.httpError", { code }),
				);
			} else if (code >= 200) {
				finish();
				setFailure(null);
			}
		};
		const crash = () => {
			finish();
			setFailure(t("preview.crashed"));
		};
		view.addEventListener("did-start-loading", start);
		view.addEventListener("did-stop-loading", finish);
		view.addEventListener("did-fail-load", fail);
		view.addEventListener("render-process-gone", crash);
		view.addEventListener("did-navigate", navigate);
		start();
		return () => {
			clearTimeout(timer);
			view.removeEventListener("did-start-loading", start);
			view.removeEventListener("did-stop-loading", finish);
			view.removeEventListener("did-fail-load", fail);
			view.removeEventListener("render-process-gone", crash);
			view.removeEventListener("did-navigate", navigate);
		};
	}, [url, refreshKey, retry, t]);
	const fluid = format === "fluid";
	const controlClass =
		"rounded-md border border-input bg-background px-2 py-1 text-sm";
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-2">
				<label className="flex items-center gap-2 text-sm">
					{t("preview.format")}
					<select
						className={controlClass}
						value={format}
						onChange={(event) => {
							setFormat(event.target.value);
							const selected = FORMATS.find(
								(item) => item.id === event.target.value,
							);
							if (selected)
								setSize({ width: selected.width, height: selected.height });
						}}
					>
						<option value="fluid">{t("preview.fluid")}</option>
						{FORMATS.map((item) => (
							<option key={item.id} value={item.id}>
								{item.id.startsWith("bp")
									? t("preview.breakpoint", { width: item.width })
									: t(`preview.${item.id}`)}{" "}
								— {item.width} × {item.height}
							</option>
						))}
						<option value="custom">{t("preview.custom")}</option>
					</select>
				</label>
				{!fluid && (
					<>
						{(["width", "height"] as const).map((axis) => (
							<DimensionInput
								key={axis}
								label={t(`preview.${axis}`)}
								value={size[axis]}
								className={`${controlClass} w-20`}
								onCommit={(value) => {
									setSize((current) => ({ ...current, [axis]: value }));
									setFormat("custom");
								}}
							/>
						))}
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								setSize((current) => ({
									width: current.height,
									height: current.width,
								}));
								setFormat("custom");
							}}
						>
							{t("preview.rotate")}
						</Button>
						<label className="flex items-center gap-1 text-sm">
							{t("preview.zoom")}
							<select
								className={controlClass}
								value={zoom}
								onChange={(event) => setZoom(Number(event.target.value))}
							>
								{[0.25, 0.5, 0.75, 1].map((value) => (
									<option key={value} value={value}>
										{value * 100}%
									</option>
								))}
							</select>
						</label>
					</>
				)}
			</div>
			{loading && (
				<div
					role="status"
					className="shrink-0 p-2 text-sm text-muted-foreground"
				>
					{t("preview.loading")}
				</div>
			)}
			{failure && (
				<div
					role="alert"
					className="shrink-0 space-y-2 border-b border-border p-3 text-sm"
				>
					<p>{failure}</p>
					<p className="break-all text-muted-foreground">{url}</p>
					<Button
						size="sm"
						variant="outline"
						onClick={() => setRetry((value) => value + 1)}
					>
						{t("actions.retry")}
					</Button>
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-auto bg-muted/30">
				<div
					className="mx-auto"
					style={
						fluid
							? { width: "100%", height: "100%" }
							: { width: size.width * zoom, height: size.height * zoom }
					}
				>
					<webview
						key={`${url}-${refreshKey}-${retry}`}
						ref={viewRef}
						src={url}
						className="border-0 bg-white"
						style={{
							display: "flex",
							flexShrink: 0,
							width: fluid ? "100%" : size.width,
							height: fluid ? "100%" : size.height,
							transform: fluid ? undefined : `scale(${zoom})`,
							transformOrigin: "top left",
						}}
					/>
				</div>
			</div>
		</div>
	);
}

function DimensionInput({
	label,
	value,
	className,
	onCommit,
}: {
	label: string;
	value: number;
	className: string;
	onCommit: (value: number) => void;
}) {
	const [draft, setDraft] = useState(String(value));
	useEffect(() => setDraft(String(value)), [value]);
	return (
		<label className="flex items-center gap-1 text-sm">
			{label}
			<input
				className={className}
				type="number"
				min={240}
				max={3840}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					const parsed = Number(draft);
					if (!draft.trim() || !Number.isFinite(parsed)) {
						setDraft(String(value));
						return;
					}
					const next = Math.min(3840, Math.max(240, Math.round(parsed)));
					setDraft(String(next));
					onCommit(next);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
				}}
			/>
		</label>
	);
}
