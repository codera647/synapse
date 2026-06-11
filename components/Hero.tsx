"use client";

import Link from "next/link";
import { FiArrowRight, FiPlay, FiFileText, FiSearch, FiZap } from "react-icons/fi";
import Reveal from "@/components/Reveal";

export default function Hero() {
    return (
        <section className="relative isolate overflow-hidden pt-36 pb-24">
            <div className="max-w-7xl mx-auto px-5 sm:px-6">
                <div className="grid lg:grid-cols-2 gap-14 items-center">
                    {/* Left: copy */}
                    <div className="text-center lg:text-left">
                        <Reveal>
                            <span className="eyebrow">
                                <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-400 animate-pulse" />
                                Neural Document Intelligence
                            </span>
                        </Reveal>

                        <Reveal delay={80}>
                            <h1 className="mt-6 text-5xl md:text-6xl font-bold tracking-tight leading-[1.05] text-white">
                                Turn your documents into{" "}
                                <span className="gradient-text-animated">answers you can trust</span>
                            </h1>
                        </Reveal>

                        <Reveal delay={160}>
                            <p className="mt-6 text-lg text-white/65 max-w-xl mx-auto lg:mx-0">
                                Synapse connects your knowledge — PDFs, figures, tables, databases — into a
                                multi-agent RAG engine that reads, reasons, and answers with citations you can
                                open and verify.
                            </p>
                        </Reveal>

                        <Reveal delay={240}>
                            <div className="mt-9 flex flex-col sm:flex-row items-center lg:justify-start justify-center gap-4">
                                <Link
                                    href="/register"
                                    className="btn-grad inline-flex items-center gap-2 rounded-xl px-6 py-3.5 font-medium text-white"
                                >
                                    Get started free
                                    <FiArrowRight className="w-4 h-4" />
                                </Link>
                                <a
                                    href="#how-it-works"
                                    className="glass hover-glow inline-flex items-center gap-2 rounded-xl px-6 py-3.5 font-medium text-white/85"
                                >
                                    <FiPlay className="w-4 h-4" />
                                    See how it works
                                </a>
                            </div>
                        </Reveal>

                        <Reveal delay={320}>
                            <div className="mt-10 flex items-center lg:justify-start justify-center gap-7 text-sm text-white/50">
                                <span className="flex items-center gap-2"><FiFileText className="text-violet-400" /> Layout-aware ingestion</span>
                                <span className="flex items-center gap-2"><FiSearch className="text-fuchsia-400" /> Hybrid retrieval</span>
                                <span className="hidden sm:flex items-center gap-2"><FiZap className="text-blue-400" /> Cited answers</span>
                            </div>
                        </Reveal>
                    </div>

                    {/* Right: interactive glass chat preview */}
                    <Reveal delay={200} className="relative">
                        <div className="relative mx-auto max-w-md lg:max-w-none">
                            {/* glow behind card */}
                            <div className="absolute -inset-6 rounded-[2rem] bg-gradient-to-tr from-violet-600/30 via-fuchsia-500/20 to-blue-500/30 blur-2xl" />

                            <div className="relative glass-strong glass-hi rounded-3xl p-5 shadow-2xl shadow-black/50 animate-float">
                                {/* window chrome */}
                                <div className="flex items-center gap-1.5 pb-4 border-b border-white/10">
                                    <span className="h-3 w-3 rounded-full bg-red-400/70" />
                                    <span className="h-3 w-3 rounded-full bg-yellow-400/70" />
                                    <span className="h-3 w-3 rounded-full bg-green-400/70" />
                                    <span className="ml-3 text-xs text-white/40">Synapse · Research library</span>
                                </div>

                                {/* user bubble */}
                                <div className="mt-4 flex justify-end">
                                    <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2.5 text-sm text-white shadow-lg shadow-violet-600/30">
                                        What method does the paper use for object detection?
                                    </div>
                                </div>

                                {/* assistant bubble */}
                                <div className="mt-4 flex justify-start">
                                    <div className="max-w-[88%] rounded-2xl rounded-tl-sm glass px-4 py-3 text-sm text-white/85 leading-relaxed">
                                        It uses a <span className="text-fuchsia-300 font-medium">Region Proposal Network (RPN)</span> sharing
                                        full-image convolutional features with the detection network for near cost-free region proposals.
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 border border-white/10 px-2.5 py-1 text-xs text-white/70">
                                                <FiFileText className="w-3 h-3 text-violet-300" /> Faster_R-CNN.pdf · p.3
                                            </span>
                                            <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 border border-white/10 px-2.5 py-1 text-xs text-white/70">
                                                <FiFileText className="w-3 h-3 text-fuchsia-300" /> VGG.pdf · p.1
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                {/* typing */}
                                <div className="mt-4 flex justify-start">
                                    <div className="synapse-typing">
                                        <span className="synapse-typing__dot" />
                                        <span className="synapse-typing__dot" />
                                        <span className="synapse-typing__dot" />
                                    </div>
                                </div>

                                {/* input */}
                                <div className="mt-4 flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
                                    <span className="text-sm text-white/40 flex-1">Ask anything across your libraries…</span>
                                    <span className="grid place-items-center h-7 w-7 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500">
                                        <FiArrowRight className="w-3.5 h-3.5 text-white" />
                                    </span>
                                </div>
                            </div>

                            {/* floating stat chips */}
                            <div className="absolute -left-6 top-10 hidden md:flex glass rounded-xl px-3 py-2 text-xs text-white/80 shadow-lg animate-float" style={{ animationDelay: "1s" }}>
                                <span className="text-emerald-400 font-semibold mr-1">7-stage</span> pipeline
                            </div>
                            <div className="absolute -right-4 bottom-12 hidden md:flex glass rounded-xl px-3 py-2 text-xs text-white/80 shadow-lg animate-float" style={{ animationDelay: "2s" }}>
                                <span className="text-cyan-300 font-semibold mr-1">GPU</span> accelerated
                            </div>
                        </div>
                    </Reveal>
                </div>

                {/* trust strip */}
                <Reveal delay={120}>
                    <div className="mt-20 flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-white/35 text-sm">
                        <span className="uppercase tracking-widest text-xs">Powered by</span>
                        <span className="font-medium text-white/55">DocLayout-YOLO</span>
                        <span className="font-medium text-white/55">Surya OCR</span>
                        <span className="font-medium text-white/55">Qwen-VL</span>
                        <span className="font-medium text-white/55">BGE Embeddings</span>
                        <span className="font-medium text-white/55">GPT-4o</span>
                    </div>
                </Reveal>
            </div>
        </section>
    );
}
