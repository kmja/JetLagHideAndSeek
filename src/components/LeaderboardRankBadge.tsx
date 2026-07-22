import { cn } from "@/lib/utils";

/**
 * Shared placement-rank visuals for the two hide-time leaderboards — the
 * seeker map's `HiderTimer` (bottom-right, top-3 ranked rows) and the hider
 * map's `HiderMapTimer` (the "next to beat" row). Both hand-kept an identical
 * gold/silver/bronze/neutral colour ramp + st/nd/rd suffix logic; v1121 (dedup
 * batch 2, C3) single-sources it here so a colour tweak can't drift between the
 * two roles.
 */

/** "st"/"nd"/"rd"/"th" for a placement rank. */
export function rankSuffix(n: number): string {
    return n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";
}

/** Vivid placement colour for the rank BADGE (gold / silver / bronze / rest). */
export function rankBadgeBg(rank: number): string {
    return rank === 1
        ? "#F2C63C" // gold (vivid)
        : rank === 2
          ? "#B8BDC7" // silver
          : rank === 3
            ? "#CF8B4B" // bronze
            : "#9AA1AD";
}

/**
 * Lightened placement tint for the time BOX behind the digits (v871) — so a
 * 2nd-place time isn't a full gold, while the navy digits stay legible.
 */
export function rankBoxBg(rank: number): string {
    return rank === 1
        ? "#F2C63C"
        : rank === 2
          ? "#D6DAE1"
          : rank === 3
            ? "#E4B98D"
            : "#E6E8EC";
}

/**
 * The tinted placement square on the left of a leaderboard row — the rank
 * number + its ordinal suffix over the vivid placement colour.
 */
export function RankBadge({
    rank,
    className,
}: {
    rank: number;
    className?: string;
}) {
    return (
        <div
            className={cn("flex items-center px-2.5", className)}
            style={{ background: rankBadgeBg(rank) }}
        >
            <span
                className={cn(
                    "font-inter-tight font-black text-sm leading-none",
                    rank === 3 ? "text-white" : "text-[#1F2F3F]",
                )}
            >
                {rank}
                <span className="text-[9px] align-super">
                    {rankSuffix(rank)}
                </span>
            </span>
        </div>
    );
}

export default RankBadge;
