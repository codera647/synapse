"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
    FiChevronDown,
    FiBell,
    FiHelpCircle,
    FiCheck,
    FiPlus,
    FiUser,
    FiLogOut,
    FiZap,
    FiSettings,
} from "react-icons/fi";

interface DashboardNavbarProps {
    orgName: string;
    organizations?: { id: string; name: string }[];
    currentOrgId?: string | null;
    onSelectOrg?: (orgId: string) => void;
    onOpenHardware?: () => void;
    userEmail?: string | null;
    onLogout?: () => void;
}

export default function DashboardNavbar({
    orgName,
    organizations = [],
    currentOrgId = null,
    onSelectOrg,
    onOpenHardware,
    userEmail,
    onLogout,
}: DashboardNavbarProps) {
    const router = useRouter();
    const [openOrgMenu, setOpenOrgMenu] = useState(false);
    const [openProfileMenu, setOpenProfileMenu] = useState(false);

    const orgMenuRef = useRef<HTMLDivElement | null>(null);
    const profileMenuRef = useRef<HTMLDivElement | null>(null);

    const displayName = orgName || "Organization";
    const email = userEmail ?? "user@example.com";

    // 🔥 Close dropdowns when clicking anywhere else
    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            const target = e.target as Node;

            if (orgMenuRef.current && !orgMenuRef.current.contains(target)) {
                setOpenOrgMenu(false);
            }

            if (
                profileMenuRef.current &&
                !profileMenuRef.current.contains(target)
            ) {
                setOpenProfileMenu(false);
            }
        }

        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    return (
        <header className="w-full surface-app border-b border-white/10 flex items-center justify-between px-4 sm:px-6 h-14 relative z-30 backdrop-blur-xl">
            {/* LEFT — Logo + Org selector */}
            <div className="flex items-center gap-3 relative" ref={orgMenuRef}>
                <div className="flex items-center gap-2.5">
                    <Image src="/logo.png" alt="Synapse" width={32} height={32} className="h-8 w-8" />
                    <span className="hidden sm:block text-white/25 text-lg font-light">/</span>

                    <button
                        onClick={() => {
                            setOpenOrgMenu((v) => !v);
                            setOpenProfileMenu(false);
                        }}
                        className="flex items-center gap-1.5 text-sm text-white/90 hover:bg-white/8 px-2.5 py-1.5 rounded-lg transition-all group"
                    >
                        <span className="font-medium max-w-[10rem] truncate">{displayName}</span>
                        <FiChevronDown className={`w-3.5 h-3.5 text-white/40 group-hover:text-white/70 transition-transform ${openOrgMenu ? "rotate-180" : ""}`} />
                    </button>
                </div>

                <span className="text-[10px] font-semibold px-2 py-[3px] rounded-full bg-violet-500/15 text-violet-300 border border-violet-400/20">
                    FREE
                </span>

                {openOrgMenu && (
                    <div className="absolute top-12 left-0 w-72 rounded-2xl surface-menu overflow-hidden z-[60]">
                        <div className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-wide text-white/35">
                            Organizations & teams
                        </div>
                        <div className="max-h-64 overflow-auto synapse-scroll p-1.5 pt-0.5">
                            {organizations.length === 0 ? (
                                <div className="px-3 py-2.5 text-xs text-white/40">No organizations found.</div>
                            ) : (
                                organizations.map((org) => (
                                    <button
                                        key={org.id}
                                        className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-colors ${
                                            org.id === currentOrgId ? "bg-white/8 text-white/90" : "text-white/65 hover:bg-white/8"
                                        }`}
                                        onClick={() => {
                                            if (org.id !== currentOrgId) onSelectOrg?.(org.id);
                                            setOpenOrgMenu(false);
                                        }}
                                    >
                                        <span className="truncate">{org.name}</span>
                                        {org.id === currentOrgId && <FiCheck className="w-4 h-4 text-violet-300 shrink-0" />}
                                    </button>
                                ))
                            )}
                        </div>
                        <div className="h-px bg-white/8" />
                        <div className="p-1.5">
                            <button
                                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-white/80 hover:bg-white/8 transition-colors"
                                onClick={() => {
                                    setOpenOrgMenu(false);
                                    router.push("/new-organization");
                                }}
                            >
                                <FiPlus className="w-4 h-4" />
                                <span>New organization</span>
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* RIGHT — PROFILE */}
            <div className="flex items-center gap-1.5 sm:gap-2 relative" ref={profileMenuRef}>
                <button className="grid place-items-center h-9 w-9 rounded-lg text-white/50 hover:text-white hover:bg-white/8 transition-colors">
                    <FiHelpCircle className="w-4 h-4" />
                </button>
                <button className="grid place-items-center h-9 w-9 rounded-lg text-white/50 hover:text-white hover:bg-white/8 transition-colors">
                    <FiBell className="w-4 h-4" />
                </button>

                <button
                    onClick={() => {
                        setOpenProfileMenu((v) => !v);
                        setOpenOrgMenu(false);
                    }}
                    className="ml-1 flex items-center justify-center hover:scale-105 transition-transform"
                >
                    <div className="h-8 w-8 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center ring-1 ring-white/20">
                        <FiUser className="w-4 h-4 text-white" />
                    </div>
                </button>

                {openProfileMenu && (
                    <div className="absolute right-0 top-12 w-72 rounded-2xl surface-menu overflow-hidden z-[60]">
                        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-white/10">
                            <div className="h-9 w-9 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center ring-1 ring-white/20 shrink-0">
                                <FiUser className="w-4 h-4 text-white" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-xs text-white/40">Signed in as</p>
                                <p className="text-sm font-medium text-white/90 truncate">{email}</p>
                            </div>
                        </div>
                        <div className="p-1.5">
                            <button className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-white/80 hover:bg-white/8 transition-colors">
                                <FiSettings className="w-4 h-4 text-white/50" />
                                <span>Account preferences</span>
                            </button>
                            <button
                                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-white/80 hover:bg-white/8 transition-colors"
                                onClick={() => {
                                    setOpenProfileMenu(false);
                                    onOpenHardware?.();
                                }}
                            >
                                <FiZap className="w-4 h-4 text-white/50" />
                                <span>GPU Capabilities</span>
                            </button>
                            <div className="my-1 h-px bg-white/8" />
                            <button
                                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-rose-300/90 hover:bg-rose-500/12 transition-colors"
                                onClick={onLogout}
                            >
                                <FiLogOut className="w-4 h-4" />
                                <span>Log out</span>
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </header>
    );
}
