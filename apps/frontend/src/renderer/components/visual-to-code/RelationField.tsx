import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input, NativeSelect } from "../ui";

/** The select's value for "type my own", never a relation anyone would pick. */
const CUSTOM = "__workpilot_custom_relation__";

interface RelationFieldProps {
	id: string;
	value: string;
	/** Relations usual for this pair and these stacks, most likely first. */
	options: string[];
	onChange: (label: string) => void;
	className?: string;
}

/**
 * The relation of a connection: a drop-down of what usually links these two
 * blocks (HTTP / REST, gRPC, SignalR, EF Core, AMQP…), ending with a free-text
 * entry for anything the list does not foresee. A relation typed earlier, or
 * one the list does not know, opens on the free-text entry with it kept.
 */
export function RelationField({
	id,
	value,
	options,
	onChange,
	className,
}: RelationFieldProps) {
	const { t } = useTranslation("visualProgramming");
	// Chosen "type my own". A relation the list does not know (typed earlier,
	// or on the canvas) shows the free-text field whatever this says. The
	// inspector keys this field by edge, so another edge starts afresh.
	const [chose, setChose] = useState(false);
	const typing = chose || !(value === "" || options.includes(value));
	const inputRef = useRef<HTMLInputElement>(null);

	if (options.length === 0) {
		return (
			<Input
				id={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={t("edgeRelationPlaceholder", "ex. HTTP / REST")}
				className={className}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-1.5">
			<NativeSelect
				id={id}
				value={typing ? CUSTOM : value}
				onChange={(e) => {
					if (e.target.value === CUSTOM) {
						setChose(true);
						// Start from a blank field: the relation they want is not listed.
						if (options.includes(value)) onChange("");
						requestAnimationFrame(() => inputRef.current?.focus());
						return;
					}
					setChose(false);
					onChange(e.target.value);
				}}
				className={className}
			>
				{value === "" && !typing ? (
					<option value="">{t("edgeRelationChoose", "Choisir une relation…")}</option>
				) : null}
				{options.map((o) => (
					<option key={o} value={o}>
						{o}
					</option>
				))}
				<option value={CUSTOM}>{t("edgeRelationCustom", "Autre (saisie libre)…")}</option>
			</NativeSelect>
			{typing ? (
				<Input
					ref={inputRef}
					aria-label={t("edgeRelationCustomLabel", "Relation personnalisée")}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={t("edgeRelationPlaceholder", "ex. HTTP / REST")}
					className={className}
				/>
			) : null}
		</div>
	);
}
