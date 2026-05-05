"use client";

import Link from "next/link";
import Image from "next/image";
import { FaGithub, FaStar } from "react-icons/fa";
import { FiUser, FiSettings, FiZap, FiLogOut } from "react-icons/fi";
import { useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";
import { Session } from "@supabase/supabase-js";

export default function Navbar() {
    const supabase = createSupabaseBrowserClient();

    const [loading, setLoading] = useState(true);
    const [session, setSession] = useState<Session | null>(null);

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

    async function handleLogout() {
        await supabase.auth.signOut();
        setMenuOpen(false);
    }

    return (
        <header
            className="fixed top-0 inset-x-0 z-50 backdrop-blur-xl"
            style={{
                backgroundColor: "var(--bg-primary)",
                borderBottom: "1px solid var(--border-color-subtle)",
            }}
        >
            <nav className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
                {/* Left: Logo + Nav Items */}
                <div className="flex items-center gap-8">
                    <Link href="/" className="flex items-center gap-3">
                        {/* Bigger + more dominant logo */}
                        <Image
                            src="/logo.png"
                            alt="Synapse Logo"
                            width={44}
                            height={44}
                            className="h-11 w-11"
                            priority
                        />
                        <span className="font-semibold tracking-wide text-gray-200 text-lg">
                            Synapse
                        </span>
                    </Link>

                    <div className="flex items-center gap-6 text-sm text-gray-300">
                        <button className="relative hover:text-white transition-colors duration-200 after:absolute after:bottom-0 after:left-0 after:h-px after:w-0 after:bg-[#b87fd9] hover:after:w-full after:transition-all after:duration-200 cursor-pointer">
                            Features
                        </button>
                        <button className="relative hover:text-white transition-colors duration-200 after:absolute after:bottom-0 after:left-0 after:h-px after:w-0 after:bg-[#b87fd9] hover:after:w-full after:transition-all after:duration-200 cursor-pointer">
                            Pricing
                        </button>
                        <button className="relative hover:text-white transition-colors duration-200 after:absolute after:bottom-0 after:left-0 after:h-px after:w-0 after:bg-[#b87fd9] hover:after:w-full after:transition-all after:duration-200 cursor-pointer">
                            Docs
                        </button>
                    </div>
                </div>

                {/* Right */}
                <div className="flex items-center gap-4 text-sm">
                    {/* GitHub Stars */}
                    <a
                        href="https://github.com/your-repo"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors duration-200 cursor-pointer"
                    >
                        <FaGithub className="w-5 h-5" />
                        <div className="flex items-center gap-1">
                            <FaStar className="w-3 h-3 text-yellow-400" />
                            <span>1.2K</span>
                        </div>
                    </a>

                    {loading ? null : session ? (
                        <>
                            {/* Purple Dashboard button */}
                            <Link
                                href="/dashboard"
                                className="rounded-xl border border-white/15 bg-[#884ab4] hover:bg-[#9d5fc9] px-4 py-2 font-medium text-white shadow-lg shadow-[#884ab4]/25 transition-all duration-200"
                            >
                                Dashboard
                            </Link>

                            {/* Profile Icon + Dropdown */}
                            <div className="relative" ref={menuRef}>
                                <button
                                    onClick={() => setMenuOpen((v) => !v)}
                                    className="relative flex items-center justify-center hover:scale-105 transition-transform"
                                    aria-label="Open profile menu"
                                >
                                    <div className="h-8 w-8 rounded-full bg-white flex items-center justify-center shadow-lg shadow-black/20">
                                        <FiUser className="w-4 h-4 text-black" />
                                    </div>
                                </button>

                                {menuOpen && (
                                    <div className="absolute right-0 mt-3 w-72 rounded-xl border border-white/10 bg-[#05060C] shadow-2xl shadow-black/60 overflow-hidden">
                                        {/* Email header */}
                                        <div className="px-4 py-3 text-sm font-medium text-gray-100 border-b border-white/5">
                                            {userEmail}
                                        </div>

                                        {/* Account preferences */}
                                        <button className="w-full flex items-center gap-2 px-4 py-3 text-sm text-gray-200 hover:bg-white/5">
                                            <FiSettings className="w-4 h-4 text-gray-400" />
                                            <span>Account preferences</span>
                                        </button>

                                        {/* Feature previews */}
                                        <button className="w-full flex items-center gap-2 px-4 py-3 text-sm text-gray-200 hover:bg-white/5 border-b border-white/5">
                                            <FiZap className="w-4 h-4 text-gray-400" />
                                            <span>Feature previews</span>
                                        </button>

                                        {/* Logout */}
                                        <button
                                            className="w-full flex items-center gap-2 px-4 py-3 text-sm text-gray-200 hover:bg-red-500/10 hover:text-red-300"
                                            onClick={handleLogout}
                                        >
                                            <FiLogOut className="w-4 h-4" />
                                            <span>Log out</span>
                                        </button>
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <>
                            <Link
                                href="/login"
                                className="text-gray-300 hover:text-white transition-colors duration-200 cursor-pointer"
                            >
                                Login
                            </Link>

                            <Link
                                href="/register"
                                className="rounded-xl border border-white/20 bg-[#884ab4] hover:bg-[#9d5fc9] hover:scale-105 hover:shadow-[#884ab4]/40 px-4 py-2 font-medium shadow-lg shadow-[#884ab4]/30 transition-all duration-200 cursor-pointer"
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
