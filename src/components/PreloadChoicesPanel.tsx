/**
 * Shared three-bucket preload-choice picker used by both:
 *
 *   - The wizard's Step 4 ("What should we preload?") — fresh-game
 *     defaults applied via the persisted store, user adjusts before
 *     starting the hiding period.
 *   - The Settings sheet — mid-game adjustments. Flipping a bucket
 *     from off → on calls `runPreloadForBucket(name)` immediately so
 *     the user doesn't have to wait for the next hiding period to
 *     load deferred data.
 *
 * Single source of truth = the `preloadChoices` persistent atom in
 * `gameSetup.ts`. This component just renders the three rows and
 * dispatches.
 */

import { useStore } from "@nanostores/react";
import { BookOpen, Map as MapIcon, TramFront } from "lucide-react";

import {
    preloadChoices,
    type PreloadChoices,
} from "@/lib/gameSetup";
import { runPreloadForBucket } from "@/lib/preload";
import { cn } from "@/lib/utils";

import { Checkbox } from "./ui/checkbox";

interface BucketDef {
    id: keyof PreloadChoices;
    label: string;
    blurb: string;
    icon: React.ComponentType<{ className?: string }>;
}

const BUCKETS: BucketDef[] = [
    {
        id: "map",
        label: "Map",
        blurb:
            "Play-area boundary + base tiles. A few hundred KB — recommended for everyone.",
        icon: MapIcon,
    },
    {
        id: "references",
        label: "Question references",
        blurb:
            "All 15 question categories (hospitals, parks, museums, train stations, …). 1–5 MB depending on city density. Off-by-tap fallback still works without this.",
        icon: BookOpen,
    },
    {
        id: "transit",
        label: "Transit lines & arrivals",
        blurb:
            "High-speed rail data + journey arrival times. Drop this if you're on a slow connection — only matters for transit-themed questions.",
        icon: TramFront,
    },
];

interface PreloadChoicesPanelProps {
    /** When true, flipping a bucket from off → on runs that bucket's
     *  preload immediately. Use in Settings (mid-game). Wizard mode
     *  defers until the hiding period actually starts. */
    runImmediatelyOnEnable?: boolean;
    className?: string;
}

export function PreloadChoicesPanel({
    runImmediatelyOnEnable = false,
    className,
}: PreloadChoicesPanelProps) {
    const choices = useStore(preloadChoices);

    const toggle = (id: keyof PreloadChoices) => {
        const wasOn = choices[id];
        const next = { ...choices, [id]: !wasOn };
        preloadChoices.set(next);
        // off → on while a game is running → fire the preload now so
        // the user doesn't wait for the next hiding period.
        if (runImmediatelyOnEnable && !wasOn) {
            runPreloadForBucket(id);
        }
    };

    return (
        <div className={cn("space-y-2", className)}>
            {BUCKETS.map((b) => {
                const Icon = b.icon;
                const on = choices[b.id];
                return (
                    <label
                        key={b.id}
                        className={cn(
                            "flex gap-3 items-start p-3 rounded-md border cursor-pointer",
                            "bg-secondary/30 hover:bg-secondary/60 transition-colors",
                            on
                                ? "border-primary/50"
                                : "border-border",
                        )}
                    >
                        <Checkbox
                            checked={on}
                            onCheckedChange={() => toggle(b.id)}
                            className="mt-0.5"
                            aria-label={b.label}
                        />
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                                <Icon className="w-4 h-4" />
                                {b.label}
                            </div>
                            <p className="text-xs text-muted-foreground mt-1 leading-snug">
                                {b.blurb}
                            </p>
                        </div>
                    </label>
                );
            })}
        </div>
    );
}
