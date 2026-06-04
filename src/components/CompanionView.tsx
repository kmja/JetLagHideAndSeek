import { useStore } from "@nanostores/react";
import { Clock, EyeOff, Inbox, MapPin, Trophy, Users } from "lucide-react";
import { useState } from "react";

import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { formatTimeRemaining, hidingPeriodEndsAt } from "@/lib/gameSetup";
import { hiderInbox, hidingZone, roundFoundAt } from "@/lib/hiderRole";
import { participants } from "@/lib/multiplayer/session";
import { cn } from "@/lib/utils";

/**
 * Read-only "hide team" surface for a co-hider.
 *
 * A co-hider has joined the primary hider's hide (rulebook teams) but
 * does NOT own the canonical hider state — no card hand, no zone pick,
 * no answering. They watch: the committed hiding zone (synced from the
 * primary hider over the wire), the round timer, and the seeker's
 * incoming questions as they land. Everything here is observe-only.
 */
export function CompanionView() {
    const $zone = useStore(hidingZone);
    const $inbox = useStore(hiderInbox);
    const $foundAt = useStore(roundFoundAt);
    const $participants = useStore(participants);

    const primaryHider = $participants.find((p) => p.role === "hider");

    // Newest question first.
    const inbox = [...$inbox].sort((a, b) => b.arrivedAt - a.arrivedAt);

    return (
        <div className="min-h-screen flex flex-col p-4 max-w-md mx-auto">
            <header className="mt-2 mb-4">
                <div className="flex items-center gap-2 mb-1">
                    <span className="inline-flex items-center justify-center w-7 h-7 rounded bg-primary/20 text-primary shrink-0">
                        <Users className="w-4 h-4" />
                    </span>
                    <span className="text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold">
                        Hide team · watching
                    </span>
                </div>
                <h1 className="font-poppins text-xl font-semibold leading-tight">
                    {primaryHider
                        ? `Hiding with ${primaryHider.displayName || "your hider"}`
                        : "Joining the hide"}
                </h1>
                <p className="text-sm text-muted-foreground mt-1 leading-snug">
                    You're a teammate on this hide. The hider manages the
                    zone, cards and answers — you can follow along here.
                </p>
            </header>

            {$foundAt !== null && (
                <div className="rounded-md border-2 border-primary bg-primary/10 px-4 py-3 mb-4 flex items-center gap-2">
                    <Trophy className="w-5 h-5 text-primary shrink-0" />
                    <span className="font-inter-tight font-black uppercase text-sm tracking-[0.14em] text-primary">
                        Round over · you were found
                    </span>
                </div>
            )}

            <HideTeamTimer />

            {/* Hiding zone */}
            <section className="mt-4">
                <div className="flex items-center gap-1.5 mb-2 text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold">
                    <EyeOff className="w-3.5 h-3.5" />
                    Hiding zone
                </div>
                {$zone ? (
                    <div className="rounded-md border border-border bg-secondary/30 px-4 py-3">
                        <div className="flex items-center gap-2">
                            <MapPin className="w-4 h-4 text-primary shrink-0" />
                            <span className="font-poppins font-semibold">
                                {$zone.stationName}
                            </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                            {$zone.radiusMeters} m radius · the hider stays
                            inside this circle all round.
                        </p>
                    </div>
                ) : (
                    <div className="rounded-md border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
                        The hider hasn't locked a zone yet. It'll appear here
                        once they commit it.
                    </div>
                )}
            </section>

            {/* Incoming questions */}
            <section className="mt-5 flex-1">
                <div className="flex items-center gap-1.5 mb-2 text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold">
                    <Inbox className="w-3.5 h-3.5" />
                    Incoming questions
                    {inbox.length > 0 && (
                        <span className="text-muted-foreground/70">
                            · {inbox.length}
                        </span>
                    )}
                </div>
                {inbox.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4">
                        No questions from the seeker yet.
                    </p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {inbox.map((entry) => {
                            const meta = CATEGORIES[entry.id as CategoryId];
                            const Icon = meta?.icon;
                            const answered = Boolean(entry.repliedAt);
                            return (
                                <li
                                    key={entry.key}
                                    className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5"
                                >
                                    {Icon && (
                                        <span
                                            className="inline-flex items-center justify-center w-7 h-7 rounded shrink-0"
                                            style={{
                                                backgroundColor: meta.color,
                                            }}
                                            aria-hidden="true"
                                        >
                                            <Icon
                                                size={15}
                                                strokeWidth={2.5}
                                                className="text-white"
                                            />
                                        </span>
                                    )}
                                    <span className="flex flex-col min-w-0 grow">
                                        <span className="font-medium text-sm truncate">
                                            {meta?.label ?? entry.id}
                                        </span>
                                        <span className="text-[11px] text-muted-foreground">
                                            {answered
                                                ? "Answered by the hider"
                                                : "Awaiting the hider's answer"}
                                        </span>
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            <footer className="pt-4 pb-2 text-center">
                <p className="text-[10px] text-muted-foreground">
                    Jet Lag Hide and Seek · hide-team view
                </p>
            </footer>
        </div>
    );
}

/** Minimal read-only round timer (no controls, unlike HiderTimer). */
function HideTeamTimer() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const [now, setNow] = useState(() => Date.now());
    useVisibleInterval(() => setNow(Date.now()), 1000, Boolean($endsAt));

    if (!$endsAt) {
        return (
            <div className="rounded-md border border-border bg-secondary/30 px-4 py-3 flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="w-4 h-4 shrink-0" />
                Waiting for the hiding period to start.
            </div>
        );
    }

    const inHiding = now < $endsAt;
    let display: string;
    if (inHiding) {
        display = formatTimeRemaining($endsAt - now);
    } else {
        const total = Math.floor((now - $endsAt) / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = (n: number) => String(n).padStart(2, "0");
        display = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }

    return (
        <div
            className={cn(
                "flex items-center gap-2 px-4 py-3 rounded-md",
                "border-2 border-primary bg-primary/10",
            )}
        >
            <Clock className="w-4 h-4 text-primary shrink-0" />
            <div className="flex flex-col leading-none gap-0.5">
                <span className="text-[9px] font-inter-tight font-bold uppercase tracking-[0.15em] text-muted-foreground">
                    {inHiding ? "Hiding period" : "Hidden for"}
                </span>
                <span className="font-inter-tight italic font-black tabular-nums text-lg text-primary leading-none">
                    {display}
                </span>
            </div>
        </div>
    );
}

export default CompanionView;
