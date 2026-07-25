import * as Dialog from "@radix-ui/react-dialog";
import type { HTMLAttributes, ReactNode } from "react";

interface DialogSurfaceProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ariaLabel?: string;
  hasDescription?: boolean;
  children: ReactNode;
  overlayClassName?: string;
}

export function DialogSurface({
  open,
  onOpenChange,
  ariaLabel,
  hasDescription = false,
  children,
  className = "",
  overlayClassName = "",
  ...props
}: DialogSurfaceProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={`dialog-overlay dialog-backdrop ${overlayClassName}`.trim()}
        />
        <Dialog.Content
          className={`dialog-surface ${className}`.trim()}
          aria-label={ariaLabel}
          {...(hasDescription ? {} : { "aria-describedby": undefined })}
          {...props}
        >
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function DialogSurfaceTitle({
  children,
  as = "h2",
  className,
}: {
  children: ReactNode;
  as?: "h2" | "h3";
  className?: string;
}) {
  const heading = as === "h3"
    ? <h3 className={className}>{children}</h3>
    : <h2 className={className}>{children}</h2>;
  return (
    <Dialog.Title asChild>
      {heading}
    </Dialog.Title>
  );
}

export function DialogSurfaceDescription({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Description asChild>
      <p className={className}>{children}</p>
    </Dialog.Description>
  );
}

export function DialogSurfaceClose({ children }: { children: ReactNode }) {
  return <Dialog.Close asChild>{children}</Dialog.Close>;
}
