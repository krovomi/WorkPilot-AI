import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
	<SelectPrimitive.Trigger
		ref={ref}
		className={cn(
			"flex h-10 w-full items-center justify-between rounded-lg",
			"border border-border bg-card px-3 py-2 text-sm",
			"text-foreground placeholder:text-muted-foreground",
			"focus:outline-none focus:ring-2 focus:ring-ring focus:border-primary",
			"disabled:cursor-not-allowed disabled:opacity-50",
			"transition-colors duration-200",
			"[&>span]:line-clamp-1",
			className,
		)}
		{...props}
	>
		{children}
		<SelectPrimitive.Icon asChild>
			<ChevronDown className="h-4 w-4 text-muted-foreground" />
		</SelectPrimitive.Icon>
	</SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
	<SelectPrimitive.ScrollUpButton
		ref={ref}
		className={cn(
			"flex cursor-default items-center justify-center py-1",
			className,
		)}
		{...props}
	>
		<ChevronUp className="h-4 w-4 text-muted-foreground" />
	</SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
	<SelectPrimitive.ScrollDownButton
		ref={ref}
		className={cn(
			"flex cursor-default items-center justify-center py-1",
			className,
		)}
		{...props}
	>
		<ChevronDown className="h-4 w-4 text-muted-foreground" />
	</SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName =
	SelectPrimitive.ScrollDownButton.displayName;

const SelectContent = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> & {
		searchable?: boolean;
	}
>(
	(
		{ className, children, position = "popper", searchable = false, ...props },
		ref,
	) => {
		const { t, i18n } = useTranslation("common");
		const [query, setQuery] = React.useState("");
		const inputRef = React.useRef<HTMLInputElement>(null);
		const contentRef = React.useRef<HTMLDivElement | null>(null);
		const textOf = (node: React.ReactNode): string => {
			if (typeof node === "string" || typeof node === "number")
				return String(node);
			if (React.isValidElement<{ children?: React.ReactNode }>(node))
				return textOf(node.props.children);
			return React.Children.toArray(node).map(textOf).join(" ");
		};
		const options = React.Children.toArray(children);
		const labelOf = (node: React.ReactNode) =>
			React.isValidElement<{ textValue?: string; children?: React.ReactNode }>(
				node,
			)
				? node.props.textValue || textOf(node.props.children)
				: textOf(node);
		const sorted = searchable
			? options.sort((a, b) =>
					labelOf(a).localeCompare(labelOf(b), i18n.language, {
						sensitivity: "base",
						numeric: true,
					}),
				)
			: options;
		const matches = sorted.filter((node) => {
			const value = React.isValidElement<{ value?: string }>(node)
				? node.props.value || ""
				: "";
			return `${labelOf(node)} ${value}`
				.toLocaleLowerCase(i18n.language)
				.includes(query.trim().toLocaleLowerCase(i18n.language));
		});
		return (
			<SelectPrimitive.Portal>
				<SelectPrimitive.Content
					ref={(node) => {
						contentRef.current = node;
						if (typeof ref === "function") ref(node);
						else if (ref) ref.current = node;
					}}
					className={cn(
						"relative z-70 max-h-96 min-w-32 overflow-hidden",
						"rounded-lg border border-border bg-card text-foreground shadow-lg",
						"data-[state=open]:animate-in data-[state=closed]:animate-out",
						"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
						"data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
						"data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
						"data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
						position === "popper" &&
							"data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
						className,
					)}
					position={position}
					{...props}
					onCloseAutoFocus={(event) => {
						setQuery("");
						props.onCloseAutoFocus?.(event);
					}}
					onKeyDown={(event) => {
						props.onKeyDown?.(event);
						if (
							!searchable ||
							event.defaultPrevented ||
							event.target === inputRef.current
						)
							return;
						if (
							event.key.length === 1 &&
							event.key !== " " &&
							!event.ctrlKey &&
							!event.metaKey &&
							!event.altKey
						) {
							event.preventDefault();
							event.stopPropagation();
							setQuery((previous) => previous + event.key);
							inputRef.current?.focus();
						}
					}}
				>
					{searchable && (
						<input
							ref={inputRef}
							type="search"
							aria-label={t("selectSearch.placeholder")}
							placeholder={t("selectSearch.placeholder")}
							value={query}
							className="h-9 w-full border-b border-border bg-card px-3 text-sm outline-none"
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape" || event.key === "Tab") return;
								event.stopPropagation();
								if (event.key === "ArrowDown") {
									event.preventDefault();
									contentRef.current
										?.querySelector<HTMLElement>(
											'[role="option"]:not([data-disabled]):not([hidden])',
										)
										?.focus();
								}
							}}
						/>
					)}
					<SelectScrollUpButton />
					<SelectPrimitive.Viewport
						className={cn(
							"p-1 max-h-[300px] overflow-y-auto",
							position === "popper" &&
								"w-full min-w-(--radix-select-trigger-width)",
						)}
					>
						{searchable
							? sorted.map((node) => {
									if (
										!React.isValidElement<{
											hidden?: boolean;
											disabled?: boolean;
										}>(node)
									)
										return node;
									return React.cloneElement(node, {
										hidden: !matches.includes(node),
										disabled: node.props.disabled || !matches.includes(node),
									});
								})
							: children}
						{searchable && matches.length === 0 && (
							<div className="p-3 text-sm text-muted-foreground">
								{t("selectSearch.empty")}
							</div>
						)}
					</SelectPrimitive.Viewport>
					<SelectScrollDownButton />
				</SelectPrimitive.Content>
			</SelectPrimitive.Portal>
		);
	},
);
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Label>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
	<SelectPrimitive.Label
		ref={ref}
		className={cn(
			"py-1.5 pl-8 pr-2 text-sm font-semibold text-muted-foreground",
			className,
		)}
		{...props}
	/>
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
	<SelectPrimitive.Item
		ref={ref}
		className={cn(
			"relative flex w-full cursor-default select-none items-center",
			"rounded-md py-2 pl-8 pr-2 text-sm outline-none",
			"focus:bg-accent focus:text-accent-foreground",
			"data-disabled:pointer-events-none data-disabled:opacity-50 [&[hidden]]:hidden",
			"transition-colors duration-150",
			className,
		)}
		{...props}
	>
		<span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
			<SelectPrimitive.ItemIndicator>
				<Check className="h-4 w-4 text-primary" />
			</SelectPrimitive.ItemIndicator>
		</span>

		<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
	</SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
	<SelectPrimitive.Separator
		ref={ref}
		className={cn("-mx-1 my-1 h-px bg-border", className)}
		{...props}
	/>
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
	Select,
	SelectGroup,
	SelectValue,
	SelectTrigger,
	SelectContent,
	SelectLabel,
	SelectItem,
	SelectSeparator,
	SelectScrollUpButton,
	SelectScrollDownButton,
};
