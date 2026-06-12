import { ArrowLeft } from "lucide-react";

import {
    MatchingQuestionComponent,
    MeasuringQuestionComponent,
    PhotoQuestionComponent,
    RadiusQuestionComponent,
    TentacleQuestionComponent,
    ThermometerQuestionComponent,
} from "@/components/QuestionCards";
import { APP_VERSION } from "@/lib/version";
import type {
    MatchingQuestion,
    MeasuringQuestion,
    RadiusQuestion,
    TentacleQuestion,
    ThermometerQuestion,
} from "@/maps/schema";

/**
 * Developer gallery of every unique question card, at `/debug/cards`.
 *
 * Renders one of each card category — plus the meaningful visual
 * variants within a category (answered / unanswered, inside / outside,
 * warmer / colder, started / finished, declined photo) — so a designer
 * or developer can eyeball every card surface on one screen without
 * having to set up a game and ask each question type by hand.
 *
 * The cards read the global `questions` store for a few cross-question
 * computations (uniqueness, labels), but they tolerate not finding
 * themselves there (see `QuestionCard` — `thisQuestion?.…`), so the
 * gallery renders them with sample `data` WITHOUT touching the real
 * store. That keeps the page side-effect-free: visiting it can't
 * pollute a live game's question list or fire Overpass lookups (those
 * only fire when a matching/measuring card is expanded into its
 * configure state, which the user triggers manually).
 *
 * Cards render in their natural collapsed state; tap any chevron to
 * expand. Keys are large negatives so they can never collide with a
 * real question key.
 */

interface Specimen {
    key: number;
    label: string;
    render: (key: number) => React.ReactNode;
}

let nextKey = -100_000;
const k = () => nextKey--;

const COMMON = {
    lat: 59.3293,
    lng: 18.0686,
    color: "red" as const,
    collapsed: true,
    createdAt: Date.now() - 4 * 60_000,
};

/** Hardcoded Point features for the tentacles `custom` branch — see
 *  the comment in the Tentacles section below for why we pin to
 *  custom here rather than the rulebook subtypes. */
const SAMPLE_PLACES = [
    {
        type: "Feature" as const,
        geometry: {
            type: "Point" as const,
            coordinates: [18.0686, 59.3293],
        },
        properties: { name: "Stockholm City Hall" },
    },
    {
        type: "Feature" as const,
        geometry: {
            type: "Point" as const,
            coordinates: [18.09, 59.34],
        },
        properties: { name: "Vasa Museum" },
    },
    {
        type: "Feature" as const,
        geometry: {
            type: "Point" as const,
            coordinates: [18.05, 59.32],
        },
        properties: { name: "Stockholm Concert Hall" },
    },
];

const SECTIONS: { title: string; specimens: Specimen[] }[] = [
    {
        title: "Radius (radar)",
        specimens: [
            {
                key: k(),
                label: "Unanswered (awaiting hider)",
                render: (key) => (
                    <RadiusQuestionComponent
                        questionKey={key}
                        data={
                            {
                                ...COMMON,
                                radius: 5,
                                unit: "kilometers",
                                within: true,
                                drag: true,
                            } as RadiusQuestion
                        }
                    />
                ),
            },
            {
                key: k(),
                label: "Answered — inside",
                render: (key) => (
                    <RadiusQuestionComponent
                        questionKey={key}
                        data={
                            {
                                ...COMMON,
                                radius: 1,
                                unit: "kilometers",
                                within: true,
                                drag: false,
                            } as RadiusQuestion
                        }
                    />
                ),
            },
            {
                key: k(),
                label: "Answered — outside",
                render: (key) => (
                    <RadiusQuestionComponent
                        questionKey={key}
                        data={
                            {
                                ...COMMON,
                                radius: 500,
                                unit: "meters",
                                within: false,
                                drag: false,
                            } as RadiusQuestion
                        }
                    />
                ),
            },
        ],
    },
    {
        title: "Thermometer",
        specimens: [
            {
                key: k(),
                label: "Started (measuring in progress)",
                render: (key) => (
                    <ThermometerQuestionComponent
                        questionKey={key}
                        data={
                            {
                                latA: COMMON.lat,
                                lngA: COMMON.lng,
                                latB: COMMON.lat,
                                lngB: COMMON.lng,
                                warmer: true,
                                colorA: "red",
                                colorB: "green",
                                drag: true,
                                collapsed: true,
                                status: "started",
                                startedAt: Date.now() - 2 * 60_000,
                            } as ThermometerQuestion
                        }
                    />
                ),
            },
            {
                key: k(),
                label: "Finished — warmer",
                render: (key) => (
                    <ThermometerQuestionComponent
                        questionKey={key}
                        data={
                            {
                                latA: COMMON.lat,
                                lngA: COMMON.lng,
                                latB: 59.34,
                                lngB: 18.09,
                                warmer: true,
                                colorA: "red",
                                colorB: "green",
                                drag: false,
                                collapsed: true,
                                status: "finished",
                                distance: "1km",
                                createdAt: COMMON.createdAt,
                            } as ThermometerQuestion
                        }
                    />
                ),
            },
            {
                key: k(),
                label: "Finished — colder",
                render: (key) => (
                    <ThermometerQuestionComponent
                        questionKey={key}
                        data={
                            {
                                latA: COMMON.lat,
                                lngA: COMMON.lng,
                                latB: 59.32,
                                lngB: 18.05,
                                warmer: false,
                                colorA: "red",
                                colorB: "green",
                                drag: false,
                                collapsed: true,
                                status: "finished",
                                distance: "500m",
                                createdAt: COMMON.createdAt,
                            } as ThermometerQuestion
                        }
                    />
                ),
            },
        ],
    },
    {
        title: "Tentacles",
        specimens: [
            // NB: rulebook tentacles (locationType "theme_park" /
            // "museum" / etc.) would fire `findTentacleLocations()`
            // *during JSX construction* — the call is a prop value,
            // so it runs whether or not the surrounding
            // `ManualAnswerDisclosure` renders the child tree. That's
            // why a freshly-opened gallery used to stack a dozen
            // "Determining tentacle locations…" toasts and burn
            // through Overpass quota. We pin the gallery to the
            // `custom` branch (Promise.resolve over `data.places`)
            // with hardcoded sample features instead — same visual
            // chrome, zero network.
            {
                key: k(),
                label: "Custom — 15-mile variant",
                render: (key) => (
                    <TentacleQuestionComponent
                        questionKey={key}
                        data={
                            {
                                ...COMMON,
                                radius: 15,
                                unit: "miles",
                                location: false,
                                locationType: "custom",
                                drag: true,
                                places: SAMPLE_PLACES,
                            } as unknown as TentacleQuestion
                        }
                    />
                ),
            },
            {
                key: k(),
                label: "Custom — 1-mile variant",
                render: (key) => (
                    <TentacleQuestionComponent
                        questionKey={key}
                        data={
                            {
                                ...COMMON,
                                radius: 1,
                                unit: "miles",
                                location: false,
                                locationType: "custom",
                                drag: true,
                                places: SAMPLE_PLACES,
                            } as unknown as TentacleQuestion
                        }
                    />
                ),
            },
        ],
    },
    {
        title: "Matching",
        specimens: [
            {
                key: k(),
                label: "Answered — same (museum)",
                render: (key) => (
                    <MatchingQuestionComponent
                        questionKey={key}
                        data={
                            {
                                ...COMMON,
                                type: "museum",
                                same: true,
                                drag: false,
                            } as unknown as MatchingQuestion
                        }
                    />
                ),
            },
            {
                key: k(),
                label: "Answered — different (museum)",
                render: (key) => (
                    <MatchingQuestionComponent
                        questionKey={key}
                        data={
                            {
                                ...COMMON,
                                type: "museum",
                                same: false,
                                drag: false,
                            } as unknown as MatchingQuestion
                        }
                    />
                ),
            },
            {
                key: k(),
                label: "Zone (admin level)",
                render: (key) => (
                    <MatchingQuestionComponent
                        questionKey={key}
                        data={
                            {
                                ...COMMON,
                                type: "zone",
                                same: true,
                                drag: false,
                                cat: { adminLevel: 4 },
                            } as unknown as MatchingQuestion
                        }
                    />
                ),
            },
        ],
    },
    {
        title: "Measuring",
        specimens: [
            {
                key: k(),
                label: "Answered — closer (museum)",
                render: (key) => (
                    <MeasuringQuestionComponent
                        questionKey={key}
                        data={
                            {
                                ...COMMON,
                                type: "museum",
                                hiderCloser: false,
                                drag: false,
                            } as unknown as MeasuringQuestion
                        }
                    />
                ),
            },
            {
                key: k(),
                label: "Answered — further (major city)",
                render: (key) => (
                    <MeasuringQuestionComponent
                        questionKey={key}
                        data={
                            {
                                ...COMMON,
                                type: "city",
                                hiderCloser: true,
                                drag: false,
                            } as unknown as MeasuringQuestion
                        }
                    />
                ),
            },
        ],
    },
    {
        title: "Photo",
        specimens: [
            {
                key: k(),
                label: "Unanswered (tree)",
                render: (key) => (
                    <PhotoQuestionComponent
                        questionKey={key}
                        data={{
                            type: "tree",
                            drag: true,
                            collapsed: true,
                            color: "red",
                            createdAt: COMMON.createdAt,
                        }}
                    />
                ),
            },
            {
                key: k(),
                label: "Declined (could not answer)",
                render: (key) => (
                    <PhotoQuestionComponent
                        questionKey={key}
                        data={{
                            type: "selfie",
                            drag: false,
                            declined: true,
                            collapsed: true,
                            color: "red",
                            createdAt: COMMON.createdAt,
                        }}
                    />
                ),
            },
        ],
    },
];

export function DebugCardsPage() {
    return (
        <div className="min-h-screen bg-background text-foreground">
            <header className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border px-4 py-3 flex items-center gap-3">
                <a
                    href="/"
                    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                    <ArrowLeft className="w-4 h-4" />
                    Back
                </a>
                <h1 className="font-poppins font-bold text-base">
                    Card gallery
                </h1>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground bg-secondary/60 rounded px-1.5 py-0.5">
                    {APP_VERSION}
                </span>
            </header>

            <div className="max-w-md mx-auto px-3 py-4 space-y-6 pb-24">
                <p className="text-xs text-muted-foreground leading-snug">
                    Every unique card surface with sample data. Cards render
                    collapsed — tap a chevron to expand. This page is
                    read-only: it doesn&apos;t touch your real question list.
                </p>
                {SECTIONS.map((section) => (
                    <section key={section.title} className="space-y-2">
                        <h2 className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                            {section.title}
                        </h2>
                        <div className="space-y-2">
                            {section.specimens.map((s) => (
                                <div key={s.key} className="space-y-1">
                                    <div className="text-[10px] text-muted-foreground/70 font-mono px-1">
                                        {s.label}
                                    </div>
                                    {s.render(s.key)}
                                </div>
                            ))}
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
}

export default DebugCardsPage;
