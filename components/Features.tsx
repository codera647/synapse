import {
    FiDatabase,
    FiLayers,
    FiCpu,
    FiUsers,
    FiBarChart2,
    FiShield,
} from "react-icons/fi";

const features = [
    {
        icon: FiLayers,
        label: "Libraries & Buckets",
        title: "Structured knowledge, not vector soup.",
        body: "Organize documents, social feeds, and databases into libraries, buckets, and clusters so Synapse can reason with context, not chaos.",
        bullets: [
            "Per-org libraries and buckets",
            "Clustered by topic & source",
            "Ready for RAG at scale",
        ],
    },
    {
        icon: FiDatabase,
        label: "Multi-source RAG",
        title: "Docs, DBs, and streams in one query.",
        body: "Blend unstructured docs with SQL/NoSQL tables and live feeds. Synapse turns everything into a unified retrieval layer.",
        bullets: [
            "Keyword + semantic + neighbor search",
            "Hybrid filters by org / library / bucket",
            "Grounded answers with citations",
        ],
    },
    {
        icon: FiCpu,
        label: "Multi-Agent Reasoning",
        title: "MA-RAG with a curious brain.",
        body: "Planner, extractors, and a main LLM (Claude / GPT) cooperate to decompose queries, pull better evidence, and avoid hallucinations.",
        bullets: [
            "MA-RAG + Chain-of-Thought",
            "Curious follow-up retrieval",
            "Evidence-first answers",
        ],
    },
    {
        icon: FiBarChart2,
        label: "Analytics & Graphs",
        title: "From raw data to live dashboards.",
        body: "Generate charts, graphs, and reports directly from your corpora and databases — ready for BI tools or internal stakeholders.",
        bullets: [
            "Auto-generated charts & summaries",
            "Time-series & comparison queries",
            "Exportable reports & dashboards",
        ],
    },
    {
        icon: FiUsers,
        label: "Team Workspaces",
        title: "Chat as a team, think as one brain.",
        body: "Share chats, reuse context across threads, and let Synapse answer using the combined knowledge of your entire workspace.",
        bullets: [
            "Shared chats & parallel threads",
            "Import previous chats as context",
            "Org-level and team-level spaces",
        ],
    },
    {
        icon: FiShield,
        label: "Hybrid Local + Cloud",
        title: "Your data stays home. Synapse travels.",
        body: "Run heavy preprocessing on local GPUs while only sending compact context to cloud LLMs — built for security-sensitive orgs.",
        bullets: [
            "Local doc & DB processing",
            "Cloud LLM for final reasoning",
            "On-prem friendly architecture",
        ],
    },
];

export default function Features() {
    return (
        <section className="relative" style={{ backgroundColor: "var(--bg-primary)", borderTop: "1px solid var(--border-color-subtle)" }}>
            <div className="max-w-6xl mx-auto px-6 py-20">
                <div className="mb-10 text-center">
                    <p className="text-xs uppercase tracking-[0.25em] text-[#d4a5e9]">
                        Features
                    </p>
                    <h2 className="mt-3 text-3xl md:text-4xl font-semibold text-white">
                        Everything Synapse needs to think over your data.
                    </h2>
                    <p className="mt-4 text-sm md:text-base text-gray-400 max-w-2xl mx-auto">
                        From ingestion and retrieval to reasoning and analytics, Synapse
                        ships the whole pipeline — not just a chatbot on top of a vector
                        store.
                    </p>
                </div>

                <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
                    {features.map((feature) => {
                        const Icon = feature.icon;
                        return (
                            <div
                                key={feature.label}
                                className="group relative overflow-hidden rounded-3xl p-5 flex flex-col justify-between shadow-soft transition duration-200 hover:border-[#884ab4]/40 hover:-translate-y-1"
                                style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-color)" }}
                            >
                                {/* subtle inner glow */}
                                <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition duration-300">
                                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(136,74,180,0.20),_transparent_60%)]" />
                                </div>

                                <div className="relative z-10">
                                    <div className="flex items-center gap-2 text-xs font-medium text-gray-300 mb-3">
                                        <div className="h-7 w-7 rounded-xl bg-white/5 flex items-center justify-center">
                                            <Icon className="text-[#b87fd9]" />
                                        </div>
                                        <span>{feature.label}</span>
                                    </div>

                                    <h3 className="text-[15px] font-semibold text-white mb-2">
                                        {feature.title}
                                    </h3>
                                    <p className="text-xs text-gray-400 mb-4">{feature.body}</p>
                                </div>

                                <ul className="relative z-10 mt-auto space-y-1.5 text-xs text-gray-300">
                                    {feature.bullets.map((b) => (
                                        <li key={b} className="flex items-start gap-1.5">
                                            <span className="mt-[6px] h-1.5 w-1.5 rounded-full bg-[#884ab4]" />
                                            <span>{b}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
