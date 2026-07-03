"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, IconButton } from "./primitives";

// Trap focus within `ref`, restore focus to the opener on close, and call
// onEscape when Escape is pressed.
function useDialogA11y(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  onEscape: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusable = () =>
      node
        ? Array.from(
            node.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null)
        : [];
    focusable()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onEscape();
      } else if (e.key === "Tab") {
        const els = focusable();
        if (els.length === 0) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [open, ref, onEscape]);
}

function Portal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogA11y(open, ref, onClose);
  if (!open) return null;
  const widths = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-lg" };
  return (
    <Portal>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        <div
          className="absolute inset-0 bg-black/50 animate-fade-in"
          onClick={onClose}
          aria-hidden
        />
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          className={cn(
            "relative w-full rounded-2xl border border-line bg-surface-raised shadow-pop animate-scale-in",
            widths[size],
          )}
        >
          {title && (
            <div className="flex items-start justify-between gap-4 px-5 pt-5">
              <div>
                <h2 id={titleId} className="text-base font-semibold text-fg">
                  {title}
                </h2>
                {description && (
                  <p className="mt-1 text-[13px] text-fg-muted">{description}</p>
                )}
              </div>
              <IconButton label="Close" size="sm" onClick={onClose}>
                <X className="h-4 w-4" aria-hidden />
              </IconButton>
            </div>
          )}
          {children && <div className="px-5 py-4">{children}</div>}
          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
              {footer}
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}

// ConfirmDialog — for destructive/sensitive actions (end session, delete device,
// send executable, revoke technician). Default focus is on Cancel; the
// confirm button is styled by tone.
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
      size="sm"
    >
      <p className="text-[13px] leading-relaxed text-fg-secondary">{message}</p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Drawer (right-hand, for device detail)
// ---------------------------------------------------------------------------

export function Drawer({
  open,
  onClose,
  title,
  children,
  width = "max-w-md",
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogA11y(open, ref, onClose);
  if (!open) return null;
  return (
    <Portal>
      <div className="fixed inset-0 z-[100]">
        <div
          className="absolute inset-0 bg-black/50 animate-fade-in"
          onClick={onClose}
          aria-hidden
        />
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          className={cn(
            "absolute right-0 top-0 flex h-full w-full flex-col border-l border-line bg-surface shadow-pop animate-slide-in-right",
            width,
          )}
        >
          <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
            <h2 id={titleId} className="text-sm font-semibold text-fg">
              {title}
            </h2>
            <IconButton label="Close panel" size="sm" onClick={onClose}>
              <X className="h-4 w-4" aria-hidden />
            </IconButton>
          </div>
          <div className="flex-1 overflow-y-auto">{children}</div>
        </div>
      </div>
    </Portal>
  );
}

// ---------------------------------------------------------------------------
// Tooltip — lightweight, delayed, keyboard-accessible.
// ---------------------------------------------------------------------------

export function Tooltip({
  label,
  children,
  side = "top",
  shortcut,
}: {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  shortcut?: string;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback(() => {
    timer.current = setTimeout(() => setOpen(true), 350);
  }, []);
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  }, []);
  const pos = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
    left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
    right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
  };
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={cn(
            "pointer-events-none absolute z-[110] flex items-center gap-1.5 whitespace-nowrap rounded-md border border-line-soft bg-surface-raised px-2 py-1 text-[12px] font-medium text-fg shadow-pop animate-fade-in",
            pos[side],
          )}
        >
          {label}
          {shortcut && (
            <span className="font-mono text-[11px] text-fg-muted">{shortcut}</span>
          )}
        </span>
      )}
    </span>
  );
}
