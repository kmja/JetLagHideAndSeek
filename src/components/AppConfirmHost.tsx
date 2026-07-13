import { useStore } from "@nanostores/react";
import { lazy, Suspense } from "react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { pendingConfirm } from "@/lib/confirm";
import { cn } from "@/lib/utils";

// Lazy so MapLibre only loads when a confirm actually asks for a zone
// preview (the hider lock-in) — not on every appConfirm from anywhere.
const ZonePreviewMap = lazy(() => import("@/components/ZonePreviewMap"));

/**
 * Renders the app-styled AlertDialog whenever something calls
 * `appConfirm(...)` from anywhere in the tree. Mounted once at root
 * (SeekerPage + HiderPage) — the imperative atom-based API means
 * call sites don't have to thread state or refs to reach it.
 *
 * Wires Esc / overlay-click to "cancel" and the two buttons to the
 * promise resolution. Stays rendered (just `open={false}`) when
 * nothing is pending so the close animation can play out.
 */
export function AppConfirmHost() {
    const $pending = useStore(pendingConfirm);
    const open = $pending !== null;

    const resolve = (value: boolean) => {
        if ($pending) $pending.resolve(value);
        pendingConfirm.set(null);
    };

    return (
        <AlertDialog
            open={open}
            onOpenChange={(next) => {
                if (!next) resolve(false);
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {$pending?.title ?? ""}
                    </AlertDialogTitle>
                    {$pending?.previewZone && (
                        <Suspense
                            fallback={
                                <div className="aspect-square w-full animate-pulse rounded-lg bg-muted" />
                            }
                        >
                            <ZonePreviewMap
                                lat={$pending.previewZone.lat}
                                lng={$pending.previewZone.lng}
                                radiusMeters={$pending.previewZone.radiusMeters}
                                className="aspect-square w-full"
                            />
                        </Suspense>
                    )}
                    {$pending?.description && (
                        <AlertDialogDescription>
                            {$pending.description}
                        </AlertDialogDescription>
                    )}
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel onClick={() => resolve(false)}>
                        {$pending?.cancelLabel ?? "Cancel"}
                    </AlertDialogCancel>
                    <AlertDialogAction
                        onClick={() => resolve(true)}
                        className={cn(
                            $pending?.destructive &&
                                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
                        )}
                    >
                        {$pending?.confirmLabel ?? "Confirm"}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

export default AppConfirmHost;
