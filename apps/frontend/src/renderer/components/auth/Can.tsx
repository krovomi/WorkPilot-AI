/**
 * Render children only when the user holds the required permission.
 *
 * A convenience for readable JSX, not a security control — the backend checks
 * the same permission on every request, and this only spares the user a button
 * that would answer 403.
 */
import type { ReactNode } from "react";
import { useAnyPermission, usePermission } from "@/stores/permissions-store";

interface CanProps {
	/** Permission key, e.g. "task.merge". */
	readonly permission?: string;
	/** Any one of these is enough. */
	readonly anyOf?: string[];
	/** Rendered instead when the permission is absent. */
	readonly fallback?: ReactNode;
	readonly children: ReactNode;
}

export function Can({ permission, anyOf, fallback = null, children }: CanProps) {
	const single = usePermission(permission ?? "");
	const any = useAnyPermission(anyOf ?? []);

	// `anyOf: []` means "nothing required" rather than "nothing allowed", so an
	// empty list must not hide the children.
	const allowed = permission ? single : anyOf && anyOf.length > 0 ? any : true;

	return <>{allowed ? children : fallback}</>;
}
