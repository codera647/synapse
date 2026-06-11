"use client";

import Link from "next/link";
import { FiArrowRight } from "react-icons/fi";
import Reveal from "@/components/Reveal";

export default function CTA() {
    return (
        <section className="relative py-24">
            <div className="max-w-5xl mx-auto px-5 sm:px-6">
                <Reveal>
                    <div className="relative overflow-hidden rounded-[2rem] glass-strong glass-hi px-8 py-16 sm:px-16 text-center">
                        {/* gradient wash */}
                        <div className="pointer-events-none absolute inset-0 opacity-80"
                            style={{ background: "radial-gradient(70% 120% at 50% 0%, rgba(139,92,246,0.25), transparent 60%), radial-gradient(60% 100% at 80% 100%, rgba(217,70,239,0.18), transparent 60%)" }} />

                        <div className="relative">
                            <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-white">
                                Ready to <span className="gradient-text-animated">talk to your documents?</span>
                            </h2>
                            <p className="mt-5 text-white/65 max-w-xl mx-auto">
                                Connect a library, let Synapse read it, and start asking questions in minutes.
                            </p>
                            <div className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-4">
                                <Link href="/register" className="btn-grad inline-flex items-center gap-2 rounded-xl px-7 py-3.5 font-medium text-white">
                                    Start free <FiArrowRight className="w-4 h-4" />
                                </Link>
                                <Link href="/login" className="glass hover-glow rounded-xl px-7 py-3.5 font-medium text-white/85">
                                    Sign in
                                </Link>
                            </div>
                        </div>
                    </div>
                </Reveal>
            </div>
        </section>
    );
}
