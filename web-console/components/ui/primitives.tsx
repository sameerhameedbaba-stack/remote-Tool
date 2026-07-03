"use client";

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "subtle";
type ButtonSize = "sm" | "md" | "lg";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-150 ease-premium disabled:pointer-events-none disabled:opacity-40 select-none whitespace-nowrap";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover shadow-elev-1",
  secondary:
    "border border-line bg-surface-card text-fg hover:bg-surface-hover hover:border-line-soft",
  ghost: "text-fg-secondary hover:bg-surface-hover hover:text-fg",
  danger: "bg-danger text-white hover:brightness-110 shadow-elev-1",
  subtle: "bg-surface-hover text-fg hover:bg-line",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9 px-4 text-sm",
  lg: "h-11 px-5 text-[15px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "secondary",
      size = "md",
      loading = false,
      icon,
      iconRight,
      fullWidth,
      className,
      children,
      disabled,
      ...rest
    },
    ref,
  ) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        buttonBase,
        buttonVariants[variant],
        buttonSizes[size],
        fullWidth && "w-full",
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        icon
      )}
      {children}
      {iconRight}
    </button>
  ),
);
Button.displayName = "Button";

// IconButton — every instance REQUIRES an accessible label (aria-label). Used
// throughout the session toolbar; pair with <Tooltip> for a visible hint.
export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: ButtonSize;
  variant?: ButtonVariant | "toolbar";
  active?: boolean;
}

const iconButtonSizes: Record<ButtonSize, string> = {
  sm: "h-8 w-8",
  md: "h-9 w-9",
  lg: "h-11 w-11",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    { label, size = "md", variant = "ghost", active, className, children, ...rest },
    ref,
  ) => (
    <button
      ref={ref}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center justify-center rounded-lg transition-all duration-150 ease-premium disabled:pointer-events-none disabled:opacity-40",
        iconButtonSizes[size],
        variant === "toolbar"
          ? active
            ? "bg-accent-soft text-accent"
            : "text-fg-secondary hover:bg-surface-hover hover:text-fg"
          : variant === "danger"
            ? "text-danger hover:bg-danger-soft"
            : "text-fg-secondary hover:bg-surface-hover hover:text-fg",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  ),
);
IconButton.displayName = "IconButton";

// ---------------------------------------------------------------------------
// Card / surfaces
// ---------------------------------------------------------------------------

export function Card({
  className,
  children,
  as: Tag = "div",
  ...rest
}: {
  className?: string;
  children: ReactNode;
  as?: "div" | "section" | "article";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn("surface-card shadow-elev-1", className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function SectionHeading({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-fg">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const fieldBase =
  "w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg placeholder:text-fg-muted transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(({ className, invalid, ...rest }, ref) => (
  <input
    ref={ref}
    aria-invalid={invalid || undefined}
    className={cn(fieldBase, "h-9", invalid && "border-danger focus:ring-danger/30", className)}
    {...rest}
  />
));
Input.displayName = "Input";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...rest }, ref) => (
  <textarea
    ref={ref}
    className={cn(fieldBase, "min-h-[80px] resize-none py-2", className)}
    {...rest}
  />
));
Textarea.displayName = "Textarea";

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...rest }, ref) => (
  <select
    ref={ref}
    className={cn(fieldBase, "h-9 cursor-pointer appearance-none pr-8", className)}
    style={{
      backgroundImage:
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%238e94a3' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
      backgroundRepeat: "no-repeat",
      backgroundPosition: "right 0.6rem center",
    }}
    {...rest}
  >
    {children}
  </select>
));
Select.displayName = "Select";

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="block text-[13px] font-medium text-fg-secondary"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[12px] text-danger">{error}</p>
      ) : hint ? (
        <p className="text-[12px] text-fg-muted">{hint}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Misc primitives
// ---------------------------------------------------------------------------

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-line-soft bg-surface px-1.5 font-mono text-[11px] text-fg-secondary">
      {children}
    </kbd>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin", className)} aria-hidden />;
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-surface-hover",
        "after:absolute after:inset-0 after:-translate-x-full after:animate-[shimmer_1.6s_infinite] after:bg-gradient-to-r after:from-transparent after:via-white/5 after:to-transparent",
        className,
      )}
      aria-hidden
    />
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-line", className)} />;
}
