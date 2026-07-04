/**
 * MapLibre supports per-property paint transitions at runtime
 * (`"fill-opacity-transition": { duration: 280 }` etc. — the mechanism
 * every FadeOverlay-driven layer uses to fade in/out), but the style-spec
 * TYPES omit the `*-transition` keys, so any paint literal that includes
 * one fails TypeScript's excess-property check.
 *
 * This identity helper confines the necessary assertion to ONE audited
 * place instead of scattering per-site casts (or, worse, leaving ~20
 * permanent tsc errors that trained us to grep-filter the compiler — the
 * noise a real bug once hid in). Runtime no-op.
 *
 * The return type must be `any`: `<Layer type="fill" …>` is a
 * discriminated union, and returning the union of all paint types breaks
 * its discrimination (every wrapped Layer then fails to type-check).
 *
 * Trade-off: the paint object's contents lose compile checking. Use it
 * only for paint objects that carry a `*-transition` key.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fadePaint(paint: Record<string, unknown>): any {
    return paint;
}
