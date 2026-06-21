import { beforeEach, describe, expect, it } from "vitest";

import {
    endgameStartedAt,
    gameSize,
    hiddenCreditMs,
    hidingPeriodEndsAt,
    MOVE_PERIOD_MINUTES,
    seekersFrozenUntil,
} from "@/lib/gameSetup";
import { hidingZone } from "@/lib/hiderRole";
import { playMovePowerup } from "@/lib/roundActions";

/**
 * Move powerup: banks survived time, re-anchors the hider with a fresh
 * (shorter) hiding period, and freezes the seekers. Multiplayer is off
 * in tests, so hostPushSetup() inside playMovePowerup is a no-op.
 */
describe("Move powerup re-anchor", () => {
    beforeEach(() => {
        endgameStartedAt.set(null);
        hiddenCreditMs.set(0);
        seekersFrozenUntil.set(null);
        hidingZone.set(null);
        gameSize.set("large");
    });

    it("no-ops when no hiding clock is running", () => {
        hidingPeriodEndsAt.set(null);
        expect(playMovePowerup()).toBe(false);
        expect(hiddenCreditMs.get()).toBe(0);
    });

    it("no-ops once the endgame has started", () => {
        hidingPeriodEndsAt.set(Date.now() - 60_000);
        endgameStartedAt.set(Date.now());
        expect(playMovePowerup()).toBe(false);
    });

    it("banks survived time and starts a fresh hiding period", () => {
        // Seeking has been running for ~10 min (hiding period ended then).
        const tenMinAgo = Date.now() - 10 * 60_000;
        hidingPeriodEndsAt.set(tenMinAgo);

        const ok = playMovePowerup();
        expect(ok).toBe(true);

        // ~10 min banked (allow a little slack for execution time).
        expect(hiddenCreditMs.get()).toBeGreaterThanOrEqual(10 * 60_000 - 5_000);

        // Fresh Large hiding period (~60 min ahead) and seekers frozen
        // until the same instant.
        const expectedEnd = Date.now() + MOVE_PERIOD_MINUTES.large * 60_000;
        expect(hidingPeriodEndsAt.get()).toBeGreaterThan(Date.now());
        expect(
            Math.abs((hidingPeriodEndsAt.get() ?? 0) - expectedEnd),
        ).toBeLessThan(5_000);
        expect(seekersFrozenUntil.get()).toBe(hidingPeriodEndsAt.get());

        // Old zone cleared so the hider re-picks.
        expect(hidingZone.get()).toBeNull();
    });

    it("does not bank time if Move is played during the hiding period", () => {
        // Hiding period still in the future → seeking hasn't begun.
        hidingPeriodEndsAt.set(Date.now() + 5 * 60_000);
        playMovePowerup();
        expect(hiddenCreditMs.get()).toBe(0);
    });
});
