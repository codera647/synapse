"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FiBox, FiUsers, FiMessageSquare, FiActivity, FiMonitor, FiZap, FiShare2 } from "react-icons/fi";

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
}: {
    onToggleConsole?: () => void;
    consoleOpen?: boolean;
}) {
    const router = useRouter();
    const searchParams = useSearchParams();

    const activeKey = useMemo(() => {
        const tab = (searchParams.get("tab") || "libraries").toLowerCase();
        return tab === "chat" || tab === "agent" || tab === "graph" || tab === "team" || tab === "usage" ? tab : "libraries";
    }, [searchParams]);

    return (
        <aside className="group flex flex-col h-[calc(100vh-3.5rem)] mt-14 fixed left-0 top-0 z-20">
            {/* main rail */}
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
                            onClick={() => {
                                if (item.key === "libraries") router.push("/dashboard");
                                else if (item.key === "chat") router.push("/dashboard?tab=chat");
                                else router.push(`/dashboard?tab=${encodeURIComponent(item.key)}`);
                            }}
                        >
                            {/* active accent bar */}
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
                            consoleOpen
                                ? "border-violet-400/50 bg-violet-500/15 text-violet-200"
                                : "border-white/15"
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
    );
}
