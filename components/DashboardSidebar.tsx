"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FiBox, FiUsers, FiMessageSquare, FiActivity, FiMonitor, FiZap, FiShare2, FiX } from "react-icons/fi";

const menuItems = [
    { key: "libraries", label: "Libraries", icon: FiBox },
    { key: "chat", label: "Chat", icon: FiMessageSquare },
    { key: "agent", label: "Agent", icon: FiZap },
    { key: "graph", label: "Graph", icon: FiShare2 },
    { key: "team", label: "Team", icon: FiUsers },
    { key: "usage", label: "Usage", icon: FiActivity },
];

export default function DashboardSidebar({
    onToggleConsole,
    consoleOpen,
    mobileOpen = false,
    onMobileClose,
}: {
    onToggleConsole?: () => void;
    consoleOpen?: boolean;
    mobileOpen?: boolean;
    onMobileClose?: () => void;
}) {
    const router = useRouter();
    const searchParams = useSearchParams();

    const activeKey = useMemo(() => {
        const tab = (searchParams.get("tab") || "libraries").toLowerCase();
        return tab === "chat" || tab === "agent" || tab === "graph" || tab === "team" || tab === "usage" ? tab : "libraries";
    }, [searchParams]);

    const go = (key: string) => {
        if (key === "libraries") router.push("/dashboard");
        else if (key === "chat") router.push("/dashboard?tab=chat");
        else router.push(`/dashboard?tab=${encodeURIComponent(key)}`);
        onMobileClose?.();
    };

    return (
        <>
            {/* ===== Desktop rail (md+): icon-only, expands on hover ===== */}
            <aside className="group hidden md:flex flex-col h-[calc(100vh-3.5rem)] mt-14 fixed left-0 top-0 z-20">
                <div className="flex-1 flex flex-col gap-1 px-2.5 pt-4 pb-4 w-16 group-hover:w-60 transition-[width] duration-300 ease-out border-r border-white/10 surface-app backdrop-blur-xl overflow-hidden">
                    {menuItems.map((item) => {
                        const Icon = item.icon;
                        const isActive = item.key === activeKey;
                        return (
                            <button
                                key={item.key}
                                title={item.label}
                                className={`relative flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-sm transition-all ${
                                    isActive
                                        ? "text-white bg-gradient-to-r from-violet-500/20 to-fuchsia-500/10"
                                        : "text-white/55 hover:text-white hover:bg-white/8"
                                }`}
                                onClick={() => go(item.key)}
                            >
                                {isActive && (
                                    <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r-full bg-gradient-to-b from-violet-400 to-fuchsia-400" />
                                )}
                                <div className="h-8 w-8 flex items-center justify-center shrink-0">
                                    <Icon className="w-[18px] h-[18px]" />
                                </div>
                                <span className="whitespace-nowrap opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-200 font-medium">
                                    {item.label}
                                </span>
                            </button>
                        );
                    })}

                    <div className="flex-1" />

                    <button
                        type="button"
                        onClick={onToggleConsole}
                        title="Console"
                        className="flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-sm text-white/50 hover:text-white hover:bg-white/8 transition-colors"
                    >
                        <div
                            className={`h-8 w-8 flex items-center justify-center rounded-lg border transition-colors shrink-0 ${
                                consoleOpen ? "border-violet-400/50 bg-violet-500/15 text-violet-200" : "border-white/15"
                            }`}
                        >
                            <FiMonitor className="w-4 h-4" />
                        </div>
                        <span className="whitespace-nowrap opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-200 font-medium">
                            Console
                        </span>
                    </button>
                </div>
            </aside>

            {/* ===== Mobile drawer (below md): full labels, slide-in over backdrop ===== */}
            <div className={`md:hidden fixed inset-0 z-50 ${mobileOpen ? "" : "pointer-events-none"}`}>
                {/* backdrop */}
                <div
                    className={`absolute inset-0 bg-black/60 backdrop-blur-[2px] transition-opacity duration-200 ${
                        mobileOpen ? "opacity-100" : "opacity-0"
                    }`}
                    onClick={onMobileClose}
                    aria-hidden
                />
                <aside
                    className={`absolute left-0 top-0 h-full w-64 max-w-[82vw] flex flex-col border-r border-white/10 surface-app backdrop-blur-xl transition-transform duration-300 ease-out ${
                        mobileOpen ? "translate-x-0" : "-translate-x-full"
                    }`}
                >
                    <div className="flex items-center justify-between px-4 h-14 border-b border-white/10">
                        <span className="text-sm font-semibold text-white/80">Menu</span>
                        <button
                            onClick={onMobileClose}
                            className="grid place-items-center h-9 w-9 rounded-lg text-white/50 hover:text-white hover:bg-white/8"
                            aria-label="Close menu"
                        >
                            <FiX className="w-5 h-5" />
                        </button>
                    </div>
                    <div className="flex-1 flex flex-col gap-1 p-3 overflow-y-auto">
                        {menuItems.map((item) => {
                            const Icon = item.icon;
                            const isActive = item.key === activeKey;
                            return (
                                <button
                                    key={item.key}
                                    className={`relative flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition-all ${
                                        isActive
                                            ? "text-white bg-gradient-to-r from-violet-500/20 to-fuchsia-500/10"
                                            : "text-white/65 hover:text-white hover:bg-white/8"
                                    }`}
                                    onClick={() => go(item.key)}
                                >
                                    {isActive && (
                                        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r-full bg-gradient-to-b from-violet-400 to-fuchsia-400" />
                                    )}
                                    <Icon className="w-[18px] h-[18px] shrink-0" />
                                    <span className="font-medium">{item.label}</span>
                                </button>
                            );
                        })}

                        <div className="my-2 h-px bg-white/8" />

                        <button
                            type="button"
                            onClick={() => {
                                onToggleConsole?.();
                                onMobileClose?.();
                            }}
                            className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-white/65 hover:text-white hover:bg-white/8 transition-colors"
                        >
                            <span
                                className={`h-8 w-8 flex items-center justify-center rounded-lg border transition-colors shrink-0 ${
                                    consoleOpen ? "border-violet-400/50 bg-violet-500/15 text-violet-200" : "border-white/15"
                                }`}
                            >
                                <FiMonitor className="w-4 h-4" />
                            </span>
                            <span className="font-medium">Console</span>
                        </button>
                    </div>
                </aside>
            </div>
        </>
    );
}
