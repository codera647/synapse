"use client";

import Image from "next/image";
import { FiGithub, FiTwitter, FiMail } from "react-icons/fi";

export default function Footer() {
    return (
        <footer className="relative mt-12 border-t border-white/10">
            <div className="max-w-7xl mx-auto px-5 sm:px-6 py-14">
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-10">
                    {/* Brand */}
                    <div className="max-w-sm">
                        <div className="flex items-center gap-2.5">
                            <Image src="/logo.png" alt="Synapse" width={32} height={32} className="h-8 w-8" />
                            <span className="text-lg font-semibold tracking-tight text-white">Synapse</span>
                        </div>
                        <p className="mt-4 text-sm text-white/55">
                            Neural document intelligence — multi-agent RAG and analytics over your
                            documents, databases, and streams. Built for teams with more data than time.
                        </p>
                    </div>

                    {/* Links */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-8 text-sm">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/40 mb-3">Product</p>
                            <ul className="space-y-2.5 text-white/65">
                                <li><a href="#features" className="hover:text-white transition-colors">Features</a></li>
                                <li><a href="#how-it-works" className="hover:text-white transition-colors">How it works</a></li>
                                <li><a href="#tech" className="hover:text-white transition-colors">Tech stack</a></li>
                            </ul>
                        </div>
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/40 mb-3">For teams</p>
                            <ul className="space-y-2.5 text-white/65">
                                <li className="hover:text-white transition-colors cursor-pointer">Research</li>
                                <li className="hover:text-white transition-colors cursor-pointer">Engineering</li>
                                <li className="hover:text-white transition-colors cursor-pointer">Analytics</li>
                            </ul>
                        </div>
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/40 mb-3">About</p>
                            <ul className="space-y-2.5 text-white/65">
                                <li className="hover:text-white transition-colors cursor-pointer">FYP project</li>
                                <li className="hover:text-white transition-colors cursor-pointer">Roadmap</li>
                                <li className="hover:text-white transition-colors cursor-pointer">Contact</li>
                            </ul>
                        </div>
                    </div>
                </div>

                <div className="mt-12 pt-6 border-t border-white/10 flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-white/40">
                    <p>© {new Date().getFullYear()} Synapse — a research / FYP prototype for RAG-based document intelligence.</p>
                    <div className="flex items-center gap-5">
                        <a href="https://github.com/codera647/synapse" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 hover:text-white transition-colors">
                            <FiGithub /> <span>GitHub</span>
                        </a>
                        <a href="#" className="inline-flex items-center gap-1.5 hover:text-white transition-colors"><FiTwitter /> <span>Updates</span></a>
                        <a href="mailto:hello@synapse.local" className="inline-flex items-center gap-1.5 hover:text-white transition-colors"><FiMail /> <span>Contact</span></a>
                    </div>
                </div>
            </div>
        </footer>
    );
}
