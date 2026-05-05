"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FiBox, FiUsers, FiMessageSquare, FiActivity, FiMonitor } from "react-icons/fi";

const menuItems = [
    { key: "libraries", label: "Libraries", icon: FiBox },
    { key: "chat", label: "Chat", icon: FiMessageSquare },
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
        return tab === "chat" ? "chat" : "libraries";
    }, [searchParams]);

    return (
        <aside
            className="group flex flex-col h-[calc(100vh-56px)] mt-14 fixed left-0 top-0 z-10"
            style={{ backgroundColor: "var(--bg-secondary)" }}
        >
            {/* main rail */}
            <div className="flex-1 flex flex-col px-2 pt-4 pb-4 w-14 group-hover:w-56 transition-[width] duration-200 ease-out border-r border-white/10">
                {menuItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = item.key === activeKey;

                    return (
                        <button
                            key={item.key}
                            className={`flex items-center gap-3 rounded-xl px-2 py-2 mb-1 text-sm
                ${isActive
                                    ? "bg-white/10 text-gray-100"
                                    : "text-gray-400 hover:text-gray-100 hover:bg-white/5"
                                } transition-colors`}
                            onClick={() => {
                                if (item.key === "libraries") router.push("/dashboard");
                                else if (item.key === "chat") router.push("/dashboard?tab=chat");
                                else router.push(`/dashboard?tab=${encodeURIComponent(item.key)}`);
                            }}
                        >
                            <div className="h-8 w-8 flex items-center justify-center">
                                <Icon className="w-4 h-4" />
                            </div>

                            {/* label shows only when expanded */}
                            <span className="whitespace-nowrap opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-150">
                                {item.label}
                            </span>
                        </button>
                    );
                })}

                {/* spacer */}
                <div className="flex-1" />

                {/* bottom small button – like Supabase little square icon */}
                <button
                    type="button"
                    onClick={onToggleConsole}
                    className="mb-1 flex items-center gap-3 rounded-xl px-2 py-2 text-xs text-gray-500 hover:text-gray-200 hover:bg-white/5 transition-colors"
                >
                    <div
                        className={`h-7 w-7 flex items-center justify-center rounded-md border transition-colors ${consoleOpen
                            ? "border-[#b87fd9]/60 bg-[#884ab4]/15 text-[#f7ecff]"
                            : "border-white/20"
                            }`}
                    >
                        <FiMonitor className="w-3.5 h-3.5" />
                    </div>
                    <span className="whitespace-nowrap opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-150">
                        Console
                    </span>
                </button>
            </div>
        </aside>
    );
}
