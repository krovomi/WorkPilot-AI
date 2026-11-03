/**
 * A native `<select>` styled like `Input`. Views used the bare element with
 * their own borders, backgrounds and focus styles, so every dropdown looked a
 * little different. Use this when a plain `onChange` select is enough; `Select`
 * (Radix) remains the choice for rich options or search.
 */
import * as React from "react";
import { cn } from "../../lib/utils";

export interface NativeSelectProps
	extends React.SelectHTMLAttributes<HTMLSelectElement> {}

const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
	({ className, ...props }, ref) => (
		<select
			className={cn(
				"h-9 rounded-lg border border-border bg-card px-2 text-sm text-foreground",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-primary",
				"disabled:cursor-not-allowed disabled:opacity-50",
				"transition-colors duration-200",
				className,
			)}
			ref={ref}
			{...props}
		/>
	),
);
NativeSelect.displayName = "NativeSelect";

export { NativeSelect };
