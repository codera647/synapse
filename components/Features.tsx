"use client";

import {
    FiDatabase,
    FiLayers,
    FiCpu,
    FiUsers,
    FiBarChart2,
    FiShield,
} from "react-icons/fi";
import Reveal from "@/components/Reveal";

const features = [
    {
        icon: FiLayers,
        label: "Libraries & Buckets",
        title: "Structured knowledge, not vector soup.",
        body: "Organize documents, feeds, and databases into libraries and clusters so Synapse reasons with context — not chaos.",
        bullets: ["Per-org libraries", "Clustered by topic & source", "RAG-ready at scale"],
        glow: "from-violet-500/25",
    },
    {
        icon: FiDatabase,
        label: "Multi-source RAG",
        title: "Docs, DBs, and streams in one query.",
        body: "Blend unstructured docs with tables and live feeds into a single unified retrieval layer.",
        bullets: ["Keyword + semantic + neighbor", "Hybrid org/library filters", "Grounded, cited answers"],
        glow: "from-fuchsia-500/25",
    },
    {
        icon: FiCpu,
        label: "Multi-Agent Reasoning",
        title: "MA-RAG with a curious brain.",
        body: "A planner, extractors, and a main LLM cooperate to decompose queries, pull better evidence, and avoid hallucinations.",
        bullets: ["MA-RAG + chain-of-thought", "Curious follow-up retrieval", "Evidence-first answers"],
        glow: "from-blue-500/25",
    },
    {
        icon: FiBarChart2,
        label: "Vision & Tables",
        title: "It reads figures, not just text.",
        body: "Layout detection, OCR, and a vision-language model caption figures, tables, and charts so nothing is lost.",
        bullets: ["DocLayout-YOLO regions", "Surya / Tesseract OCR", "Qwen-VL captions"],
        glow: "from-cyan-500/25",
    },
    {
        icon: FiUsers,
        label: "Team Workspaces",
        title: "Chat as a team, think as one brain.",
        body: "Share threads, reuse context, and let Synapse answer from the combined knowledge of your workspace.",
        bullets: ["Shared & parallel threads", "Import chats as context", "Org- and team-level spaces"],
        glow: "from-indigo-500/25",
    },
    {
        icon: FiShield,
        label: "Hybrid Local + Cloud",
        title: "Your data stays home.",
        body: "Run heavy preprocessing on your own GPU and send only compact context to the cloud LLM.",
        bullets: ["Local doc & DB processing", "Cloud LLM for synthesis", "On-prem friendly"],
        glow: "from-emerald-500/25",
    },
];

export default function Features() {
    return (
        <section id="features" className="relative py-24">
            <div className="max-w-7xl mx-auto px-5 sm:px-6">
                <Reveal className="mx-auto max-w-2xl text-center">
                    <span className="eyebrow">Capabilities</span>
                    <h2 className="mt-5 text-3xl md:text-5xl font-bold tracking-tight text-white">
                        The whole pipeline,{" "}
                        <span className="gradient-text">not just a chatbot</span>
                    </h2>
                    <p className="mt-4 text-white/60">
                        From ingestion and layout-aware parsing to retrieval, reasoning, and cited answers —
                        Synapse ships the entire stack.
                    </p>
                </Reveal>

                <div className="mt-14 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                    {features.map((feature, i) => {
                        const Icon = feature.icon;
                        return (
                            <Reveal key={feature.label} delay={(i % 3) * 90}>
                                <div className="group relative h-full overflow-hidden rounded-3xl glass glass-hi hover-glow p-6 flex flex-col">
                                    {/* hover glow */}
                                    <div className={`pointer-events-none absolute -top-20 -right-20 h-48 w-48 rounded-full bg-gradient-to-br ${feature.glow} to-transparent blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />

                                    <div className="relative z-10 flex items-center gap-3 mb-4">
                                        <div className="grid place-items-center h-11 w-11 rounded-2xl bg-gradient-to-br from-violet-500/90 to-fuchsia-500/90 shadow-lg shadow-violet-500/25">
                                            <Icon className="text-white text-lg" />
                                        </div>
                                        <span className="text-xs font-medium uppercase tracking-wider text-white/50">
                                            {feature.label}
                                        </span>
                                    </div>

                                    <h3 className="relative z-10 text-lg font-semibold text-white mb-2">
                                        {feature.title}
                                    </h3>
                                    <p className="relative z-10 text-sm text-white/60 mb-5">{feature.body}</p>

                                    <ul className="relative z-10 mt-auto space-y-2 text-sm text-white/70">
                                        {feature.bullets.map((b) => (
                                            <li key={b} className="flex items-start gap-2">
                                                <span className="mt-[7px] h-1.5 w-1.5 rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400" />
                                                <span>{b}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </Reveal>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
