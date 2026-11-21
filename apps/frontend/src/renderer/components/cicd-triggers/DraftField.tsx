/**
 * One text setting of the CI/CD page, saved when the field loses focus and
 * only when it changed. A secret comes back from main as "***": typing over
 * it replaces it, leaving it keeps the stored value.
 */

import type React from "react";
import { useState } from "react";
import { Input } from "../ui/input";

interface DraftFieldProps {
	readonly id: string;
	readonly label: string;
	readonly value: string;
	readonly type?: string;
	readonly placeholder?: string;
	readonly onSave: (value: string) => void;
}

export function DraftField({ id, label, value, type = "text", placeholder, onSave }: DraftFieldProps): React.ReactElement {
	const [draft, setDraft] = useState<string | undefined>(undefined);
	return (
		<div className="space-y-1">
			<label htmlFor={id} className="wp-meta block">
				{label}
			</label>
			<Input
				id={id}
				type={type}
				value={draft ?? value}
				placeholder={placeholder}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => {
					if (draft === undefined) return;
					if (draft !== value) onSave(draft.trim());
					setDraft(undefined);
				}}
				className="h-8 font-mono text-xs"
			/>
		</div>
	);
}
