import { atom } from "nanostores";

/**
 * App-styled replacement for `window.confirm()`. The native dialog
 * pops up with the OS-default chrome ("jetlaghideandseek.karl-...
 * workers.dev says"), which clashes badly with the rest of the
 * app's red / dark visual language. This module gives the same
 * `await yes/no` ergonomics but renders through the shadcn
 * AlertDialog primitive via the `AppConfirmHost` component (mounted
 * once at root).
 *
 * Usage:
 *
 *   import { appConfirm } from "@/lib/confirm";
 *
 *   const ok = await appConfirm({
 *       title: "Trigger endgame?",
 *       description: "The hider sees a banner asking them to lock down.",
 *       confirmLabel: "Trigger",
 *   });
 *   if (!ok) return;
 *
 * Promise resolves to `true` when the user taps Confirm, `false` for
 * Cancel / dismiss / Esc.
 */

export interface ConfirmOptions {
    title: string;
    description?: string;
    /** Button label for the affirmative action. Default "Confirm". */
    confirmLabel?: string;
    /** Button label for the negative action. Default "Cancel". */
    cancelLabel?: string;
    /** When true, the confirm button uses the destructive (red)
     *  variant — for actions like Delete, Leave game, Discard etc. */
    destructive?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
    resolve: (value: boolean) => void;
}

export const pendingConfirm = atom<PendingConfirm | null>(null);

export function appConfirm(opts: ConfirmOptions): Promise<boolean> {
    // If a previous confirm is somehow still hanging open, treat its
    // promise as cancelled before stacking a new one — only ever one
    // visible at a time.
    const existing = pendingConfirm.get();
    if (existing) existing.resolve(false);
    return new Promise<boolean>((resolve) => {
        pendingConfirm.set({ ...opts, resolve });
    });
}
