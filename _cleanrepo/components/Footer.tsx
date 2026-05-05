"use client";

import Image from "next/image";
import { FiGithub, FiTwitter, FiMail } from "react-icons/fi";

export default function Footer() {
    return (
        <footer style={{ backgroundColor: "var(--bg-footer)", borderTop: "1px solid var(--border-color-subtle)" }}>
            <div className="max-w-6xl mx-auto px-6 py-10">
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-8">
                    {/* Brand / description */}
                    <div className="flex-1">
                        <div className="flex items-center gap-2">
                            <Image
                                src="/logo.png"
                                alt="Synapse Logo"
                                width={32}
                                height={32}
                                className="h-8 w-8"
                            />
                            <span className="font-semibold tracking-wide text-gray-200">
                                Synapse
                            </span>
                        </div>
                        <p className="mt-4 text-sm text-gray-400 max-w-sm">
                            RAG-based search, analytics, and multi-agent reasoning over your
                            organization's documents, databases, and streams — built for
                            teams with more data than time.
                        </p>
                    </div>

                    {/* Links */}
                    <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 gap-6 text-sm">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-400 mb-3">
                                Product
                            </p>
                            <ul className="space-y-2 text-gray-300">
                                <li className="hover:text-white cursor-pointer">Features</li>
                                <li className="hover:text-white cursor-pointer">
                                    Tech stack
                                </li>
                                <li className="hover:text-white cursor-pointer">
                                    How it works
                                </li>
                            </ul>
                        </div>

                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-400 mb-3">
                                For teams
                            </p>
                            <ul className="space-y-2 text-gray-300">
                                <li className="hover:text-white cursor-pointer">Research</li>
                                <li className="hover:text-white cursor-pointer">
                                    Engineering
                                </li>
                                <li className="hover:text-white cursor-pointer">Analytics</li>
                            </ul>
                        </div>

                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-400 mb-3">
                                About
                            </p>
                            <ul className="space-y-2 text-gray-300">
                                <li className="hover:text-white cursor-pointer">
                                    FYP project
                                </li>
                                <li className="hover:text-white cursor-pointer">
                                    Roadmap
                                </li>
                                <li className="hover:text-white cursor-pointer">Contact</li>
                            </ul>
                        </div>
                    </div>
                </div>

                {/* Bottom bar */}
                <div className="mt-8 pt-4 flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-gray-500" style={{ borderTop: "1px solid var(--border-color-subtle)" }}>
                    <p>
                        © {new Date().getFullYear()} Synapse. Built as a research/FYP
                        prototype for RAG-based document intelligence.
                    </p>
                    <div className="flex items-center gap-4 text-gray-400">
                        <a
                            href="#"
                            className="inline-flex items-center gap-1 hover:text-white"
                        >
                            <FiGithub />
                            <span>GitHub</span>
                        </a>
                        <a
                            href="#"
                            className="inline-flex items-center gap-1 hover:text-white"
                        >
                            <FiTwitter />
                            <span>Updates</span>
                        </a>
                        <a
                            href="mailto:hello@synapse.local"
                            className="inline-flex items-center gap-1 hover:text-white"
                        >
                            <FiMail />
                            <span>Contact</span>
                        </a>
                    </div>
                </div>
            </div>
        </footer>
    );
}
