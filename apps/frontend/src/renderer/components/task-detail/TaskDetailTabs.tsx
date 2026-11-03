/**
 * The tab bar of the task panel (Overview, Subtasks, Logs, Files...).
 *
 * One rail under the whole bar; the selected tab sits on it with a thick
 * underline in the theme's primary colour, a tinted background and full-contrast
 * text, so it reads at a glance in every theme. Inactive tabs stay quiet
 * (muted text, no border) and only light up on hover or keyboard focus. The
 * bar scrolls sideways instead of clipping when the panel is narrow.
 */
import type * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";
import { cn } from "../../lib/utils";
import { TabsList, TabsTrigger } from "../ui/tabs";

export const TaskDetailTabsList = React.forwardRef<
	React.ElementRef<typeof TabsPrimitive.List>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
	<TabsList
		ref={ref}
		className={cn(
			"flex h-auto w-full shrink-0 items-end justify-start gap-1 overflow-x-auto overflow-y-hidden",
			"rounded-none border-b border-border bg-transparent px-5 pt-1.5 pb-0",
			"[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
			className,
		)}
		{...props}
	/>
));
TaskDetailTabsList.displayName = "TaskDetailTabsList";

export const TaskDetailTab = React.forwardRef<
	React.ElementRef<typeof TabsPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
	<TabsTrigger
		ref={ref}
		className={cn(
			// -mb-px puts the underline on the rail instead of above it.
			"relative -mb-px shrink-0 rounded-none rounded-t-md border-b-[3px] border-transparent px-3.5 py-2.5 text-sm",
			"focus-visible:ring-offset-0 focus-visible:ring-inset",
			"data-[state=inactive]:text-muted-foreground",
			"data-[state=inactive]:hover:bg-muted/60 data-[state=inactive]:hover:text-foreground",
			"data-[state=active]:border-primary data-[state=active]:bg-primary/15",
			"data-[state=active]:text-foreground data-[state=active]:shadow-none",
			className,
		)}
		{...props}
	/>
));
TaskDetailTab.displayName = "TaskDetailTab";
