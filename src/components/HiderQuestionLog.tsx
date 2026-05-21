import { useStore } from "@nanostores/react";
import { Inbox } from "lucide-react";
import { useMemo } from "react";

import { hiderInbox, type InboxEntry } from "@/lib/hiderRole";
import { cn } from "@/lib/utils";

import { SectionPill } from "./JetLagLogo";
import {
    MatchingQuestionComponent,
    MeasuringQuestionComponent,
    PhotoQuestionComponent,
    RadiusQuestionComponent,
    TentacleQuestionComponent,
    ThermometerQuestionComponent,
} from "./QuestionCards";

/**
 * Hider's view of the inbox, mirroring the seeker's question log.
 * Splits inbox entries into two buckets:
 *
 *   • **Awaiting your answer** — drag-style summary card you can open
 *     the answer link from. Compact list since it's actionable.
 *
 *   • **Answered** — full seeker-style question card rendered with
 *     the *committed* data (drag:false + the hider's reply merged
 *     in), so the hider sees the same level of detail the seeker
 *     does in their question log. Useful for going back and seeing
 *     "what did I say about that aquarium question two hours ago?".
 *
 * The cards are read-only here — the hider has already replied; the
 * seeker-side answer toggles aren't actionable.
 */
export function HiderQuestionLog() {
    const $inbox = useStore(hiderInbox);

    const sorted = useMemo(
        () => [...$inbox].sort((a, b) => b.arrivedAt - a.arrivedAt),
        [$inbox],
    );
    const answered = sorted.filter((e) => e.repliedAt);
    const waiting = sorted.filter((e) => !e.repliedAt);

    if (sorted.length === 0) {
        return (
            <section className="mt-5">
                <div className="flex items-center gap-2 mb-2">
                    <Inbox className="w-4 h-4 text-muted-foreground" />
                    <SectionPill>Question log</SectionPill>
                </div>
                <p className="text-xs text-muted-foreground italic px-1 leading-snug">
                    Questions the seeker sends you will land here.
                    They share links via SMS — opening one adds the
                    question to your log and lets you reveal an answer.
                </p>
            </section>
        );
    }

    return (
        <section className="mt-5 space-y-4">
            {waiting.length > 0 && (
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Inbox className="w-4 h-4 text-yellow-500" />
                        <SectionPill>Awaiting answer</SectionPill>
                        <span className="text-[10px] text-muted-foreground tabular-nums ml-1">
                            {waiting.length}
                        </span>
                    </div>
                    <ul className="space-y-2">
                        {waiting.map((entry) => (
                            <WaitingRow key={entry.key} entry={entry} />
                        ))}
                    </ul>
                </div>
            )}

            {answered.length > 0 && (
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Inbox className="w-4 h-4 text-muted-foreground" />
                        <SectionPill>Answered</SectionPill>
                        <span className="text-[10px] text-muted-foreground tabular-nums ml-1">
                            {answered.length}
                        </span>
                    </div>
                    {/* Render with the seeker's own card components so
                        the hider sees the same level of detail the
                        seeker has in their question log. */}
                    <div className="space-y-2">
                        {answered.map((entry) => (
                            <AnsweredCard key={entry.key} entry={entry} />
                        ))}
                    </div>
                </div>
            )}
        </section>
    );
}

/**
 * Compact summary row for a waiting (un-replied) inbox entry. We
 * deliberately keep this small — the hider answers via the share-link
 * URL, not by clicking around inside the log.
 */
function WaitingRow({ entry }: { entry: InboxEntry }) {
    return (
        <li
            className={cn(
                "rounded-sm border border-border border-l-[5px] border-l-yellow-500",
                "px-3 py-2 bg-secondary/40",
                "flex items-center justify-between gap-2",
            )}
        >
            <div className="min-w-0">
                <div className="font-inter-tight font-bold uppercase text-xs tracking-[0.1em] truncate">
                    {entry.id}
                </div>
                <p className="text-[11px] text-muted-foreground leading-snug">
                    Open the seeker's share link to reveal & send your
                    answer.
                </p>
            </div>
        </li>
    );
}

function AnsweredCard({ entry }: { entry: InboxEntry }) {
    // Reconstruct the question object the seeker's components expect —
    // the original data with the hider's reply merged in, and
    // drag:false to indicate it's committed. The card components
    // treat drag:false as "answered, read-only result", which is
    // exactly the read we want here.
    const data = {
        ...(entry.data as Record<string, unknown>),
        ...(entry.reply ?? {}),
        drag: false,
        // Force the card to render collapsed-with-summary by default.
        // The hider can expand to see the seeker's question parameters
        // (lat/lng, radius, etc.) if they care.
        collapsed: (entry.data as { collapsed?: boolean }).collapsed ?? true,
    } as any;

    switch (entry.id) {
        case "radius":
            return (
                <RadiusQuestionComponent
                    data={data}
                    questionKey={entry.key}
                />
            );
        case "thermometer":
            return (
                <ThermometerQuestionComponent
                    data={data}
                    questionKey={entry.key}
                />
            );
        case "matching":
            return (
                <MatchingQuestionComponent
                    data={data}
                    questionKey={entry.key}
                />
            );
        case "measuring":
            return (
                <MeasuringQuestionComponent
                    data={data}
                    questionKey={entry.key}
                />
            );
        case "tentacles":
            return (
                <TentacleQuestionComponent
                    data={data}
                    questionKey={entry.key}
                />
            );
        case "photo":
            return (
                <PhotoQuestionComponent
                    data={data}
                    questionKey={entry.key}
                />
            );
        default:
            return null;
    }
}

export default HiderQuestionLog;
