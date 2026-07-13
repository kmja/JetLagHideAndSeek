import { useStore } from "@nanostores/react";
import { BellRing } from "lucide-react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { notificationPrompt } from "@/lib/notificationPrompt";
import { requestNotificationPermission } from "@/lib/notifications";
import { cn } from "@/lib/utils";

/**
 * The friendly, one-time "turn on notifications" dialog (v812). Driven by
 * the `notificationPrompt` atom, which `maybePromptForNotifications` raises
 * at a contextual moment (seeker just asked / hider just locked a zone).
 *
 * The Enable button click is the user gesture the browser requires to call
 * `Notification.requestPermission()`, so the real browser prompt fires from
 * here. Mounted on both the seeker and hider in-game trees (only one is up
 * at a time). z-[1060] so it clears any drawer it was triggered from.
 */
export function NotificationPrompt() {
    const copy = useStore(notificationPrompt);
    const open = copy !== null;

    const close = () => notificationPrompt.set(null);

    const enable = async () => {
        const state = await requestNotificationPermission();
        close();
        if (state === "granted") {
            toast.success("Notifications on — we'll keep you posted.", {
                autoClose: 2200,
            });
        } else if (state === "denied") {
            toast.info(
                "No problem — you can turn them on later from the bell in the top bar.",
                { autoClose: 3200 },
            );
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(o) => {
                if (!o) close();
            }}
        >
            <DialogContent
                closeIcon={false}
                className={cn(
                    "z-[1060] pointer-events-auto",
                    "max-w-sm flex flex-col items-center text-center gap-4 p-6",
                )}
                overlayClassName="z-[1060]"
            >
                <span className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary/10 text-primary">
                    <BellRing className="w-7 h-7" />
                </span>
                <div className="space-y-1.5">
                    <DialogTitle className="font-display font-black uppercase text-lg tracking-tight leading-tight">
                        {copy?.title}
                    </DialogTitle>
                    <DialogDescription className="text-sm text-muted-foreground leading-snug">
                        {copy?.body}
                    </DialogDescription>
                </div>
                <div className="w-full flex flex-col gap-2 pt-1">
                    <Button
                        onClick={enable}
                        className="w-full font-display font-extrabold uppercase tracking-[0.02em] gap-2"
                    >
                        <BellRing className="w-4 h-4" />
                        Turn on notifications
                    </Button>
                    <Button
                        variant="ghost"
                        onClick={close}
                        className="w-full text-muted-foreground"
                    >
                        Not now
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

export default NotificationPrompt;
