import { useStore } from "@nanostores/react";
import { ChevronRight, Inbox } from "lucide-react";
import { useMemo } from "react";

import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { hiderInbox, type InboxEntry } from "@/lib/hiderRole";
import { encodeQuestionForHider } from "@/lib/shareLinks";
import { cn } from "@/lib/utils";
import type { Question } from "@/maps/schema";

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
                    They arrive via shared link — opening one (or
                    tapping a question in this log) takes you to the
                    answer view.
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
 * Compact summary row for a waiting (un-replied) inbox entry. The row
 * itself is the affordance — tapping it routes to `/h?q=…` with the
 * same encoded payload the seeker would have shared, so the hider
 * lands on the dedicated answer view (reveal-blur, share-back row,
 * etc.) without having to chase down an SMS link.
 *
 * That matters because the inbox can be populated through several
 * paths now: opening the seeker's share link, the debug "→ Hider"
 * ferry, and (later) multiplayer push updates. Telling the hider
 * "open the seeker's share link" was strictly accurate only on the
 * first path, and even there the link had already been opened to
 * land the entry in the inbox in the first place.
 */
function WaitingRow({ entry }: { entry: InboxEntry }) {
    const categoryMeta = CATEGORIES[entry.id as CategoryId];
    const CategoryIcon = categoryMeta?.icon;
    const prompt = waitingRowPrompt(entry);

    const openAnswerView = () => {
        // Reconstruct the share payload from the inbox entry — same
        // shape `encodeQuestionForHider` would produce on the seeker
        // side. The URL ends up identical to the share link.
        const question = {
            id: entry.id,
            key: entry.key,
            data: entry.data,
        } as Question;
        try {
            const url = encodeQuestionForHider(question);
            const parsed = new URL(url);
            window.location.assign(
                parsed.pathname + parsed.search + parsed.hash,
            );
        } catch {
            // Fallback: build the relative URL inline if URL parsing
            // fails for any reason (e.g. exotic data shapes).
            const payload = JSON.stringify(question);
            window.location.assign(`/h?q=${encodeURIComponent(payload)}`);
        }
    };

    return (
        <li>
            <button
                type="button"
                onClick={openAnswerView}
                className={cn(
                    "w-full text-left rounded-sm border border-border border-l-[5px] border-l-yellow-500",
                    "px-3 py-2.5 bg-secondary/40",
                    "flex items-center gap-3",
                    "hover:bg-accent hover:border-l-yellow-400 transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
                aria-label={`Answer ${categoryMeta?.label ?? entry.id} question`}
            >
                {CategoryIcon && (
                    <span
                        className="inline-flex items-center justify-center w-8 h-8 rounded shrink-0"
                        style={{ backgroundColor: categoryMeta.color }}
                        aria-hidden="true"
                    >
                        <CategoryIcon
                            size={16}
                            strokeWidth={2.5}
                            className="text-white"
                        />
                    </span>
                )}
                <div className="min-w-0 flex-1">
                    <div className="font-inter-tight font-bold uppercase text-xs tracking-[0.1em] truncate">
                        {categoryMeta?.label ?? entry.id}
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-snug truncate">
                        {prompt}
                    </p>
                </div>
                <ChevronRight
                    className="w-4 h-4 text-muted-foreground shrink-0"
                    aria-hidden="true"
                />
            </button>
        </li>
    );
}

/**
 * Best-effort one-line summary of what the seeker is asking. Mirrors
 * `questionPrompt()` in HiderView.tsx but trimmed so it fits inside a
 * compact log row. We keep this local to avoid an awkward import
 * cycle between HiderQuestionLog and HiderView.
 */
function waitingRowPrompt(entry: InboxEntry): string {
    const d = entry.data as Record<string, unknown>;
    const nice = (raw: unknown): string =>
        String(raw ?? "")
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
    switch (entry.id) {
        case "radius": {
            const radius = d.radius;
            const unit = d.unit === "miles" ? "mi" : d.unit === "meters" ? "m" : "km";
            return `Within ${radius} ${unit} of the seeker?`;
        }
        case "thermometer":
            return "Did the seeker get warmer or colder?";
        case "matching":
            return d.type
                ? `Same ${nice(d.type)}?`
                : "Do we match on this attribute?";
        case "measuring":
            return d.type
                ? `Closer or further from the nearest ${nice(d.type)}?`
                : "Closer or further than the seeker?";
        case "tentacles":
            return `Closest ${nice(d.locationType) || "location"} to you?`;
        default:
            return "Tap to reveal & send your answer.";
    }
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
