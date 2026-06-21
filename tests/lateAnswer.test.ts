import { beforeEach, describe, expect, it } from "vitest";

import { gameSize, hiddenDebitMs } from "@/lib/gameSetup";
import {
    hiderInbox,
    type InboxEntry,
    settleLateAnswer,
} from "@/lib/hiderRole";

/**
 * Rulebook p61: a question not answered within its window pauses the
 * hider's clock (accrued in hiddenDebitMs) and earns no card.
 */
describe("settleLateAnswer", () => {
    beforeEach(() => {
        hiddenDebitMs.set(0);
        hiderInbox.set([]);
        gameSize.set("medium");
    });

    const arrive = (key: number, arrivedAt: number): InboxEntry => ({
        key,
        id: "matching",
        data: {},
        arrivedAt,
    });

    it("treats an on-time answer as not late and banks nothing", () => {
        // Arrived 2 min ago, 5-min window for non-photo → on time.
        hiderInbox.set([arrive(1, Date.now() - 2 * 60_000)]);
        expect(settleLateAnswer(1, "matching")).toBe(false);
        expect(hiddenDebitMs.get()).toBe(0);
    });

    it("flags a late answer and banks the overtime", () => {
        // Arrived 8 min ago, 5-min window → 3 min overdue.
        hiderInbox.set([arrive(2, Date.now() - 8 * 60_000)]);
        expect(settleLateAnswer(2, "matching")).toBe(true);
        expect(hiddenDebitMs.get()).toBeGreaterThanOrEqual(3 * 60_000 - 5_000);
        expect(hiddenDebitMs.get()).toBeLessThan(3 * 60_000 + 5_000);
    });

    it("uses the longer photo window (20 min in Large games)", () => {
        gameSize.set("large");
        // Arrived 15 min ago, photo window is 20 min in Large → on time.
        hiderInbox.set([arrive(3, Date.now() - 15 * 60_000)]);
        expect(settleLateAnswer(3, "photo")).toBe(false);
        expect(hiddenDebitMs.get()).toBe(0);
    });

    it("treats an unknown question as on-time", () => {
        expect(settleLateAnswer(999, "matching")).toBe(false);
        expect(hiddenDebitMs.get()).toBe(0);
    });
});
