import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Overlay>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Overlay
        ref={ref}
        className={cn(
            "fixed inset-0 z-[1050] bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            className,
        )}
        {...props}
    />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
        closeIcon?: boolean;
        /** Extra classes for the dim overlay — e.g. a raised z-index so
         *  the dialog can stack above an open drawer (lobby) whose
         *  content already sits above the default dialog z. */
        overlayClassName?: string;
    }
>(({ className, children, closeIcon = true, overlayClassName, ...props }, ref) => (
    <DialogPortal>
        <DialogOverlay className={overlayClassName} />
        <DialogPrimitive.Content
            ref={ref}
            className={cn(
                // Centered horizontally; vertically centered WITHIN
                // the safe area (translate compensates for the
                // status-bar top inset and the home-indicator
                // bottom inset so the dialog isn't pushed under
                // the iOS notch / Android navigation bar). max-h
                // is computed against `100dvh` minus the same
                // insets so a tall dialog can't overflow into
                // either system-UI region.
                "fixed left-[50%] top-[50%] z-[1050] grid w-[calc(100%-2rem)] max-w-lg",
                "translate-x-[-50%] translate-y-[calc(-50%+env(safe-area-inset-top)/2-env(safe-area-inset-bottom)/2)]",
                "gap-4 border bg-background p-6 shadow-lg duration-200",
                // Enter/exit animation. The slide-in-from-* classes are
                // load-bearing, not decoration: tailwindcss-animate's
                // zoom keyframe rebuilds `transform` from its own
                // --tw-enter-translate-* vars (default 0), which would
                // otherwise CLOBBER the `translate-x-[-50%]` centering
                // mid-animation — making the dialog appear to slide in
                // from the bottom-right toward center. Setting the
                // enter/exit translate to the same -50%/-48% centering
                // offset keeps the box pinned to the middle so it just
                // grows from the center (zoom-in-95) and fades.
                "data-[state=open]:animate-in data-[state=closed]:animate-out",
                "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
                "data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
                "data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]",
                // Rounded on ALL breakpoints (was sm:rounded-lg → sharp on
                // mobile) to match the app's drawers (rounded-t-[10px]) and
                // toasts. rounded-2xl reads as the same soft, friendly card.
                "rounded-2xl",
                "max-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-2rem)]",
                "sm:max-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-4rem)]",
                "overflow-hidden",
                className,
            )}
            {...props}
        >
            {children}
            {closeIcon && (
                <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
                    <X className="h-4 w-4" />
                    <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
            )}
        </DialogPrimitive.Content>
    </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
    <div
        className={cn(
            "flex flex-col space-y-1.5 text-center sm:text-left",
            className,
        )}
        {...props}
    />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
    <div
        className={cn(
            "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
            className,
        )}
        {...props}
    />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Title>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Title
        ref={ref}
        className={cn(
            "text-lg font-semibold leading-none tracking-tight",
            className,
        )}
        {...props}
    />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Description>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Description
        ref={ref}
        className={cn("text-sm text-muted-foreground", className)}
        {...props}
    />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogOverlay,
    DialogPortal,
    DialogTitle,
    DialogTrigger,
};
