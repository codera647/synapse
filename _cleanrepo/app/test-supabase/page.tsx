// app/test-supabase/page.tsx
"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";

type Org = {
    id: string;
    name: string;
    created_at: string | null;
};

export default function TestSupabasePage() {
    const [orgs, setOrgs] = useState<Org[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const load = async () => {
            const { data, error } = await createSupabaseBrowserClient()
                .from("organizations")
                .select("*")
                .limit(10);

            if (error) {
                console.error(error);
                setError(error.message);
            } else {
                setOrgs(data || []);
            }
        };

        load();
    }, []);

    return (
        <div className="min-h-screen bg-black text-white p-8">
            <h1 className="text-2xl font-bold mb-4">Supabase Connection Test</h1>
            {error && <p className="text-red-400">Error: {error}</p>}
            <ul className="space-y-2">
                {orgs.map((org) => (
                    <li key={org.id} className="border border-white/10 rounded-lg p-3">
                        <div className="font-semibold">{org.name}</div>
                        <div className="text-xs text-gray-400">{org.created_at}</div>
                    </li>
                ))}
            </ul>
        </div>
    );
}
