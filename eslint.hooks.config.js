import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Focused lint config for the BUILD GATE (`npm run verify`): checks ONLY
 * `react-hooks/rules-of-hooks` — the rule whose violations ship runtime
 * crashes (a conditional hook call = React error #310; the v654
 * "MAP COULDN'T LOAD" incident). The main `eslint.config.js` still runs
 * the full rule set for interactive `npm run lint`, but the repo carries
 * pre-existing debt on stylistic rules, so gating deploys on the full
 * config would block every push. Tighten the gate toward the full config
 * as the debt burns down.
 *
 * The react/@typescript-eslint plugins are REGISTERED (all their rules
 * off) only so the source's inline `eslint-disable` comments that name
 * those rules still resolve — an unknown rule name in a disable comment
 * is itself an eslint error.
 */
export default [
    {
        files: ["src/**/*.{ts,tsx}"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaFeatures: { jsx: true } },
        },
        // The full config's disable comments look "unused" here (their
        // rules aren't enabled) — don't warn about them.
        linterOptions: { reportUnusedDisableDirectives: "off" },
        plugins: {
            "@typescript-eslint": tseslint.plugin,
            react: pluginReact,
            "react-hooks": pluginReactHooks,
        },
        rules: { "react-hooks/rules-of-hooks": "error" },
    },
];
