"use client";

import {
    FiUploadCloud,
    FiGrid,
    FiType,
    FiImage,
    FiScissors,
    FiCpu,
    FiMessageCircle,
} from "react-icons/fi";
import Reveal from "@/components/Reveal";

const stages = [
    { icon: FiUploadCloud, name: "Sync", desc: "Pull documents from your connected Google Drive into secure storage." },
    { icon: FiGrid, name: "Layout", desc: "DocLayout-YOLO detects text, figures, tables, and formulas on every page." },
    { icon: FiType, name: "Extract", desc: "Text is extracted region-by-region with PyMuPDF and Surya OCR." },
    { icon: FiImage, name: "Caption", desc: "A vision-language model reads figures, tables, and charts into rich text." },
    { icon: FiScissors, name: "Chunk", desc: "Content is split into retrieval-ready, structure-aware chunks." },
    { icon: FiCpu, name: "Embed", desc: "BGE embeddings are indexed in pgvector for hybrid semantic search." },
    { icon: FiMessageCircle, name: "Chat", desc: "Ask anything — multi-agent retrieval answers with verifiable citations." },
];

export default function HowItWorks() {
    return (
        <section id="how-it-works" className="relative py-24">
            <div className="max-w-7xl mx-auto px-5 sm:px-6">
                <Reveal className="mx-auto max-w-2xl text-center">
                    <span className="eyebrow">How it works</span>
                    <h2 className="mt-5 text-3xl md:text-5xl font-bold tracking-tight text-white">
                        From raw PDFs to{" "}
                        <span className="gradient-text">cited answers</span>
                    </h2>
                    <p className="mt-4 text-white/60">
                        A seven-stage GPU pipeline turns messy documents into a knowledge base you can question.
                    </p>
                </Reveal>

                {/* timeline */}
                <div className="relative mt-16">
                    {/* connecting gradient line (desktop) */}
                    <div className="hidden lg:block absolute top-7 left-0 right-0 h-px bg-gradient-to-r from-transparent via-violet-500/40 to-transparent" />

                    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-7">
                        {stages.map((stage, i) => {
                            const Icon = stage.icon;
                            return (
                                <Reveal key={stage.name} delay={i * 70} className="relative">
                                    <div className="flex lg:flex-col items-start lg:items-center gap-4 lg:gap-0 text-left lg:text-center">
                                        {/* node */}
                                        <div className="relative shrink-0">
                                            <div className="grid place-items-center h-14 w-14 rounded-2xl glass-strong glass-hi shadow-lg">
                                                <Icon className="text-violet-300 text-xl" />
                                            </div>
                                            <span className="absolute -top-2 -right-2 grid place-items-center h-5 w-5 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-[10px] font-bold text-white ring-2 ring-[#07060f]">
                                                {i + 1}
                                            </span>
                                        </div>
                                        <div className="lg:mt-4">
                                            <h3 className="text-sm font-semibold text-white">{stage.name}</h3>
                                            <p className="mt-1 text-xs text-white/55 lg:px-1">{stage.desc}</p>
                                        </div>
                                    </div>
                                </Reveal>
                            );
                        })}
                    </div>
                </div>
            </div>
        </section>
    );
}
