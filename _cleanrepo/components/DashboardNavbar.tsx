"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
    FiChevronDown,
    FiBell,
    FiHelpCircle,
    FiSearch,
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
    const [showAllOrgs, setShowAllOrgs] = useState(false);

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
        <header
            className="w-full border-b border-white/10 flex items-center justify-between px-6 h-14 relative z-20"
            style={{ backgroundColor: "var(--bg-secondary)" }}
        >
            {/* LEFT — Logo + Org selector */}
            <div className="flex items-center gap-3 relative" ref={orgMenuRef}>
                <div className="flex items-center gap-3">
                    <Image
                        src="/logo.png"
                        alt="Synapse logo"
                        width={36}
                        height={36}
                        className="rounded-md"
                    />

                    <span className="text-gray-500 text-lg">/</span>

                    <button
                        onClick={() => {
                            setOpenOrgMenu((v) => !v);
                            setOpenProfileMenu(false);
                        }}
                        className="flex items-center gap-1 text-sm text-gray-100 hover:bg-white/5 px-2 py-1 rounded-lg transition-all group"
                    >
                        <span className="font-medium">{displayName}</span>
                        <FiChevronDown className="w-3 h-3 text-gray-400 group-hover:text-gray-200 transition-colors" />
                    </button>
                </div>

                <span className="text-[10px] px-2 py-[3px] rounded-full bg-gray-700/50 text-gray-300">
                    FREE
                </span>

                {openOrgMenu && (
                    <div className="absolute top-10 left-0 w-72 rounded-xl border border-white/10 bg-[#05060C] shadow-2xl shadow-black/60 overflow-hidden">
                        <div className="flex items-center px-3 py-2 bg-black/40 border-b border-white/5">
                            <FiSearch className="w-4 h-4 text-gray-500 mr-2" />
                            <input
                                placeholder="Find organization..."
                                className="bg-transparent outline-none border-none text-xs text-gray-100 placeholder:text-gray-500 w-full"
                            />
                        </div>

                        <button className="w-full flex items-center justify-between px-4 py-3 text-sm bg-white/5 text-gray-100">
                            <span>{displayName}</span>
                            <FiCheck className="w-4 h-4 text-[#b87fd9]" />
                        </button>

                        <button
                            className="w-full text-left px-4 py-3 text-sm text-gray-300 hover:bg-white/5"
                            onClick={() => setShowAllOrgs((v) => !v)}
                        >
                            All organizations
                        </button>

                        {showAllOrgs && (
                            <div className="border-t border-white/5">
                                {organizations.length === 0 ? (
                                    <div className="px-4 py-3 text-xs text-gray-500">
                                        No organizations found.
                                    </div>
                                ) : (
                                    organizations.map((org) => (
                                        <button
                                            key={org.id}
                                            className={`w-full flex items-center justify-between px-4 py-2 text-sm ${
                                                org.id === currentOrgId
                                                    ? "text-gray-100 bg-white/5"
                                                    : "text-gray-300"
                                            }`}
                                            onClick={() => {
                                                if (org.id !== currentOrgId) {
                                                    onSelectOrg?.(org.id);
                                                }
                                                setOpenOrgMenu(false);
                                                setShowAllOrgs(false);
                                            }}
                                        >
                                            <span>{org.name}</span>
                                            {org.id === currentOrgId && (
                                                <FiCheck className="w-4 h-4 text-[#b87fd9]" />
                                            )}
                                        </button>
                                    ))
                                )}
                            </div>
                        )}

                        <button
                            className="w-full flex items-center gap-2 px-4 py-3 text-sm text-gray-200 hover:bg-white/5 border-t border-white/5"
                            onClick={() => {
                                setOpenOrgMenu(false);
                                setShowAllOrgs(false);
                                router.push("/new-organization");
                            }}
                        >
                            <FiPlus className="w-4 h-4" />
                            <span>New organization</span>
                        </button>
                    </div>
                )}
            </div>

            {/* RIGHT — PROFILE */}
            <div className="flex items-center gap-4 relative" ref={profileMenuRef}>
                <button className="text-gray-400 hover:text-gray-200">
                    <FiHelpCircle className="w-4 h-4" />
                </button>

                <button className="text-gray-400 hover:text-gray-200">
                    <FiBell className="w-4 h-4" />
                </button>

                <button
                    onClick={() => {
                        setOpenProfileMenu((v) => !v);
                        setOpenOrgMenu(false);
                    }}
                    className="relative flex items-center justify-center hover:scale-105 transition-transform"
                >
                    <div className="h-8 w-8 rounded-full bg-white flex items-center justify-center shadow-lg shadow-black/20">
                        <FiUser className="w-4 h-4 text-black" />
                    </div>
                </button>

                {openProfileMenu && (
                    <div className="absolute right-0 top-10 w-72 rounded-xl border border-white/10 bg-[#05060C] shadow-2xl shadow-black/60 overflow-hidden">
                        <div className="px-4 py-3 text-sm font-medium text-gray-100 border-b border-white/5">
                            {email}
                        </div>

                        <button className="w-full flex items-center gap-2 px-4 py-3 text-sm text-gray-200 hover:bg-white/5">
                            <FiSettings className="w-4 h-4 text-gray-400" />
                            <span>Account preferences</span>
                        </button>

                        <button
                            className="w-full flex items-center gap-2 px-4 py-3 text-sm text-gray-200 hover:bg-white/5 border-b border-white/5"
                            onClick={() => {
                                setOpenProfileMenu(false);
                                onOpenHardware?.();
                            }}
                        >
                            <FiZap className="w-4 h-4 text-gray-400" />
                            <span>GPU Capabilities</span>
                        </button>

                        <button
                            className="w-full flex items-center gap-2 px-4 py-3 text-sm text-gray-200 hover:bg-red-500/10 hover:text-red-300"
                            onClick={onLogout}
                        >
                            <FiLogOut className="w-4 h-4" />
                            <span>Log out</span>
                        </button>
                    </div>
                )}
            </div>
        </header>
    );
}
