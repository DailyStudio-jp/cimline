import { useEffect, type ReactNode, type RefObject } from "react";

type ManagedDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dialogRef: RefObject<HTMLDialogElement | null>;
  className: string;
  initialFocusSelector?: string;
  children: ReactNode;
};

export function ManagedDialog({
  open,
  onOpenChange,
  dialogRef,
  className,
  initialFocusSelector,
  children,
}: ManagedDialogProps) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      if (initialFocusSelector) {
        requestAnimationFrame(() => {
          if (dialog.open) dialog.querySelector<HTMLElement>(initialFocusSelector)?.focus();
        });
      }
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [dialogRef, initialFocusSelector, open]);

  return (
    <dialog
      ref={dialogRef}
      className={className}
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClose={() => onOpenChange(false)}
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      {children}
    </dialog>
  );
}
