import { persistentAtom } from "@nanostores/persistent";

/**
 * Private-beta access gate.
 *
 * ⚠️ This is a CLIENT-SIDE gate. It keeps hideandseek.game from being
 * wide-open while the beta is shared with a small group — it is NOT real
 * security: the check runs in the browser. We compare a SHA-256 of the
 * entered code against `EXPECTED_CODE_HASH` so the plaintext code isn't
 * grep-able in the shipped bundle, but a determined visitor could still
 * bypass it (e.g. by setting the localStorage flag).
 *
 * To rotate the code: hash the new one and replace `EXPECTED_CODE_HASH`:
 *   node -e "console.log(require('crypto').createHash('sha256').update('NEWCODE').digest('hex'))"
 *
 * To turn the gate off (e.g. public launch): build with
 *   VITE_DISABLE_BETA_GATE=1
 */

// sha256("betaforjetlag")
const EXPECTED_CODE_HASH =
    "46ee93ac9c179af38d3ad16fb18a20847fe8366d7ca0729723ad4c30d34973eb";

/** Unlocked-on-this-device flag. Persisted so a tester enters the code
 *  once per browser. */
export const betaUnlocked = persistentAtom<boolean>("betaUnlocked", false, {
    encode: JSON.stringify,
    decode: JSON.parse,
});

/** Build-time kill switch for the gate (set VITE_DISABLE_BETA_GATE=1). */
export const betaGateDisabled =
    import.meta.env.VITE_DISABLE_BETA_GATE === "1" ||
    import.meta.env.VITE_DISABLE_BETA_GATE === "true";

/** Case-insensitive, whitespace-trimmed SHA-256 comparison. Async because
 *  it uses SubtleCrypto (available on https / localhost). */
export async function checkBetaCode(input: string): Promise<boolean> {
    const normalised = input.trim().toLowerCase();
    if (!normalised) return false;
    try {
        const data = new TextEncoder().encode(normalised);
        const digest = await crypto.subtle.digest("SHA-256", data);
        const hex = Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        return hex === EXPECTED_CODE_HASH;
    } catch {
        return false;
    }
}
