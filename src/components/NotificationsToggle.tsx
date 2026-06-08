import { useStore } from "@nanostores/react";
import { Bell, BellOff, BellRing } from "lucide-react";

import {
    notificationPermission,
    notificationsEnabled,
    requestNotificationPermission,
} from "@/lib/notifications";
import { cn } from "@/lib/utils";

/**
 * Notification permission + mute control. Three states:
 *
 *   - Unsupported: render nothing (some embedded browsers).
 *   - Default / Denied: prompt button to request permission.
 *     (Denied still gets the button so the user can re-grant via
 *     the resulting browser dialog flow; on most browsers a denied
 *     site needs a manual unblock in settings, but the button at
 *     least surfaces the state.)
 *   - Granted: muteable toggle so the user can silence the app
 *     without revoking permission at the browser level.
 */
export function NotificationsToggle() {
    const perm = useStore(notificationPermission);
    const enabled = useStore(notificationsEnabled);

    if (perm === "unsupported") return null;

    if (perm !== "granted") {
        const denied = perm === "denied";
        return (
            <button
                type="button"
                onClick={() => {
                    void requestNotificationPermission();
                }}
                disabled={denied}
                title={
                    denied
                        ? "Notifications are blocked. Unblock this site in your browser settings to re-enable."
                        : "Allow notifications for new questions, answers, and curses"
                }
                className={cn(
                    "w-full flex items-center justify-center gap-2",
                    "px-3 py-2 rounded-md",
                    "bg-secondary hover:bg-accent border border-border",
                    "text-sm font-semibold text-foreground transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    denied && "opacity-60 cursor-not-allowed",
                )}
            >
                <Bell className="w-4 h-4" />
                {denied
                    ? "Notifications blocked"
                    : "Enable notifications"}
            </button>
        );
    }

    return (
        <button
            type="button"
            onClick={() => notificationsEnabled.set(!enabled)}
            className={cn(
                "w-full flex items-center justify-center gap-2",
                "px-3 py-2 rounded-md border",
                "text-sm font-semibold transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                enabled
                    ? "bg-secondary hover:bg-accent border-border text-foreground"
                    : "bg-muted/40 hover:bg-muted/60 border-border text-muted-foreground",
            )}
            title={
                enabled
                    ? "Tap to mute background notifications"
                    : "Tap to re-enable background notifications"
            }
        >
            {enabled ? (
                <>
                    <BellRing className="w-4 h-4" />
                    Notifications on
                </>
            ) : (
                <>
                    <BellOff className="w-4 h-4" />
                    Notifications muted
                </>
            )}
        </button>
    );
}

export default NotificationsToggle;
