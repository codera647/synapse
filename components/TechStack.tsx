"use client";

import { useState } from "react";
import {
    SiNextdotjs,
    SiReact,
    SiTypescript,
    SiTailwindcss,
    SiPython,
    SiFastapi,
    SiPostgresql,
    SiAmazonwebservices,
    SiOpenai,
} from "react-icons/si";
import { FiCpu } from "react-icons/fi";

type Tech = {
    id: string;
    label: string;
    headline: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
};

const techs: Tech[] = [
    {
        id: "next",
        label: "Next.js",
        headline: "Use Synapse with Next.js",
        description:
            "App Router + React for the web dashboard, landing page, and future multi-tenant UI.",
        icon: SiNextdotjs,
    },
    {
        id: "react",
        label: "React",
        headline: "Real-time UX in React",
        description:
            "Chat UI, analytics panes, and team workspaces built with modern React patterns.",
        icon: SiReact,
    },
    {
        id: "ts",
        label: "TypeScript",
        headline: "Typed end-to-end with TypeScript",
        description:
            "Safer contracts between frontend, backend, and agent orchestration layers.",
        icon: SiTypescript,
    },
    {
        id: "tailwind",
        label: "Tailwind CSS",
        headline: "Dark, responsive surfaces with Tailwind",
        description:
            "Purple-dominant design system tuned for dashboards and dense information.",
        icon: SiTailwindcss,
    },
    {
        id: "python",
        label: "Python",
        headline: "Python for agents & pipelines",
        description:
            "Ingestion, chunking, embeddings, and MA-RAG orchestration run on Python services.",
        icon: SiPython,
    },
    {
        id: "fastapi",
        label: "FastAPI",
        headline: "FastAPI for the core API",
        description:
            "Sync/async endpoints powering retrieval, evidence aggregation, and chat routing.",
        icon: SiFastapi,
    },
    {
        id: "postgres",
        label: "Postgres",
        headline: "Stateful metadata on Postgres",
        description:
            "Organizations, libraries, buckets, chats, and jobs stored in a relational backbone.",
        icon: SiPostgresql,
    },
    {
        id: "aws",
        label: "AWS / GPUs",
        headline: "Hybrid deployment on AWS & GPU clouds",
        description:
            "Model hosting on GPU nodes (Lambda/AWS) with local preprocessing and secure context.",
        icon: SiAmazonwebservices,
    },
    {
        id: "llm",
        label: "Claude / GPT",
        headline: "Reasoning powered by Claude & GPT APIs",
        description:
            "Main LLMs sit on top of Synapse’s retrieval layer for final synthesis and reporting.",
        icon: SiOpenai,
    },
    {
        id: "agents",
        label: "Multi-Agent",
        headline: "Multi-agent RAG brain",
        description:
            "Planner, retrievers, extractors, and QA agents cooperating over your corpora.",
        icon: FiCpu,
    },
];

export default function TechStack() {
    const [activeId, setActiveId] = useState<string | null>(null);
    const active = activeId ? techs.find((t) => t.id === activeId) : null;

    return (
        <section className="relative" style={{ backgroundColor: "var(--bg-primary)", borderTop: "1px solid var(--border-color-subtle)" }}>
            <div className="max-w-6xl mx-auto px-6 py-16 flex flex-col md:flex-row items-center md:items-start md:justify-between gap-10">
                {/* Left text */}
                <div className="w-full md:w-1/2">
                    <p className="text-xs uppercase tracking-[0.25em] text-[#d4a5e9]">
                        Tech stack
                    </p>
                    <h2 className="mt-3 text-3xl font-semibold text-white">
                        Built with tools you already trust.
                    </h2>

                    <div className="mt-6">
                        <p className="text-sm font-medium text-gray-300">
                            {active ? active.headline : ""}
                        </p>
                        <p className="mt-2 text-sm text-gray-400">
                            {active ? active.description : "Explore the technologies powering Synapse's multi-agent RAG pipeline."}
                        </p>
                    </div>
                </div>

                {/* Right icons row */}
                <div className="w-full md:w-1/2">
                    <div className="flex flex-wrap md:justify-end gap-4" onMouseLeave={() => setActiveId(null)}>
                        {techs.map((tech) => {
                            const Icon = tech.icon;
                            const isActive = tech.id === active?.id;
                            return (
                                <button
                                    key={tech.id}
                                    type="button"
                                    onMouseEnter={() => setActiveId(tech.id)}
                                    onFocus={() => setActiveId(tech.id)}
                                    className={[
                                        "group relative flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-150",
                                        "text-gray-400",
                                        isActive
                                            ? "z-10 border-[#884ab4]/80 text-[#b87fd9] shadow-soft scale-105"
                                            : "hover:border-[#884ab4]/40 hover:text-gray-200",
                                        tech.id === "llm" || tech.id === "agents" ? "mt-4" : "",
                                    ].join(" ")}
                                    style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-color)" }}
                                    aria-label={tech.label}
                                >
                                    <Icon className="text-lg" />
                                    {isActive && (
                                        <span className="pointer-events-none absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-[#d4a5e9]">
                                            {tech.label}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>
        </section>
    );
}
