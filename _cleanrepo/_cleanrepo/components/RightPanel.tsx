"use client";

import { FiBarChart2 } from "react-icons/fi";

export default function RightPanel() {
  return (
    <aside className="hidden xl:flex h-full w-80 flex-col border-l border-white/5 bg-surface/80 backdrop-blur-xl shadow-soft">
      <div className="px-4 pt-4 pb-3 border-b border-white/5 flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-accent-200/80">
            Analytics
          </p>
          <p className="text-sm font-semibold text-gray-100">
            Graphs & Dashboards
          </p>
        </div>
        <FiBarChart2 className="text-accent-300" />
      </div>

      <div className="flex-1 px-4 py-4 text-xs text-gray-400 space-y-3">
        <p className="text-gray-300">This panel will visualize:</p>
        <ul className="list-disc list-inside space-y-1">
          <li>Query-driven charts (bar, line, pie)</li>
          <li>Time-series trends from your data</li>
          <li>Generated dashboards / exports</li>
        </ul>
        <p className="text-gray-500">
          For now it’s a placeholder. Once the backend is wired, this will render
          real chart configs from Synapse’s analytics engine.
        </p>
      </div>
    </aside>
  );
}
