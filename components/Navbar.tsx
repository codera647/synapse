"use client";

import Link from "next/link";
import Image from "next/image";
import { FaGithub } from "react-icons/fa";
import { FiUser, FiSettings, FiZap, FiLogOut } from "react-icons/fi";
import { useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";
import { Session } from "@supabase/supabase-js";

export default function Navbar() {
    const supabase = createSupabaseBrowserClient();

    const [loading, setLoading] = useState(true);
    const [session, setSession] = useState<Session | null>(null);
    const [scrolled, setScrolled] = useState(false);

    // dropdown
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    const userEmail = session?.user?.email ?? "";

    useEffect(() => {
        supabase.auth.getSession().then(({ data }) => {
            setSession(data.session);
            setLoading(false);
        });

        const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
            setSession(newSession);
            setLoading(false);
            setMenuOpen(false);
        });

        return () => listener.subscription.unsubscribe();
    }, [supabase]);

    // close dropdown on outside click + escape
    useEffect(() => {
        function onClickOutside(e: MouseEvent) {
            if (!menuRef.current) return;
            if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        }
        function onEsc(e: KeyboardEvent) {
            if (e.key === "Escape") setMenuOpen(false);
        }
        document.addEventListener("mousedown", onClickOutside);
        document.addEventListener("keydown", onEsc);
        return () => {
            document.removeEventListener("mousedown", onClickOutside);
            document.removeEventListener("keydown", onEsc);
        };
    }, []);

    // subtle solidify-on-scroll
    useEffect(() => {
        const onScroll = () => setScrolled(window.scrollY > 12);
        onScroll();
        window.addEventListener("scroll", onScroll, { passive: true });
        return () => window.removeEventListener("scroll", onScroll);
    }, []);

    async function handleLogout() {
        await supabase.auth.signOut();
        setMenuOpen(false);
    }

    return (
        <header
            className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 ${
                scrolled
                    ? "glass-strong border-b border-white/10"
                    : "bg-transparent border-b border-transparent"
            }`}
        >
            <nav className="max-w-7xl mx-auto px-5 sm:px-6 h-16 flex items-center justify-between">
                {/* Left: Logo + Nav Items */}
                <div className="flex items-center gap-8">
                    <Link href="/" className="flex items-center gap-2.5 group">
                        <span className="relative">
                            <span className="absolute -inset-1 rounded-xl bg-violet-500/30 blur-md opacity-0 group-hover:opacity-100 transition-opacity" />
                            <Image
                                src="/logo.png"
                                alt="Synapse"
                                width={40}
                                height={40}
                                className="relative h-9 w-9"
                                priority
                            />
                        </span>
                        <span className="text-lg font-semibold tracking-tight text-white">
                            Synapse
                        </span>
                    </Link>

                    <div className="hidden md:flex items-center gap-7 text-sm text-white/70">
                        {["Features", "How it works", "Tech"].map((item) => (
                            <a
                                key={item}
                                href={`#${item.toLowerCase().replace(/\s+/g, "-")}`}
                                className="relative transition-colors hover:text-white after:absolute after:-bottom-1 after:left-0 after:h-px after:w-0 after:bg-gradient-to-r after:from-violet-400 after:to-fuchsia-400 hover:after:w-full after:transition-all after:duration-300"
                            >
                                {item}
                            </a>
                        ))}
                    </div>
                </div>

                {/* Right */}
                <div className="flex items-center gap-3 sm:gap-4 text-sm">
                    <a
                        href="https://github.com/codera647/synapse"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hidden sm:flex items-center gap-2 text-white/55 hover:text-white transition-colors"
                    >
                        <FaGithub className="w-5 h-5" />
                        <span>GitHub</span>
                    </a>

                    {loading ? (
                        <div className="h-8 w-20 rounded-lg bg-white/5 animate-pulse" />
                    ) : session ? (
                        <>
                            <Link
                                href="/dashboard"
                                className="btn-grad rounded-xl px-4 py-2 font-medium text-white"
                            >
                                Dashboard
                            </Link>

                            <div className="relative" ref={menuRef}>
                                <button
                                    onClick={() => setMenuOpen((v) => !v)}
                                    className="flex items-center justify-center hover:scale-105 transition-transform"
                                    aria-label="Open profile menu"
                                >
                                    <div className="h-9 w-9 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-lg shadow-violet-500/30 ring-1 ring-white/20">
                                        <FiUser className="w-4 h-4 text-white" />
                                    </div>
                                </button>

                                {menuOpen && (
                                    <div className="absolute right-0 mt-3 w-72 max-w-[calc(100vw-1.5rem)] rounded-2xl surface-menu overflow-hidden z-[60] origin-top-right">
                                        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-white/10">
                                            <div className="h-9 w-9 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center ring-1 ring-white/20 shrink-0">
                                                <FiUser className="w-4 h-4 text-white" />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-xs text-white/40">Signed in as</p>
                                                <p className="text-sm font-medium text-white/90 truncate">{userEmail}</p>
                                            </div>
                                        </div>
                                        <div className="p-1.5">
                                            <button className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-white/80 hover:bg-white/8 transition-colors">
                                                <FiSettings className="w-4 h-4 text-white/50" />
                                                <span>Account preferences</span>
                                            </button>
                                            <button className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-white/80 hover:bg-white/8 transition-colors">
                                                <FiZap className="w-4 h-4 text-white/50" />
                                                <span>Feature previews</span>
                                            </button>
                                            <div className="my-1 h-px bg-white/8" />
                                            <button
                                                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-rose-300/90 hover:bg-rose-500/12 transition-colors"
                                                onClick={handleLogout}
                                            >
                                                <FiLogOut className="w-4 h-4" />
                                                <span>Log out</span>
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <>
                            <Link
                                href="/login"
                                className="text-white/75 hover:text-white transition-colors px-2"
                            >
                                Login
                            </Link>
                            <Link
                                href="/register"
                                className="btn-grad rounded-xl px-4 py-2 font-medium text-white"
                            >
                                Start Free
                            </Link>
                        </>
                    )}
                </div>
            </nav>
        </header>
    );
}
