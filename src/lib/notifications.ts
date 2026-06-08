import { atom } from "nanostores";
import { persistentAtom } from "@nanostores/persistent";

/**
 * In-tab Notification API wrapper. Fires `new Notification(...)` when
 * a game event happens AND the document is currently hidden (no point
 * notifying a focused tab — the user already sees the toast / update).
 *
 * Scope is limited to "while the tab is alive in the background" —
 * mobile Safari kills suspended tabs and Android Chrome aggressively
 * throttles them. True background push (works after the tab closes)
 * needs Web Push with a VAPID-keyed server — that's a follow-up.
 *
 * Two atoms drive the UX:
 *
 *   - `notificationPermission` — mirrors `Notification.permission`
 *     ("default" | "granted" | "denied"). Volatile; refreshed on
 *     window focus + when we call `requestNotificationPermission`.
 *
 *   - `notificationsEnabled` — user opt-in stored in localStorage.
 *     Even with permission granted, the user can flip this off to
 *     mute the app without revoking the browser-level grant.
 */

export type NotificationPermissionState = "default" | "granted" | "denied" | "unsupported";

const supported =
    typeof window !== "undefined" &&
    typeof Notification !== "undefined" &&
    typeof Notification.requestPermission === "function";

function readPermission(): NotificationPermissionState {
    if (!supported) return "unsupported";
    return Notification.permission as NotificationPermissionState;
}

export const notificationPermission = atom<NotificationPermissionState>(
    readPermission(),
);

/**
 * User opt-in. Default on so the moment the user grants permission
 * notifications start working — the permission grant itself is the
 * meaningful gate. Flip this off via the toggle in the More sheet
 * to mute without revoking browser permission.
 */
export const notificationsEnabled = persistentAtom<boolean>(
    "notificationsEnabled",
    true,
    {
        encode: (v) => (v ? "1" : "0"),
        decode: (v) => v === "1",
    },
);

if (typeof window !== "undefined") {
    // Permission can change outside our control (browser settings,
    // site permission UI). Re-read on focus so the toggle UI is
    // never stuck on a stale state.
    window.addEventListener("focus", () => {
        notificationPermission.set(readPermission());
    });
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
    if (!supported) return "unsupported";
    try {
        const result = await Notification.requestPermission();
        const state = result as NotificationPermissionState;
        notificationPermission.set(state);
        return state;
    } catch {
        return readPermission();
    }
}

interface NotifyOptions {
    /** Short title shown bold at the top of the notification. */
    title: string;
    /** Optional body text. Keep it under ~80 chars for mobile. */
    body?: string;
    /**
     * Stable tag — newer notifications with the same tag replace
     * older ones instead of stacking. Use this to coalesce repeat
     * events of the same kind (e.g. multiple curses arriving rapidly
     * should collapse to a single notification).
     */
    tag?: string;
    /**
     * If true, also notify when the document is visible. Default
     * false — visible tabs already show toasts / UI changes, no
     * need to double up.
     */
    whileVisible?: boolean;
}

/**
 * Fire an OS notification for a game event. Silently no-ops when:
 *   - The browser doesn't support Notification.
 *   - The user hasn't granted permission.
 *   - The user has muted via `notificationsEnabled`.
 *   - The document is currently visible (unless `whileVisible: true`).
 *
 * Returns true if a notification was actually shown.
 */
export function notify(opts: NotifyOptions): boolean {
    if (!supported) return false;
    if (Notification.permission !== "granted") return false;
    if (!notificationsEnabled.get()) return false;
    if (!opts.whileVisible && document.visibilityState === "visible") {
        return false;
    }
    try {
        const n = new Notification(opts.title, {
            body: opts.body,
            tag: opts.tag,
            icon: "/android-chrome-192x192.png",
            badge: "/favicon-32x32.png",
        });
        // Re-focus the tab when the user taps the notification.
        n.onclick = () => {
            try {
                window.focus();
            } catch {
                /* ignore */
            }
            n.close();
        };
        return true;
    } catch (e) {
        console.warn("[notify] failed to dispatch notification", e);
        return false;
    }
}
