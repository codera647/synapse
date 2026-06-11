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
    SiOpenai,
    SiSupabase,
} from "react-icons/si";
import { FiCpu } from "react-icons/fi";
import Reveal from "@/components/Reveal";

type Tech = {
    id: string;
    label: string;
    headline: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
};

const techs: Tech[] = [
    { id: "next", label: "Next.js", headline: "Next.js App Router", description: "React App Router powers the dashboard, landing page, and multi-tenant UI.", icon: SiNextdotjs },
    { id: "react", label: "React", headline: "Real-time UX in React", description: "Streaming chat, live pipeline progress, and team workspaces.", icon: SiReact },
    { id: "ts", label: "TypeScript", headline: "Typed end-to-end", description: "Safer contracts between frontend, backend, and agent orchestration.", icon: SiTypescript },
    { id: "tailwind", label: "Tailwind", headline: "Glass design system", description: "A vivid, responsive design system tuned for dense dashboards.", icon: SiTailwindcss },
    { id: "python", label: "Python", headline: "Agents & pipelines", description: "Ingestion, chunking, embeddings, and MA-RAG orchestration.", icon: SiPython },
    { id: "fastapi", label: "FastAPI", headline: "The core API", description: "Async endpoints for retrieval, evidence aggregation, and chat.", icon: SiFastapi },
    { id: "supabase", label: "Supabase", headline: "Postgres + pgvector", description: "Orgs, libraries, jobs, chats, and vector search in one backbone.", icon: SiSupabase },
    { id: "postgres", label: "Postgres", headline: "Relational backbone", description: "Durable job queue and metadata for the whole pipeline.", icon: SiPostgresql },
    { id: "llm", label: "GPT-4o", headline: "Reasoning layer", description: "The main LLM sits on top of Synapse's retrieval for final synthesis.", icon: SiOpenai },
    { id: "agents", label: "Multi-Agent", headline: "Multi-agent RAG brain", description: "Planner, retrievers, and QA agents cooperating over your corpora.", icon: FiCpu },
];

export default function TechStack() {
    const [activeId, setActiveId] = useState<string | null>("next");
    const active = activeId ? techs.find((t) => t.id === activeId) : null;

    return (
        <section id="tech" className="relative py-24">
            <div className="max-w-7xl mx-auto px-5 sm:px-6">
                <div className="grid lg:grid-cols-2 gap-12 items-center">
                    <Reveal>
                        <span className="eyebrow">Tech stack</span>
                        <h2 className="mt-5 text-3xl md:text-5xl font-bold tracking-tight text-white">
                            Built with tools{" "}
                            <span className="gradient-text">you already trust</span>
                        </h2>
                        <div className="mt-7 rounded-2xl glass glass-hi p-6 min-h-[7.5rem]">
                            <p className="text-base font-semibold text-white">
                                {active ? active.headline : "Explore the stack"}
                            </p>
                            <p className="mt-2 text-sm text-white/60">
                                {active ? active.description : "Hover any technology to learn how it powers Synapse."}
                            </p>
                        </div>
                    </Reveal>

                    <Reveal delay={120}>
                        <div
                            className="grid grid-cols-5 gap-3 sm:gap-4"
                            onMouseLeave={() => setActiveId("next")}
                        >
                            {techs.map((tech) => {
                                const Icon = tech.icon;
                                const isActive = tech.id === active?.id;
                                return (
                                    <button
                                        key={tech.id}
                                        type="button"
                                        onMouseEnter={() => setActiveId(tech.id)}
                                        onFocus={() => setActiveId(tech.id)}
                                        aria-label={tech.label}
                                        className={[
                                            "group relative flex aspect-square items-center justify-center rounded-2xl transition-all duration-200 glass",
                                            isActive
                                                ? "scale-105 border-violet-400/60 text-fuchsia-300 shadow-lg shadow-violet-500/20"
                                                : "text-white/45 hover:text-white/80 hover:-translate-y-0.5",
                                        ].join(" ")}
                                    >
                                        <Icon className="text-2xl" />
                                        <span
                                            className={`pointer-events-none absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] transition-opacity ${
                                                isActive ? "opacity-100 text-violet-300" : "opacity-0"
                                            }`}
                                        >
                                            {tech.label}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </Reveal>
                </div>
            </div>
        </section>
    );
}
