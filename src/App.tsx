import { lazy, Suspense } from "react";
import {
    createBrowserRouter,
    RouterProvider,
} from "react-router-dom";
import { ToastContainer } from "react-toastify";

import { PWAUpdatePrompt } from "@/components/PWAUpdatePrompt";

// Each route is lazy-loaded so a user landing on `/` never has to
// download the hider bundle (and vice versa for `/h`). The two
// pages share very little — different layouts, different
// dialogs, different state stores — so the saving is real, not
// just a chunk re-shuffle.
const SeekerPage = lazy(() =>
    import("@/pages/SeekerPage").then((m) => ({ default: m.SeekerPage })),
);
const HiderPage = lazy(() =>
    import("@/pages/HiderPage").then((m) => ({ default: m.HiderPage })),
);

// Both routes mount under the same Suspense boundary so the
// fallback (or lack thereof) is consistent. Null fallback because
// the page chunks load in well under a second on any reasonable
// connection and a flash of loading UI would be more disruptive
// than the brief blank.
const RouteWrapper = ({ element }: { element: React.ReactNode }) => (
    <Suspense fallback={null}>{element}</Suspense>
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
