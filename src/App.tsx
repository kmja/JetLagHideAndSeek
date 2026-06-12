import { Suspense } from "react";
import {
    createBrowserRouter,
    RouterProvider,
} from "react-router-dom";
import { ToastContainer } from "react-toastify";

import { MapErrorBoundary } from "@/components/MapErrorBoundary";
import { PWAUpdatePrompt } from "@/components/PWAUpdatePrompt";
import { lazyWithRetry } from "@/lib/lazyWithRetry";

// Each route is lazy-loaded so a user landing on `/` never has to
// download the hider bundle (and vice versa for `/h`). Wrapped in
// lazyWithRetry so a stale-SW chunk 404 self-heals on the second
// attempt instead of bombing straight to a blank page.
const SeekerPage = lazyWithRetry(() =>
    import("@/pages/SeekerPage").then((m) => ({ default: m.SeekerPage })),
);
const HiderPage = lazyWithRetry(() =>
    import("@/pages/HiderPage").then((m) => ({ default: m.HiderPage })),
);
// Developer-only card gallery. Lazy so it never weighs on the real
// routes; reachable from the debug panel's "Card gallery" link.
const DebugCardsPage = lazyWithRetry(() =>
    import("@/pages/DebugCardsPage").then((m) => ({
        default: m.DebugCardsPage,
    })),
);

// Both routes mount under the same Suspense boundary so the
// fallback (or lack thereof) is consistent. The route chunks
// load in well under a second on any reasonable connection so
// the fallback is just a faint spinner — short enough not to
// feel laggy, present enough that a slow connection doesn't
// look like the app is broken. The error boundary catches
// chunk 404s after a redeploy and offers a recover-and-reload
// path; without it, a stale SW that 404s the page chunk leaves
// the user staring at a blank screen with no escape.
const RouteWrapper = ({ element }: { element: React.ReactNode }) => (
    <MapErrorBoundary>
        <Suspense
            fallback={
                <div className="fixed inset-0 flex items-center justify-center bg-background">
                    <div className="h-8 w-8 rounded-full border-2 border-muted-foreground/30 border-t-primary animate-spin" />
                </div>
            }
        >
            {element}
        </Suspense>
    </MapErrorBoundary>
);

// Single React-Router root. The Astro era had two .astro pages
// each compiled to its own HTML shell; the SPA serves a single
// shell and the router picks SeekerPage / HiderPage by pathname.
// SPA fallback to index.html is configured in wrangler.jsonc so
// deep links keep working.
const router = createBrowserRouter([
    { path: "/", element: <RouteWrapper element={<SeekerPage />} /> },
    { path: "/h", element: <RouteWrapper element={<HiderPage />} /> },
    { path: "/h/", element: <RouteWrapper element={<HiderPage />} /> },
    {
        path: "/debug/cards",
        element: <RouteWrapper element={<DebugCardsPage />} />,
    },
    // Catch-all — anything else lands on the seeker shell. Matches
    // the previous Astro behaviour of `not_found_handling:
    // "single-page-application"`.
    { path: "*", element: <RouteWrapper element={<SeekerPage />} /> },
]);

export function App() {
    return (
        <>
            <RouterProvider router={router} />
            {/* Toast portal — single instance shared across both
                routes. Same z-index ladder rules as before
                (toasts sit above dialogs at z-1090). */}
            <ToastContainer
                position="top-center"
                autoClose={5000}
                hideProgressBar={false}
                newestOnTop
                closeOnClick
                pauseOnFocusLoss
                draggable={false}
                pauseOnHover
                theme="dark"
            />
            <PWAUpdatePrompt />
        </>
    );
}

export default App;
