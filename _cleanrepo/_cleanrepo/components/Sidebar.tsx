"use client";

import { useState } from "react";
import { FiLayers, FiFolder, FiDatabase } from "react-icons/fi";

const mockLibraries = [
  {
    id: "lib-1",
    name: "Policy & Compliance",
    buckets: ["HR Policies", "Legal Docs", "Compliance 2024"],
  },
  {
    id: "lib-2",
    name: "Social Streams",
    buckets: ["Twitter - Imran Khan", "Product Mentions", "Customer Feedback"],
  },
];

export default function Sidebar() {
  const [activeLibrary, setActiveLibrary] = useState("lib-1");
  const active = mockLibraries.find((l) => l.id === activeLibrary);

  return (
    <aside className="flex h-full w-72 flex-col border-r border-white/5 bg-surface/80 backdrop-blur-xl shadow-soft">
      <div className="px-4 pt-4 pb-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-2xl bg-gradient-to-tr from-accent-600 to-accent-300 flex items-center justify-center">
            <FiDatabase className="text-white" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-accent-200/70">
              Workspace
            </p>
            <p className="text-sm font-semibold text-gray-100">Synapse Org</p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-gray-400 mb-2">
            <FiLayers className="text-accent-300" />
            Libraries
          </div>
          <div className="space-y-1">
            {mockLibraries.map((lib) => (
              <button
                key={lib.id}
                onClick={() => setActiveLibrary(lib.id)}
                className={`w-full text-left px-3 py-2 rounded-xl text-sm transition-colors ${
                  lib.id === activeLibrary
                    ? "bg-accent-600/70 text-white"
                    : "bg-surfaceAlt/70 hover:bg-surfaceAlt text-gray-300"
                }`}
              >
                {lib.name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-gray-400 mb-2">
            <FiFolder className="text-accent-300" />
            Buckets
          </div>
          <div className="space-y-1">
            {active?.buckets.map((b) => (
              <button
                key={b}
                className="w-full text-left px-3 py-2 rounded-xl text-xs bg-surfaceAlt/60 hover:bg-surfaceAlt text-gray-300"
              >
                {b}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="px-3 py-3 border-t border-white/5 text-xs text-muted">
        <p>
          Connected:{" "}
          <span className="text-accent-200">Lambda GPU Node (stub)</span>
        </p>
      </div>
    </aside>
  );
}
