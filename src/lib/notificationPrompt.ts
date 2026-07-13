import { atom } from "nanostores";
import { persistentAtom } from "@nanostores/persistent";

import { notificationPermission } from "./notifications";

/**
 * Contextual notification-permission prompt (v812).
 *
 * Rather than asking for notification permission up-front (low conversion,
 * easy to deny before the player understands why), we ask at the first
 * moment the grant would actually pay off — a seeker who just asked a
 * question and is now waiting on the answer, or a hider who just locked in
 * a zone and is now waiting on questions. This "soft ask → hard ask"
 * pattern (our own friendly dialog, whose Enable button then triggers the
 * real browser prompt) is both higher-converting and safer: a user who
 * dismisses our dialog hasn't spent their one-shot browser grant.
 */

export interface NotificationPromptCopy {
    title: string;
    body: string;
}

/** Volatile — the copy for the currently-open contextual prompt, or null. */
export const notificationPrompt = atom<NotificationPromptCopy | null>(null);

/**
 * Persisted — once we've auto-shown the contextual prompt (whatever the
 * user then chose), never auto-nag again. They can still enable any time
 * from the header bell / settings toggle.
 */
export const notificationPromptSeen = persistentAtom<boolean>(
    "jlhs:notifPromptSeen",
    false,
    {
        encode: (v) => (v ? "1" : "0"),
        decode: (v) => v === "1",
    },
);

/**
 * Ask a new player to enable notifications, exactly once, at a moment they
 * would benefit. No-ops when:
 *   - permission isn't in the undecided "default" state — already granted
 *     (nothing to ask) or denied / unsupported (our dialog can't help);
 *   - we've already auto-prompted once this device.
 *
 * The prompt is raised on a short delay so the UI that triggered it (the
 * configure dialog closing, the lock-in confirm closing) settles first —
 * avoiding a modal-over-a-closing-modal flash.
 */
export function maybePromptForNotifications(copy: NotificationPromptCopy): void {
    if (typeof window === "undefined") return;
    if (notificationPromptSeen.get()) return;
    if (notificationPermission.get() !== "default") return;
    // Claim the one-shot synchronously so a rapid second trigger can't
    // double-open, even though the atom is set on a delay below.
    notificationPromptSeen.set(true);
    window.setTimeout(() => notificationPrompt.set(copy), 600);
}

/** Copy for the two contexts, so the trigger sites read declaratively. */
export const SEEKER_NOTIFICATION_PROMPT: NotificationPromptCopy = {
    title: "Get notified when the answer arrives",
    body: "Turn on notifications and we'll ping you the moment the hider answers — even if you switch apps or lock your phone.",
};

export const HIDER_NOTIFICATION_PROMPT: NotificationPromptCopy = {
    title: "Get notified when questions come in",
    body: "You're hidden. Turn on notifications and we'll alert you each time the seekers ask something — even with the app in the background.",
};
