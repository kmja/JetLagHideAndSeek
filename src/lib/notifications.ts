import { atom } from "nanostores";
import { persistentAtom } from "@nanostores/persistent";

/**
 * In-tab and Web Push notification wrapper.
 *
 * Two atoms drive the UX:
 *   - `notificationPermission` — mirrors `Notification.permission`.
 *     Volatile; refreshed on window focus and when permission is requested.
 *   - `notificationsEnabled` — user opt-in stored in localStorage.
 *     Even with permission granted, the user can flip this off to mute
 *     the app without revoking the browser-level grant.
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
    if (readPermission() === "granted") {
        void subscribeToPush();
    }
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
    if (!supported) return "unsupported";
    try {
        const result = await Notification.requestPermission();
        const state = result as NotificationPermissionState;
        notificationPermission.set(state);
        if (state === "granted") {
            void subscribeToPush();
        }
        return state;
    } catch {
        return readPermission();
    }
}

/* ────────────────── Web Push subscription ────────────────── */

const PUSH_SUB_STORAGE_KEY = "jlhs_pushSub";
// Keep in sync with getMultiplayerOrigin() in src/lib/multiplayer/store.ts
const MULTIPLAYER_ORIGIN = "https://jlhs-multiplayer.karl-mj-andersson.workers.dev";

// Return type pinned to Uint8Array<ArrayBuffer> (which `new Uint8Array(n)`
// always is) — TS 5.7's generic TypedArrays default to ArrayBufferLike,
// which `PushManager.subscribe`'s BufferSource param rejects.
function b64urlToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

export async function subscribeToPush(): Promise<PushSubscriptionJSON | null> {
    if (typeof window === "undefined") return null;
    if (!supported || Notification.permission !== "granted") return null;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
    try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
            const json = existing.toJSON() as PushSubscriptionJSON;
            localStorage.setItem(PUSH_SUB_STORAGE_KEY, JSON.stringify(json));
            return json;
        }
        const resp = await fetch(`${MULTIPLAYER_ORIGIN}/vapid-public-key`);
        if (!resp.ok) return null;
        const { publicKey } = (await resp.json()) as { publicKey: string };
        if (!publicKey) return null;
        const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: b64urlToUint8Array(publicKey),
        });
        const json = sub.toJSON() as PushSubscriptionJSON;
        localStorage.setItem(PUSH_SUB_STORAGE_KEY, JSON.stringify(json));
        return json;
    } catch (e) {
        console.warn("[push] subscribeToPush failed", e);
        return null;
    }
}

export function getStoredPushSubscription(): PushSubscriptionJSON | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = localStorage.getItem(PUSH_SUB_STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw) as PushSubscriptionJSON;
    } catch {
        return null;
    }
}

/* ────────────────── In-tab notifications ────────────────── */

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
    const options: NotificationOptions = {
        body: opts.body,
        tag: opts.tag,
        icon: "/android-chrome-192x192.png",
        // Monochrome transparent silhouette — Android renders the small
        // status-bar/badge icon from the ALPHA channel and tints it, so a
        // full-colour favicon showed as a solid rounded square. This is a
        // white sun+mountain on transparent.
        badge: "/notification-badge.png",
        // The SW's `notificationclick` handler focuses the app from this.
        data: { url: "/" },
    };
    // Prefer the service worker registration. This is REQUIRED on mobile —
    // Android Chrome throws "Failed to construct 'Notification': Illegal
    // constructor" for the page-context `new Notification()` and demands
    // `ServiceWorkerRegistration.showNotification()`. It's also the path
    // that renders reliably while the tab is merely backgrounded (e.g. the
    // demo bot's answer landing a moment after you switch away). The SW's
    // notificationclick handler already re-focuses the app. Fire-and-forget;
    // fall back to the constructor only on desktop browsers with no active
    // service worker.
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
        void navigator.serviceWorker.ready
            .then((reg) => reg.showNotification(opts.title, options))
            .catch(() => notifyViaConstructor(opts.title, options));
        return true;
    }
    return notifyViaConstructor(opts.title, options);
}

/** Desktop fallback when there's no controlling service worker. */
function notifyViaConstructor(
    title: string,
    options: NotificationOptions,
): boolean {
    try {
        const n = new Notification(title, options);
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
