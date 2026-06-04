import { useStore } from "@nanostores/react";
import { Copy, LogOut, Share2 } from "lucide-react";
import { useMemo } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import {
    currentGameCode,
    displayName as displayNameAtom,
    participants,
    transportStatus,
} from "@/lib/multiplayer/session";
import { leaveGame } from "@/lib/multiplayer/store";
import { cn } from "@/lib/utils";

/**
 * Inline "your game code" panel — small enough to embed inside the
 * BottomNav's "More" sheet without its own modal. Shows the active
 * code, a copy/share row, the participant roster, and a "leave"
 * affordance.
 */
export function InvitePanel() {
    const $code = useStore(currentGameCode);
    const $participants = useStore(participants);
    const $status = useStore(transportStatus);
    const $displayName = useStore(displayNameAtom);

    const shareUrl = useMemo(() => {
        if (!$code || typeof window === "undefined") return "";
        return `${window.location.origin}/?join=${$code}`;
    }, [$code]);

    if (!$code) {
        return (
            <p className="text-xs text-muted-foreground italic">
                Not in an online game. Use "Play online" to host or
                join one.
            </p>
        );
    }

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText($code);
            toast.success(`Code "${$code}" copied.`, { autoClose: 1500 });
        } catch {
            toast.error("Couldn't copy the code.");
        }
    };

    const handleShare = async () => {
        const text = `Join my Jet Lag Hide and Seek game. Code: ${$code}`;
        if (
            typeof navigator !== "undefined" &&
            typeof navigator.share === "function"
        ) {
            try {
                await navigator.share({
                    title: "Hide and Seek invite",
                    text,
                    url: shareUrl,
                });
                return;
            } catch {
                /* fall through to clipboard */
            }
        }
        try {
            await navigator.clipboard.writeText(`${text}\n${shareUrl}`);
            toast.success("Invite copied to clipboard.", { autoClose: 1500 });
        } catch {
            toast.error("Couldn't share the invite.");
        }
    };

    const handleLeave = () => {
        if (
            !confirm(
                "Leave the online game? Your local progress stays, but you'll need the code to rejoin.",
            )
        ) {
            return;
        }
        leaveGame();
        toast.info("Disconnected from online game.", { autoClose: 2000 });
    };

    return (
        <div className="space-y-3">
            <div className="rounded-md border-2 border-primary bg-primary/5 px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                    Game code
                </div>
                <div className="mt-1 font-mono font-black tracking-[0.25em] text-2xl text-primary">
                    {$code}
                </div>
                <div className="mt-1 text-[10px] uppercase tracking-wider font-poppins font-semibold text-muted-foreground">
                    {$status === "open"
                        ? "Connected"
                        : $status === "reconnecting"
                          ? "Reconnecting…"
                          : $status === "connecting"
                            ? "Connecting…"
                            : "Offline"}
                </div>
            </div>

            <div className="flex gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopy}
                    className="flex-1 gap-1.5"
                >
                    <Copy className="w-3.5 h-3.5" />
                    Copy code
                </Button>
                <Button
                    size="sm"
                    onClick={handleShare}
                    className="flex-1 gap-1.5"
                >
                    <Share2 className="w-3.5 h-3.5" />
                    Share invite
                </Button>
            </div>

            {$participants.length > 0 && (
                <div className="space-y-1.5">
                    <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                        In this game ({$participants.length})
                    </div>
                    <ul className="space-y-1">
                        {$participants.map((p) => (
                            <li
                                key={p.id}
                                className={cn(
                                    "flex items-center gap-2 px-2.5 py-1.5 rounded-sm",
                                    "bg-secondary/40 border border-border",
                                    "text-xs",
                                )}
                            >
                                <span
                                    className={cn(
                                        "w-2 h-2 rounded-full shrink-0",
                                        p.online
                                            ? "bg-emerald-400"
                                            : "bg-muted-foreground/40",
                                    )}
                                    aria-hidden="true"
                                />
                                <span className="font-poppins font-semibold truncate flex-1">
                                    {p.displayName || "(no name)"}
                                </span>
                                {p.role && (
                                    <span
                                        className={cn(
                                            "text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm font-bold",
                                            p.role === "hider"
                                                ? "bg-purple-500/20 text-purple-300"
                                                : "bg-primary/15 text-primary",
                                        )}
                                    >
                                        {p.role}
                                    </span>
                                )}
                                {p.displayName === $displayName && (
                                    <span className="text-[10px] text-muted-foreground">
                                        (you)
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <Button
                variant="outline"
                size="sm"
                onClick={handleLeave}
                className="w-full gap-1.5"
            >
                <LogOut className="w-3.5 h-3.5" />
                Leave online game
            </Button>
        </div>
    );
}

export default InvitePanel;
