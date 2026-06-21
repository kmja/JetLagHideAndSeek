/**
 * Human-facing app version, shown in the debug panel header so it's
 * easy to confirm at a glance which build is live (deploys go to
 * Cloudflare; there's no other visible build stamp).
 *
 * Bump this on every meaningful change/deploy. Continues the `vNN`
 * batch sequence tracked in CLAUDE.md.
 */
export const APP_VERSION = "v410";
