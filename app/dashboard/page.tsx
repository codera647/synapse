"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabaseClient";
import { openGoogleDriveFolderPicker } from "@/lib/googleDrivePicker";
import DashboardNavbar from "@/components/DashboardNavbar";
import { FiGrid, FiList, FiSearch, FiFilter, FiPlus } from "react-icons/fi";
import DashboardSidebar from "@/components/DashboardSidebar";
import Loader from "@/components/Loader";
import LogPanel from "@/components/LogPanel";
import { LogProvider, useLog } from "@/context/LogContext";
import LibraryDrawer from "@/components/LibraryDrawer";
import ChatWorkspace from "@/components/ChatWorkspace";
import TeamWorkspace from "@/components/TeamWorkspace";
import SettingsModal, { type Personalization } from "@/components/SettingsModal";

type Library = {
    id: string;
    name: string;
    status: string;
    created_at: string | null;
    updated_at?: string | null;
    source_type?: string | null;
    pipeline_status?: string | null;
    pipeline_stage?: string | null;
    pipeline_progress_percent?: number | null;
    pipeline_error?: string | null;
    total_batches?: number | null;
    completed_batches?: number | null;
};

type Organization = {
    id: string;
    name: string;
    slug: string | null;
};

type HardwareInfo = {
    cpu?: number;
    ram_gb?: number;
    vram_gb?: number;
    gpu?: string | null;
    sync_workers?: number;
    extract_workers?: number;
    embed_workers?: number;
};

export default function DashboardPage() {
    return (
        <Suspense fallback={null}>
            <LogProvider>
                <DashboardPageInner />
            </LogProvider>
        </Suspense>
    );
}

function DashboardPageInner() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const supabase = createSupabaseBrowserClient();
    const { addLog, isOpen: consoleOpen, toggle: toggleConsole, clear: clearLogs, logs } = useLog();
    const stageStateRef = useRef<Map<string, Map<string, string>>>(new Map());

    const [userEmail, setUserEmail] = useState<string | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
    const [personalization, setPersonalization] = useState<Personalization | null>(null);
    const [currentOrg, setCurrentOrg] = useState<Organization | null>(null);
    const [organizations, setOrganizations] = useState<Organization[]>([]);
    const [libraries, setLibraries] = useState<Library[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [view, setView] = useState<"grid" | "list">("grid");
    const [createLibraryOpen, setCreateLibraryOpen] = useState(false);
    const [createLibraryClosing, setCreateLibraryClosing] = useState(false);
    const [newLibraryName, setNewLibraryName] = useState("");
    const [newLibrarySourceFolder, setNewLibrarySourceFolder] = useState("");
    const [newLibrarySourceFolderName, setNewLibrarySourceFolderName] = useState("");
    const [createLibraryLoading, setCreateLibraryLoading] = useState(false);
    const [createLibraryError, setCreateLibraryError] = useState<string | null>(null);
    const [activeLibrary, setActiveLibrary] = useState<Library | null>(null);
    const [syncLoading, setSyncLoading] = useState(false);
    const [syncError, setSyncError] = useState<string | null>(null);
    const [syncSuccess, setSyncSuccess] = useState<string | null>(null);
    const [syncingLibraryIds, setSyncingLibraryIds] = useState<Set<string>>(new Set());
    const [cancelingLibraryIds, setCancelingLibraryIds] = useState<Set<string>>(new Set());
    const [startingLibraryIds, setStartingLibraryIds] = useState<Set<string>>(new Set());
    const [resumingLibraryIds, setResumingLibraryIds] = useState<Set<string>>(new Set());
    const [deleteLoading, setDeleteLoading] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [activeLibraryDocs, setActiveLibraryDocs] = useState<number | null>(null);
    const [activeLibraryLastSync, setActiveLibraryLastSync] = useState<string | null>(null);
    const [hardwareInfo, setHardwareInfo] = useState<HardwareInfo | null>(null);
    const [hardwareError, setHardwareError] = useState<string | null>(null);
    const [hardwareOpen, setHardwareOpen] = useState(false);

    const activeTab = (searchParams.get("tab") || "libraries").toLowerCase();
    const [driveNotice, setDriveNotice] = useState<string | null>(null);
    const [drawerLibrary, setDrawerLibrary] = useState<Library | null>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);

    const readJsonResponse = async (response: Response) => {
        const text = await response.text();
        if (!text) {
            return { data: null, text: "" };
        }
        try {
            return { data: JSON.parse(text), text };
        } catch {
            return { data: null, text };
        }
    };

    useEffect(() => {
        const load = async () => {
            setLoading(true);

            // Get current user
            const { data: { user }, error: userError } = await supabase.auth.getUser();

            if (userError || !user) {
                console.error("Not authenticated");
                router.push("/login");
                return;
            }

            setUserEmail(user.email ?? null);

            // Load profile avatar + personalization (used by the navbar + to personalize chat).
            // Via the server route so it doesn't depend on user_preferences RLS.
            void (async () => {
                try {
                    const { data: { session } } = await supabase.auth.getSession();
                    const token = session?.access_token;
                    if (!token) return;
                    const res = await fetch("/api/user/preferences", {
                        headers: { authorization: `Bearer ${token}` },
                        cache: "no-store",
                    });
                    if (!res.ok) return;
                    const d = (await res.json()) as { avatar_url?: string | null; prefs?: Personalization | null };
                    setAvatarUrl(d.avatar_url ?? null);
                    if (d.prefs) setPersonalization(d.prefs);
                } catch {
                    /* non-fatal */
                }
            })();

            // Fetch user's organization memberships
            const { data: memberships, error: memberError } = await supabase
                .from("organization_members")
                .select("organization_id, role, organizations(id, name, slug)")
                .eq("user_id", user.id);

            if (memberError) {
                console.error("Error fetching memberships:", memberError);
            }

            // Check if user has any orgs
            if (!memberships || memberships.length === 0) {
                // No organizations - will show create prompt
                setCurrentOrg(null);
                setOrganizations([]);
                setLoading(false);
                return;
            }

            // Dashboard shows only the orgs you OWN — teams you were merely invited to live in the
            // Team tab / team chat, not the dashboard org switcher.
            const ownedOrgs = memberships
                .filter((m) => String((m as { role?: unknown }).role || "") === "owner")
                .map((m) => m.organizations as unknown as Organization)
                .filter(Boolean);
            const orgList =
                ownedOrgs.length > 0
                    ? ownedOrgs
                    : memberships.map((m) => m.organizations as unknown as Organization).filter(Boolean);

            setOrganizations(orgList);
            const orgData = orgList[0];
            setCurrentOrg(orgData);

            const { data: libs, error: libError } = await supabase
                .from("libraries")
                .select("id, name, status, created_at, updated_at, source_type, pipeline_status, pipeline_stage, pipeline_progress_percent, pipeline_error, total_batches, completed_batches")
                .eq("organization_id", orgData.id)
                .order("created_at", { ascending: false });

            if (libError) {
                console.error("Error fetching libraries:", libError);
            } else {
                setLibraries(libs || []);
            }

            setLoading(false);
        };

        load();
    }, [supabase, router]);

    useEffect(() => {
        const fetchHardware = async () => {
            try {
                const response = await fetch("/api/backend/hardware", {
                    cache: "no-store",
                });
                const { data } = await readJsonResponse(response);
                if (!response.ok) {
                    setHardwareError(
                        data?.error || "Unable to load hardware info from the backend."
                    );
                    return;
                }
                if (!data) {
                    setHardwareError("Received an invalid response from the backend.");
                    return;
                }
                setHardwareInfo(data as HardwareInfo);
            } catch (err) {
                console.error("Hardware info error:", err);
                setHardwareError("Unable to reach backend. Check your network connection.");
            }
        };

        fetchHardware();
    }, []);

    useEffect(() => {
        const drive = searchParams.get("drive");
        const reason = searchParams.get("reason");

        if (drive === "connected") {
            setDriveNotice("Google Drive connected. You can sync this library now.");
        } else if (drive === "queued") {
            setDriveNotice("Google Drive connected. Sync job queued.");
        } else if (drive === "error") {
            setDriveNotice(
                reason ? `Google Drive error: ${reason}` : "Google Drive connection failed."
            );
        }
    }, [searchParams]);

    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearch(search.trim().toLowerCase());
        }, 300);

        return () => clearTimeout(timer);
    }, [search]);

    const handleSelectOrg = async (orgId: string) => {
        const selectedOrg = organizations.find((org) => org.id === orgId) || null;
        setCurrentOrg(selectedOrg);
        setLoading(true);

        const { data: libs, error: libError } = await supabase
            .from("libraries")
            .select("id, name, status, created_at, updated_at, source_type, pipeline_status, pipeline_stage, pipeline_progress_percent, pipeline_error, total_batches, completed_batches")
            .eq("organization_id", orgId)
            .order("created_at", { ascending: false });

        if (libError) {
            console.error("Error fetching libraries:", libError);
        } else {
            setLibraries(libs || []);
        }

        setLoading(false);
    };

    const openCreateLibrary = () => {
        setCreateLibraryOpen(true);
        setCreateLibraryClosing(false);
    };

    const closeCreateLibrary = () => {
        setCreateLibraryClosing(true);
        setTimeout(() => {
            setCreateLibraryOpen(false);
            setCreateLibraryClosing(false);
        }, 180);
        setNewLibraryName("");
        setNewLibrarySourceFolder("");
        setNewLibrarySourceFolderName("");
        setCreateLibraryError(null);
        setCreateLibraryLoading(false);
    };

    const handleCreateLibrary = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!currentOrg) {
            setCreateLibraryError("Please select an organization first.");
            return;
        }

        if (!newLibraryName.trim() || !newLibrarySourceFolder.trim()) {
            setCreateLibraryError("Library name and folder are required.");
            return;
        }

        setCreateLibraryLoading(true);
        setCreateLibraryError(null);

        // Record the owner so libraries can be (explicitly) shared into teams later.
        const { data: ownerRes } = await supabase.auth.getUser();
        const ownerUserId = ownerRes?.user?.id ?? null;

        const { data, error } = await supabase
            .from("libraries")
            .insert({
                organization_id: currentOrg.id,
                created_by_user_id: ownerUserId,
                name: newLibraryName.trim(),
                source_type: "google_drive",
                source_folder_id: newLibrarySourceFolder.trim(),
            })
            .select("id, name, status, created_at, updated_at, source_type, pipeline_status, pipeline_stage, pipeline_progress_percent, pipeline_error, total_batches, completed_batches")
            .single();

        if (error) {
            console.error("Error creating library:", error);
            setCreateLibraryError(error.message);
            setCreateLibraryLoading(false);
            return;
        }

        if (data) {
            setLibraries((prev) => [data as Library, ...prev]);
        }

        setCreateLibraryLoading(false);
        closeCreateLibrary();
    };

    const handlePickDriveFolder = async () => {
        try {
            await openGoogleDriveFolderPicker((id, name) => {
                setNewLibrarySourceFolder(id);
                setNewLibrarySourceFolderName(name);
                if (!newLibraryName.trim()) {
                    setNewLibraryName(name);
                }
            });
        } catch (err) {
            console.error("Google Drive picker error:", err);
        }
    };

    const closeLibraryDetails = () => {
        setActiveLibrary(null);
        setSyncError(null);
        setSyncSuccess(null);
        setDeleteLoading(false);
        setDeleteError(null);
        setActiveLibraryDocs(null);
        setActiveLibraryLastSync(null);
    };

    const handleSyncLibrary = async (libraryOverride?: Library) => {
        const targetLibrary = libraryOverride ?? activeLibrary;
        if (!targetLibrary || !currentOrg) {
            setSyncError("Please select a library and organization.");
            return;
        }

        setStartingLibraryIds((prev) => new Set(prev).add(targetLibrary.id));
        setSyncError(null);
        setSyncSuccess(null);

        try {
            const response = await fetch("/api/library-sync/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    library_id: targetLibrary.id,
                    organization_id: currentOrg.id,
                }),
            });

            const { data: payload } = await readJsonResponse(response);

            if (!response.ok) {
                setSyncError(payload?.error || "Failed to queue sync job.");
                setSyncLoading(false);
                return;
            }

            if (!payload) {
                setSyncError("Received an invalid response from the server.");
                setSyncLoading(false);
                return;
            }

            if (payload?.requires_auth && payload?.auth_url) {
                window.location.href = payload.auth_url;
                return;
            }

            setSyncSuccess("Preprocessing queued.");
            startLibraryStatusPolling(targetLibrary.id);
        } catch (err) {
            console.error("Sync job error:", err);
            setSyncError("Unable to reach preprocessing service.");
        } finally {
            setStartingLibraryIds((prev) => {
                const next = new Set(prev);
                next.delete(targetLibrary.id);
                return next;
            });
        }
    };

    const handleResumeLibrary = async (libraryOverride?: Library) => {
        const targetLibrary = libraryOverride ?? activeLibrary;
        if (!targetLibrary || !currentOrg) {
            setSyncError("Please select a library and organization.");
            return;
        }

        setResumingLibraryIds((prev) => new Set(prev).add(targetLibrary.id));
        setSyncError(null);
        setSyncSuccess(null);

        try {
            const response = await fetch("/api/library-sync/resume", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    library_id: targetLibrary.id,
                    organization_id: currentOrg.id,
                }),
            });

            const { data: payload, text } = await readJsonResponse(response);

            if (!response.ok) {
                const hint =
                    typeof text === "string" && text.trim().length > 0 && !payload
                        ? ` (HTTP ${response.status})`
                        : "";
                setSyncError(payload?.error || `Failed to resume preprocessing.${hint}`);
                return;
            }

            setSyncSuccess("Resumed preprocessing.");
            startLibraryStatusPolling(targetLibrary.id);
        } catch (err) {
            console.error("Resume job error:", err);
            setSyncError("Unable to reach preprocessing service.");
        } finally {
            setResumingLibraryIds((prev) => {
                const next = new Set(prev);
                next.delete(targetLibrary.id);
                return next;
            });
        }
    };

    const handleCancelProcessing = async (libraryOverride?: Library) => {
        const targetLibrary = libraryOverride ?? activeLibrary;
        if (!targetLibrary || !currentOrg) {
            setSyncError("Please select a library and organization.");
            return;
        }

        setCancelingLibraryIds((prev) => new Set(prev).add(targetLibrary.id));
        setSyncError(null);
        setSyncSuccess(null);

        try {
            const response = await fetch("/api/library-sync/cancel", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    library_id: targetLibrary.id,
                    organization_id: currentOrg.id,
                }),
            });

            const { data: payload, text } = await readJsonResponse(response);
            if (!response.ok) {
                const hint =
                    typeof text === "string" && text.trim().length > 0 && !payload
                        ? ` (HTTP ${response.status})`
                        : "";
                setSyncError(payload?.error || `Failed to cancel processing.${hint}`);
                return;
            }

            setSyncSuccess("Processing canceled. You can resume later.");
            startLibraryStatusPolling(targetLibrary.id);
        } catch (err) {
            console.error("Cancel job error:", err);
            setSyncError("Unable to reach preprocessing service.");
        } finally {
            setCancelingLibraryIds((prev) => {
                const next = new Set(prev);
                next.delete(targetLibrary.id);
                return next;
            });
        }
    };

    const openDrawer = (lib: Library) => {
        setDrawerLibrary(lib);
        setDrawerOpen(true);
        // Make it feel responsive: also open the console if we're in a failure state.
        const st = getPipelineStatus(lib);
        if ((st === "failed" || st === "error") && !consoleOpen) toggleConsole();
    };

    const startLibraryStatusPolling = useCallback((libraryId: string) => {
        setSyncingLibraryIds((prev) => new Set(prev).add(libraryId));

        const interval = setInterval(async () => {
            const [{ data, error }, stageRows] = await Promise.all([
                supabase
                    .from("libraries")
                    .select(
                        "status, last_synced_at, pipeline_status, pipeline_stage, pipeline_progress_percent, pipeline_error, total_batches, completed_batches"
                    )
                    .eq("id", libraryId)
                    .single(),
                supabase
                    .from("batch_stage_jobs")
                    .select("id, batch_id, stage, status, attempts, assigned_worker, last_error, progress_current, progress_total, updated_at")
                    .eq("library_id", libraryId)
                    .limit(5000),
            ]);

            if (error || !data) {
                clearInterval(interval);
                setSyncingLibraryIds((prev) => {
                    const next = new Set(prev);
                    next.delete(libraryId);
                    return next;
                });
                return;
            }

            const totalBatches =
                typeof data.total_batches === "number" ? data.total_batches : 0;
            const hasStageRows = !stageRows.error;
            const rows = (hasStageRows ? stageRows.data : []) as Array<{
                id: string;
                batch_id: string | null;
                stage: string | null;
                status: string | null;
                attempts: number | null;
                assigned_worker: string | null;
                last_error: string | null;
                progress_current: number | null;
                progress_total: number | null;
                updated_at: string | null;
            }>;

            // Enforce the "fully processed" definition:
            // Ready/100% ONLY when a library reached the final stage (embedding).
            const requiredStages = [
                "sync",
                "layout_parser",
                "text_extraction",
                "image_captioning",
                "chunking",
                "embedding",
            ] as const;
            const requiredStageSet = new Set<string>(requiredStages as readonly string[]);

            const stageDoneCounts = new Map<string, number>();
            const stageAllCounts = new Map<string, number>();
            // If stage rows failed to load, keep polling and do NOT trust "completed" from libraries table.
            let remainingCount = hasStageRows ? 0 : 1;
            for (const r of rows) {
                const st = String(r.stage ?? "");
                const status = String(r.status ?? "");
                if (!st) continue;
                // Ignore stages we aren't using (e.g. legacy "clustering" jobs from older runs).
                if (!requiredStageSet.has(st)) continue;
                stageAllCounts.set(st, (stageAllCounts.get(st) ?? 0) + 1);
                if (status === "done") {
                    stageDoneCounts.set(st, (stageDoneCounts.get(st) ?? 0) + 1);
                } else {
                    remainingCount += 1;
                }
            }

            const doneEmbedding = stageDoneCounts.get("embedding") ?? 0;

            const anyFailedStageJob =
                hasStageRows &&
                rows.some(
                    (r) =>
                        String(r.status ?? "") === "failed" &&
                        requiredStageSet.has(String(r.stage ?? ""))
                );
            const firstFailed = anyFailedStageJob
                ? rows.find(
                    (r) =>
                        String(r.status ?? "") === "failed" &&
                        requiredStageSet.has(String(r.stage ?? ""))
                ) ?? null
                : null;

            const fullyProcessed =
                totalBatches > 0 &&
                doneEmbedding >= totalBatches;

            const inferredCompleted = fullyProcessed;

            // Compute percent from required stages. If some stage jobs don't exist yet, count them as 0 done.
            // This keeps partially processed older libraries from showing 100%.
            let doneTotal = 0;
            for (const st of requiredStages) {
                doneTotal += Math.min(stageDoneCounts.get(st) ?? 0, totalBatches);
            }
            const denom = Math.max(1, totalBatches * requiredStages.length);
            const inferredPercent = totalBatches > 0 ? Math.round((doneTotal / denom) * 100) : 0;

            // Liveness / staleness: when a worker dies (e.g., the VM is stopped) it leaves jobs stuck
            // in "running" in the DB — nothing updates them, so the UI would show a confident
            // "running 9/7" forever. Detect silence and surface it instead of pretending it's live.
            const nowMs = Date.now();
            const STALE_HINT_MS = 5 * 60_000;
            const STALE_STOP_MS = 12 * 60_000;
            let lastActivityMs = 0;
            for (const r of rows) {
                const ts = r.updated_at ? Date.parse(r.updated_at) : 0;
                if (ts > lastActivityMs) lastActivityMs = ts;
            }
            const silentMs = lastActivityMs ? nowMs - lastActivityMs : 0;
            const anyActiveJob = rows.some((r) => {
                const s = String(r.status ?? "");
                return s === "running" || s === "queued";
            });
            const isStalled = anyActiveJob && lastActivityMs > 0 && silentMs > STALE_HINT_MS;

            const patched = {
                ...data,
                pipeline_status: anyFailedStageJob
                    ? "failed"
                    : inferredCompleted
                    ? "completed"
                    : (() => {
                        // Preserve terminal states regardless of remaining stage jobs.
                        if (data.pipeline_status === "canceled") return "canceled";
                        if (data.pipeline_status === "failed") return "failed";
                        // If we can't read stage jobs, never show completed unless progress is truly 100.
                        const pct = typeof data.pipeline_progress_percent === "number" ? data.pipeline_progress_percent : null;
                        if (!hasStageRows && data.pipeline_status === "completed" && pct !== null && pct < 100) {
                            return "running";
                        }
                        // If there is known remaining work, show running rather than inheriting stale values.
                        if (remainingCount > 0) return "running";
                        return data.pipeline_status ?? data.status;
                    })(),
                pipeline_progress_percent:
                    inferredCompleted
                        ? 100
                        : totalBatches > 0
                            ? inferredPercent
                            : data.pipeline_progress_percent,
                // Batches are only considered complete when final stage is complete.
                completed_batches: totalBatches > 0 ? Math.min(doneEmbedding, totalBatches) : data.completed_batches,
                pipeline_error:
                    anyFailedStageJob
                        ? (firstFailed?.last_error ?? data.pipeline_error ?? "A pipeline stage failed.")
                        : isStalled
                            ? `Backend not responding — no progress for ${Math.max(1, Math.round(silentMs / 60000))} min. The worker VM may be stopped; start it (or Resume) to continue.`
                            : data.pipeline_error,
            };

            setActiveLibrary((prev) =>
                prev && prev.id === libraryId ? { ...prev, ...patched } : prev
            );
            setLibraries((prev) =>
                prev.map((lib) =>
                    lib.id === libraryId ? { ...lib, ...patched } : lib
                )
            );

            // Pipeline log events (live status per batch+stage + transitions + errors).
            // This keeps the log panel useful without needing backend streaming.
            try {
                // Map job_id -> signature (status/progress/error). Lets us update live rows only when something changed.
                const prevMap = stageStateRef.current.get(libraryId) ?? new Map<string, string>();

                const nextMap = new Map<string, string>();
                for (const r of rows) {
                    if (!r?.id) continue;
                    const st = String(r.stage ?? "");
                    const status = String(r.status ?? "");
                    if (!st || !status) continue;
                    const sig = `${status}|${String(r.progress_current ?? "")}|${String(r.progress_total ?? "")}|${String(r.last_error ?? "")}`;
                    nextMap.set(r.id, sig);

                    const prevSig = prevMap.get(r.id);
                    const prevStatus = prevSig ? prevSig.split("|")[0] : undefined;

                    // Live line: always keep a single up-to-date entry per batch+stage.
                    // This is what prevents "started" logs from never becoming "done".
                    if (prevSig !== sig) {
                        addLog({
                            level:
                                status === "failed"
                                    ? "error"
                                    : status === "done"
                                        ? "success"
                                        : status === "canceled"
                                            ? "warn"
                                            : "info",
                            source: "pipeline",
                            key: `pipeline:${libraryId}:${String(r.batch_id ?? "")}:${st}`,
                            message: `Batch ${String(r.batch_id ?? "").slice(0, 8)} · ${st} → ${status}`,
                            details: {
                                stage: st,
                                status,
                                previous: prevStatus,
                                attempts: r.attempts,
                                worker: r.assigned_worker,
                                error: r.last_error,
                                progress: [
                                    r.progress_total && r.progress_current
                                        ? Math.min(r.progress_current, r.progress_total)
                                        : r.progress_current,
                                    r.progress_total,
                                ],
                                updated_at: r.updated_at,
                            },
                            libraryId,
                        });
                    }

                    if (status === "failed" && r.last_error) {
                        addLog({
                            level: "error",
                            source: "pipeline",
                            message: `${st} failed: ${r.last_error}`,
                            details: r,
                            libraryId,
                        });
                    }
                }

                stageStateRef.current.set(libraryId, nextMap);
            } catch {
                // ignore log diff errors
            }

            // Keep polling until the batches actually SETTLE (no running/queued left), so the per-batch
            // console reflects the final outcome — e.g. siblings moving running -> canceled after a
            // failure — instead of freezing at "running" until the user refreshes. Also stop if the
            // backend has gone silent for a long time (VM down), so we don't poll a dead VM forever.
            const shouldStop = !anyActiveJob || silentMs > STALE_STOP_MS;

            if (shouldStop) {
                clearInterval(interval);
                setSyncingLibraryIds((prev) => {
                    const next = new Set(prev);
                    next.delete(libraryId);
                    return next;
                });
            }
        }, 3000);
    }, [supabase, addLog]);

    useEffect(() => {
        libraries.forEach((library) => {
            const pipelineStatus = getPipelineStatus(library);
            if (
                (pipelineStatus === "queued" || pipelineStatus === "running") &&
                !syncingLibraryIds.has(library.id)
            ) {
                startLibraryStatusPolling(library.id);
            }
        });
    }, [libraries, syncingLibraryIds, startLibraryStatusPolling]);

    useEffect(() => {
        const loadLibraryStats = async () => {
            if (!activeLibrary) return;

            const { count } = await supabase
                .from("documents")
                .select("id", { count: "exact", head: true })
                .eq("library_id", activeLibrary.id);

            const { data } = await supabase
                .from("libraries")
                .select("last_synced_at")
                .eq("id", activeLibrary.id)
                .single();

            setActiveLibraryDocs(typeof count === "number" ? count : null);
            setActiveLibraryLastSync(data?.last_synced_at ?? null);
        };

        loadLibraryStats();
    }, [activeLibrary, supabase]);

    const handleDeleteLibrary = async () => {
        if (!activeLibrary || !currentOrg) {
            setDeleteError("Please select a library to delete.");
            return;
        }

        setDeleteConfirmOpen(true);
    };

    const confirmDeleteLibrary = async () => {
        if (!activeLibrary || !currentOrg) {
            setDeleteError("Please select a library to delete.");
            return;
        }

        setDeleteLoading(true);
        setDeleteError(null);

        const response = await fetch("/api/library/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                library_id: activeLibrary.id,
                organization_id: currentOrg.id,
            }),
        });

        const { data: payload } = await readJsonResponse(response);
        if (!response.ok) {
            setDeleteError(payload?.error || "Failed to delete library.");
            setDeleteLoading(false);
            return;
        }

        setLibraries((prev) => prev.filter((lib) => lib.id !== activeLibrary.id));
        setDeleteLoading(false);
        setDeleteConfirmOpen(false);
        closeLibraryDetails();
    };

    const filteredLibraries = useMemo(() => {
        const q = debouncedSearch;
        if (!q) return libraries;
        return libraries.filter((lib) => {
            const name = lib.name?.toLowerCase() ?? "";
            const sourceType = lib.source_type?.toLowerCase() ?? "";
            const status = lib.status?.toLowerCase() ?? "";
            const pipelineStatus = lib.pipeline_status?.toLowerCase() ?? "";
            const pipelineStage = lib.pipeline_stage?.toLowerCase() ?? "";
            return (
                name.includes(q) ||
                sourceType.includes(q) ||
                status.includes(q) ||
                pipelineStatus.includes(q) ||
                pipelineStage.includes(q)
            );
        });
    }, [libraries, debouncedSearch]);

    const renderHighlight = (value: string, query: string) => {
        if (!query) return value;
        const lowerValue = value.toLowerCase();
        const index = lowerValue.indexOf(query);
        if (index === -1) return value;
        const before = value.slice(0, index);
        const match = value.slice(index, index + query.length);
        const after = value.slice(index + query.length);
        return (
            <span>
                {before}
                <span className="rounded bg-[#884ab4]/40 px-1 text-gray-100">
                    {match}
                </span>
                {after}
            </span>
        );
    };

    const formatCreatedAt = (value: string | null) => {
        if (!value) return "Unknown";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "Unknown";
        return date.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
        });
    };

    const getPipelineStatus = (library: Library) => {
        const raw =
            library.pipeline_status || (library.status === "ready" ? "completed" : library.status);

        const total = typeof library.total_batches === "number" ? library.total_batches : 0;
        const completed = typeof library.completed_batches === "number" ? library.completed_batches : 0;
        const pct = typeof library.pipeline_progress_percent === "number" ? library.pipeline_progress_percent : null;

        // Prevent "completed" from showing for partially processed historical test libraries.
        if (raw === "completed") {
            if (pct !== null && pct < 100) return "incomplete";
            if (total > 0 && completed < total) return "incomplete";
        }

        return raw;
    };

    const getStatusBadge = (status: string) => {
        switch (status) {
            case "ready":
            case "completed":
                return (
                    <span className="inline-flex items-center gap-1.5 text-[10px] px-2 py-[3px] rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                        <span
                            className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: "#34d399" }}
                        />
                        COMPLETED
                    </span>
                );
            case "pending":
            case "idle":
                return (
                    <span className="inline-flex items-center gap-1.5 text-[10px] px-2 py-[3px] rounded-full bg-gray-600/30 text-gray-300 border border-gray-500/40">
                        <span
                            className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: "#9ca3af" }}
                        />
                        IDLE
                    </span>
                );
            case "queued":
                return (
                    <span className="inline-flex items-center gap-1.5 text-[10px] px-2 py-[3px] rounded-full bg-yellow-500/15 text-yellow-300 border border-yellow-500/40">
                        <span
                            className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: "#facc15" }}
                        />
                        QUEUED
                    </span>
                );
            case "processing":
            case "running":
                return (
                    <span className="inline-flex items-center gap-1.5 text-[10px] px-2 py-[3px] rounded-full bg-[#884ab4]/20 text-[#e6d2f2] border border-[#b87fd9]/40">
                        <span
                            className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: "#b87fd9" }}
                        />
                        PROCESSING
                    </span>
                );
            case "error":
            case "failed":
            case "canceled":
                return (
                    <span className="inline-flex items-center gap-1.5 text-[10px] px-2 py-[3px] rounded-full bg-red-500/15 text-red-300 border border-red-500/40">
                        <span
                            className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: "#f87171" }}
                        />
                        {status === "canceled" ? "CANCELED" : "FAILED"}
                    </span>
                );
            default:
                return (
                    <span className="inline-flex items-center gap-1.5 text-[10px] px-2 py-[3px] rounded-full bg-gray-600/30 text-gray-300 border border-gray-500/40">
                        <span
                            className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: "#9ca3af" }}
                        />
                        {status.toUpperCase()}
                    </span>
                );
        }
    };

    const getCardActionButtonClasses = (variant: "start" | "cancel" | "resume") => {
        const base =
            "relative inline-flex min-w-[96px] items-center justify-center overflow-hidden rounded-lg px-4 py-1.5 text-xs font-medium transition-all duration-200 " +
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-0 disabled:opacity-60 disabled:cursor-not-allowed " +
            "active:translate-y-[1px] hover:-translate-y-[1px]";

        if (variant === "start") {
            return (
                base +
                " text-[#fbf6ff] shadow-md shadow-[#884ab4]/25 " +
                "bg-gradient-to-b from-[#b87fd9] to-[#884ab4] " +
                "hover:shadow-lg hover:shadow-[#884ab4]/35 " +
                "focus-visible:ring-[#b87fd9]/75"
            );
        }

        if (variant === "resume") {
            return (
                base +
                " text-[#f7ecff] border border-[#b87fd9]/55 shadow-md shadow-[#884ab4]/18 " +
                "bg-gradient-to-b from-[#884ab4]/35 to-[color:var(--bg-secondary)]/55 " +
                "hover:border-[#b87fd9]/70 hover:shadow-lg hover:shadow-[#884ab4]/25 " +
                "focus-visible:ring-[#b87fd9]/70"
            );
        }

        // cancel
        return (
            base +
            " text-[#fff4d6] border border-[#b87fd9]/30 shadow-md shadow-[#884ab4]/10 " +
            "bg-gradient-to-b from-[#f59e0b]/20 to-[color:var(--bg-secondary)]/65 " +
            "hover:border-[#b87fd9]/45 hover:shadow-lg hover:shadow-[#884ab4]/14 " +
            "focus-visible:ring-[#fbbf24]/70"
        );
    };

    const getProgressPercent = (library: Library) => {
        if (typeof library.pipeline_progress_percent === "number") {
            return Math.max(0, Math.min(100, library.pipeline_progress_percent));
        }

        switch (getPipelineStatus(library)) {
            case "completed":
                return 100;
            case "running":
                return 15;
            case "queued":
                return 5;
            case "failed":
                return 100;
            default:
                return 0;
        }
    };

    // Handle logout
    const handleLogout = async () => {
        await supabase.auth.signOut();
        router.push("/");
    };

    // No organization state - show create prompt
    if (!loading && !currentOrg) {
        return (
            <div
                className="min-h-screen flex flex-col"
                style={{ backgroundColor: "var(--bg-primary)" }}
            >
                <DashboardNavbar
                    orgName="No Organization"
                    organizations={organizations}
                    currentOrgId={null}
                    onSelectOrg={handleSelectOrg}
                    onOpenHardware={() => setHardwareOpen(true)}
                    onOpenSettings={() => setSettingsOpen(true)}
                    avatarUrl={avatarUrl}
                    userEmail={userEmail}
                    onLogout={handleLogout}
                />

                    <div className="flex flex-1">
                    <DashboardSidebar onToggleConsole={toggleConsole} consoleOpen={consoleOpen} />

                    <div className="flex-1 flex items-center justify-center ml-16">
                        <div className="text-center">
                            <button
                                onClick={() => router.push("/new-organization")}
                                className="w-20 h-20 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-xl shadow-violet-500/30 flex items-center justify-center mx-auto mb-6 transition-all cursor-pointer hover:scale-105 animate-float"
                            >
                                <FiPlus className="w-10 h-10 text-white" />
                            </button>
                            <h2 className="text-2xl font-bold text-white">
                                Create your first organization
                            </h2>
                            <p className="mt-2 text-sm text-gray-400 max-w-md">
                                Click the button above to get started.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (loading) {
        return (
            <div
                className="min-h-screen flex flex-col"
                style={{ backgroundColor: "var(--bg-primary)" }}
            >
                <DashboardNavbar
                    orgName={currentOrg?.name ?? "Organization"}
                    organizations={organizations}
                    currentOrgId={currentOrg?.id ?? null}
                    onSelectOrg={handleSelectOrg}
                    onOpenHardware={() => setHardwareOpen(true)}
                    onOpenSettings={() => setSettingsOpen(true)}
                    avatarUrl={avatarUrl}
                    userEmail={userEmail}
                    onLogout={handleLogout}
                />

                    <div className="flex flex-1">
                    {/* Sidebar on the left */}
                    <DashboardSidebar onToggleConsole={toggleConsole} consoleOpen={consoleOpen} />

                    {/* Centered loading text in main area */}
                    <div className="flex-1 flex items-center justify-center text-gray-400 text-sm ml-16">
                        <Loader />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            className="min-h-screen flex flex-col text-gray-100"
            style={{ backgroundColor: "var(--bg-primary)" }}
        >
            <DashboardNavbar
                orgName={currentOrg?.name ?? "Organization"}
                organizations={organizations}
                currentOrgId={currentOrg?.id ?? null}
                onSelectOrg={handleSelectOrg}
                onOpenHardware={() => setHardwareOpen(true)}
                onOpenSettings={() => setSettingsOpen(true)}
                avatarUrl={avatarUrl}
                userEmail={userEmail}
                onLogout={handleLogout}
            />

            <div className="flex flex-1">
                {/* Sidebar on the left */}
                <DashboardSidebar onToggleConsole={toggleConsole} consoleOpen={consoleOpen} />

                {/* Main content */}
                <main
                    className={`flex-1 w-full px-6 ml-16 ${activeTab === "chat"
                        ? "max-w-none mx-0 pr-10 pt-3 pb-4"
                        : "max-w-6xl mx-auto pt-8 pb-10"
                        }`}
                >
                    {activeTab === "chat" ? (
                        <ChatWorkspace
                            supabase={supabase}
                            organization={currentOrg ? { id: currentOrg.id, name: currentOrg.name } : null}
                            libraries={libraries}
                            personalization={personalization}
                            onLog={(e) =>
                                addLog({
                                    level: e.level,
                                    source: "chat",
                                    message: e.message,
                                    details: e.details,
                                })
                            }
                        />
                    ) : activeTab === "team" ? (
                        <TeamWorkspace
                            supabase={supabase}
                            organization={currentOrg ? { id: currentOrg.id, name: currentOrg.name } : null}
                            onLog={(e) =>
                                addLog({ level: e.level, source: "team", message: e.message, details: e.details })
                            }
                        />
                    ) : (
                        <>
                            {/* Title row */}
                            <div className="flex items-center justify-between mb-5">
                                <div>
                                    <h1 className="text-3xl font-bold tracking-tight">
                                        Your <span className="gradient-text">libraries</span>
                                    </h1>
                                    <p className="mt-1 text-sm text-white/50">
                                        Connect a source, process it, then chat with your documents.
                                    </p>
                                </div>

                                {/* View toggle + New Library */}
                                <div className="flex items-center gap-3">
                                    <div className="flex items-center rounded-xl glass p-1">
                                        <button
                                            onClick={() => setView("grid")}
                                            className={`grid place-items-center h-7 w-7 rounded-lg text-xs transition-colors ${view === "grid" ? "bg-white/12 text-white" : "text-white/45 hover:text-white"}`}
                                        >
                                            <FiGrid className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                            onClick={() => setView("list")}
                                            className={`grid place-items-center h-7 w-7 rounded-lg text-xs transition-colors ${view === "list" ? "bg-white/12 text-white" : "text-white/45 hover:text-white"}`}
                                        >
                                            <FiList className="w-3.5 h-3.5" />
                                        </button>
                                    </div>

                                    <button
                                        onClick={openCreateLibrary}
                                        className="btn-grad inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-white"
                                    >
                                        <FiPlus className="w-4 h-4" /> New library
                                    </button>
                                </div>
                            </div>

                            {/* Search bar + Filter */}
                            <div className="flex items-center gap-2 mb-8">
                                <div className="w-full max-w-[450px] relative">
                                    <FiSearch className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                                    <input
                                        value={search}
                                        onChange={(e) => setSearch(e.target.value)}
                                        placeholder="Search for a library"
                                        className="w-full rounded-xl glass pl-10 pr-3 py-2.5 text-sm text-white placeholder:text-white/40 outline-none transition-all focus:border-violet-400/50"
                                    />
                                </div>
                                <button className="grid place-items-center h-[42px] w-[42px] rounded-xl glass text-white/50 hover:text-white transition-all">
                                    <FiFilter className="w-4 h-4" />
                                </button>
                            </div>

                            {/* Libraries list */}
                            {filteredLibraries.length === 0 ? (
                                <div className="mt-10 text-sm text-gray-500">
                                    No libraries found. Try clearing the search or create a new library.
                                    <div className="mt-4">
                                        <button
                                            onClick={openCreateLibrary}
                                            className="btn-grad rounded-xl px-4 py-2 text-xs font-medium text-white"
                                        >
                                            Create library
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div
                                    className={
                                        view === "grid"
                                            ? "grid gap-4 md:grid-cols-2 lg:grid-cols-2 max-w-[920px]"
                                            : "flex flex-col gap-3 max-w-[450px]"
                                    }
                                >
                                    {filteredLibraries.map((lib) => {
                                        const pipelineStatus = getPipelineStatus(lib);
                                        const canCancel =
                                            pipelineStatus === "queued" || pipelineStatus === "running";
                                const isCanceling = cancelingLibraryIds.has(lib.id);
                                const totalBatches = lib.total_batches ?? 0;
                                const completedBatches = lib.completed_batches ?? 0;
                                const incomplete =
                                    typeof totalBatches === "number" &&
                                    totalBatches > 0 &&
                                    typeof completedBatches === "number" &&
                                    completedBatches < totalBatches;

                                const canResume =
                                    pipelineStatus === "failed" ||
                                    pipelineStatus === "error" ||
                                    pipelineStatus === "canceled" ||
                                    incomplete;

                                const isStarting = startingLibraryIds.has(lib.id);
                                const isResuming = resumingLibraryIds.has(lib.id);

                                return (
                                <div
                                    key={lib.id}
                                    className="group text-left rounded-2xl glass glass-hi hover-glow px-5 py-5 flex items-center justify-between gap-4 transition-all w-full cursor-pointer"
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => openDrawer(lib)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" || e.key === " ") openDrawer(lib);
                                    }}
                                >
                                    <div className="flex flex-col">
                                        <span className="flex items-center gap-2 text-lg font-bold text-gray-100">
                                            {renderHighlight(lib.name, debouncedSearch)}
                                            <span className="text-xs font-medium text-gray-500">
                                                {formatCreatedAt(lib.created_at)}
                                            </span>
                                        </span>
                                        <div className="mt-2 flex items-center gap-3">
                                            {!["running", "queued", "processing"].includes(getPipelineStatus(lib))
                                                ? getStatusBadge(getPipelineStatus(lib))
                                                : null}
                                            <div className="flex items-center gap-2">
                                                <div className="h-2 w-48 rounded-full bg-white/[0.07] overflow-hidden ring-1 ring-inset ring-white/[0.06]">
                                                    <div
                                                        className={`h-full rounded-full transition-all duration-500 ${getPipelineStatus(lib) === "completed"
                                                                ? "bg-emerald-500"
                                                                : getPipelineStatus(lib) === "failed"
                                                                    ? "bg-red-500"
                                                                    : "bg-gradient-to-r from-violet-400 to-fuchsia-400 shimmer"
                                                            }`}
                                                        style={{
                                                            width: `${getProgressPercent(lib)}%`,
                                                            opacity: getPipelineStatus(lib) === "idle" ? 0.7 : 1,
                                                        }}
                                                    />
                                                </div>
                                                <span className="text-[11px] font-medium tabular-nums text-white/60">
                                                    {Math.round(getProgressPercent(lib))}%
                                                </span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center h-full">
                                        {canCancel ? (
                                            <button
                                                type="button"
                                                className={getCardActionButtonClasses("cancel")}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleCancelProcessing(lib);
                                                }}
                                                disabled={isCanceling}
                                            >
                                                <span className="absolute inset-0 opacity-0 transition-opacity duration-200 hover:opacity-100 bg-[radial-gradient(circle_at_30%_20%,rgba(253,224,71,0.25),transparent_55%)]" />
                                                <span className="relative">{isCanceling ? "Canceling..." : "Cancel"}</span>
                                            </button>
                                        ) : canResume ? (
                                            <button
                                                type="button"
                                                className={getCardActionButtonClasses("resume")}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleResumeLibrary(lib);
                                                }}
                                                disabled={isResuming}
                                            >
                                                <span className="absolute inset-0 opacity-0 transition-opacity duration-200 hover:opacity-100 bg-[radial-gradient(circle_at_30%_20%,rgba(184,127,217,0.25),transparent_55%)]" />
                                                <span className="relative">{isResuming ? "Resuming..." : "Resume"}</span>
                                            </button>
                                        ) : (
                                            pipelineStatus === "completed" ? null : (
                                            <button
                                                type="button"
                                                className={getCardActionButtonClasses("start")}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleSyncLibrary(lib);
                                                }}
                                                disabled={isStarting}
                                            >
                                                <span className="absolute inset-0 opacity-0 transition-opacity duration-200 hover:opacity-100 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.25),transparent_55%)]" />
                                                <span className="relative">
                                                    {isStarting ? "Starting..." : "Start"}
                                                </span>
                                            </button>
                                            )
                                        )}
                                    </div>
                                </div>
                                );
                                    })}
                                </div>
                            )}
                        </>
                    )}
                </main>
            </div>

            {createLibraryOpen && (
                <div className="fixed inset-0 z-40 flex items-start justify-center px-4 pt-16">
                    <button
                        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
                        aria-label="Close create library modal"
                        onClick={closeCreateLibrary}
                    />
                    <div
                        role="dialog"
                        aria-modal="true"
                        className={`relative w-full max-w-xl rounded-2xl border border-white/10 p-8 shadow-[0_20px_60px_rgba(0,0,0,0.55)] max-h-[calc(100vh-6rem)] overflow-y-auto transition-all duration-200 ${createLibraryClosing ? "scale-95 opacity-0" : "scale-100 opacity-100"
                            }`}
                        style={{
                            backgroundColor: "rgba(20, 25, 37, 0.98)",
                            color: "var(--text-primary)",
                        }}
                    >
                        <div className="flex items-center justify-between">
                            <h2 className="text-xl font-semibold text-gray-100">
                                Create a new library
                            </h2>
                            <button
                                className="text-sm text-gray-400 hover:text-gray-200"
                                onClick={closeCreateLibrary}
                            >
                                Close
                            </button>
                        </div>

                        <p className="mt-2 text-sm text-gray-400">
                            Libraries connect a data source and power search + analytics for this
                            organization.
                        </p>

                        <form className="mt-6 space-y-5" onSubmit={handleCreateLibrary}>
                            <div>
                                <label className="block text-sm font-medium text-gray-300 mb-2">
                                    Name
                                </label>
                                <input
                                    value={newLibraryName}
                                    onChange={(e) => setNewLibraryName(e.target.value)}
                                    type="text"
                                    placeholder="Finance Reports"
                                    className="w-full rounded-lg px-4 py-3 text-sm outline-none transition-all focus:ring-1 focus:ring-[#b87fd9] hover:border-[#b87fd9]/60"
                                    style={{
                                        backgroundColor: "var(--bg-primary)",
                                        border: "1px solid var(--border-color-subtle)",
                                        color: "var(--text-primary)",
                                    }}
                                    required
                                />
                                <p className="mt-1.5 text-xs text-gray-500">
                                    Pick a name that describes the source folder.
                                </p>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-300 mb-2">
                                    Source type
                                </label>
                                <div
                                    className="w-full rounded-lg px-4 py-3 text-sm border border-white/10 bg-black/30 text-gray-100 transition-all hover:border-[#b87fd9]/60"
                                >
                                    Google Drive
                                </div>
                                <p className="mt-1.5 text-xs text-gray-500">
                                    Only Google Drive is supported right now.
                                </p>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-300 mb-2">
                                    Source folder ID
                                </label>
                                <div className="flex items-center gap-2">
                                    <input
                                        value={newLibrarySourceFolder}
                                        onChange={(e) => setNewLibrarySourceFolder(e.target.value)}
                                        type="text"
                                        placeholder="1A2B3C4D5E"
                                        className="w-full rounded-lg px-4 py-3 text-sm outline-none transition-all focus:ring-1 focus:ring-[#b87fd9] hover:border-[#b87fd9]/60"
                                        style={{
                                            backgroundColor: "var(--bg-primary)",
                                            border: "1px solid var(--border-color-subtle)",
                                            color: "var(--text-primary)",
                                        }}
                                        required
                                    />
                                    <button
                                        type="button"
                                        onClick={handlePickDriveFolder}
                                        className="rounded-lg border border-white/20 bg-transparent px-4 py-3 text-sm font-medium text-gray-300 hover:bg-white/5 hover:border-[#b87fd9]/60 hover:text-white transition-all"
                                    >
                                        Pick folder
                                    </button>
                                </div>
                                <p className="mt-1.5 text-xs text-gray-500">
                                    For Google Drive, paste the folder ID from the URL.
                                </p>
                                {newLibrarySourceFolderName && (
                                    <p className="mt-1 text-xs text-gray-400">
                                        Selected: {newLibrarySourceFolderName}
                                    </p>
                                )}
                            </div>

                            <div className="flex items-center justify-end gap-3 pt-2">
                                {createLibraryError && (
                                    <span className="text-xs text-red-400 mr-auto">
                                        {createLibraryError}
                                    </span>
                                )}
                                <button
                                    type="button"
                                    className="rounded-lg border border-white/20 bg-transparent px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 hover:text-white transition-all"
                                    onClick={closeCreateLibrary}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={!newLibraryName.trim() || !newLibrarySourceFolder.trim()}
                                    className="btn-grad rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                                >
                                    {createLibraryLoading ? "Creating..." : "Create library"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}


            <SettingsModal
                supabase={supabase}
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                onLogout={handleLogout}
                onSaved={(prefs, profile) => {
                    setPersonalization(prefs);
                    setAvatarUrl(profile.avatarUrl);
                }}
            />

            {hardwareOpen && (
                <div className="fixed inset-0 z-40 flex items-start justify-center px-4 pt-16 overflow-y-auto">
                    <button
                        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
                        aria-label="Close hardware details"
                        onClick={() => setHardwareOpen(false)}
                    />
                    <div
                        role="dialog"
                        aria-modal="true"
                        className="relative w-full max-w-xl rounded-2xl border border-white/10 p-8 shadow-[0_20px_60px_rgba(0,0,0,0.55)] max-h-[calc(100vh-6rem)] overflow-y-auto"
                        style={{
                            backgroundColor: "rgba(20, 25, 37, 0.98)",
                            color: "var(--text-primary)",
                        }}
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <p className="text-xs uppercase tracking-wide text-gray-500">
                                    GPU capabilities
                                </p>
                                <h2 className="mt-1 text-xl font-semibold text-gray-100">
                                    GPU hardware
                                </h2>
                            </div>
                            <button
                                className="text-sm text-gray-400 hover:text-gray-200"
                                onClick={() => setHardwareOpen(false)}
                            >
                                Close
                            </button>
                        </div>

                        <div className="mt-6 flex items-center justify-between">
                            <div>
                                <p className="text-xs text-gray-500">Backend status</p>
                                <p className="mt-1 text-sm text-gray-100">RunPod GPU node</p>
                            </div>
                            {hardwareError ? (
                                <span className="text-xs text-red-400">{hardwareError}</span>
                            ) : (
                                <span className="text-xs text-emerald-300">Live</span>
                            )}
                        </div>

                        <div className="mt-5 grid gap-3 md:grid-cols-4">
                            <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
                                <p className="text-[11px] text-gray-500">CPU</p>
                                <p className="mt-1 text-sm text-gray-100">
                                    {hardwareInfo?.cpu ?? "—"} cores
                                </p>
                            </div>
                            <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
                                <p className="text-[11px] text-gray-500">RAM</p>
                                <p className="mt-1 text-sm text-gray-100">
                                    {hardwareInfo?.ram_gb ?? "—"} GB
                                </p>
                            </div>
                            <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
                                <p className="text-[11px] text-gray-500">GPU</p>
                                <p className="mt-1 text-sm text-gray-100">
                                    {hardwareInfo?.gpu ?? "—"}
                                </p>
                            </div>
                            <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
                                <p className="text-[11px] text-gray-500">VRAM</p>
                                <p className="mt-1 text-sm text-gray-100">
                                    {hardwareInfo?.vram_gb ?? "—"} GB
                                </p>
                            </div>
                        </div>

                        {driveNotice && (
                            <div className="mt-5 rounded-lg border border-white/10 bg-black/30 px-4 py-3 text-xs text-gray-300">
                                {driveNotice}
                            </div>
                        )}

                        <div className="mt-4 grid gap-3 md:grid-cols-3">
                            <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
                                <p className="text-[11px] text-gray-500">Sync workers</p>
                                <p className="mt-1 text-sm text-gray-100">
                                    {hardwareInfo?.sync_workers ?? "—"}
                                </p>
                            </div>
                            <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
                                <p className="text-[11px] text-gray-500">Extract workers</p>
                                <p className="mt-1 text-sm text-gray-100">
                                    {hardwareInfo?.extract_workers ?? "—"}
                                </p>
                            </div>
                            <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
                                <p className="text-[11px] text-gray-500">Embed workers</p>
                                <p className="mt-1 text-sm text-gray-100">
                                    {hardwareInfo?.embed_workers ?? "—"}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {deleteConfirmOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
                    <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
                <div className="relative w-full max-w-sm rounded-2xl border border-white/10 bg-[color:var(--bg-secondary)] p-5 shadow-2xl">
                        <div className="text-sm uppercase tracking-wide text-gray-500">
                            Confirm deletion
                        </div>
                        <h3 className="mt-1 text-lg font-semibold text-gray-100">
                            Delete this library?
                        </h3>
                        <p className="mt-2 text-sm text-gray-400">
                            This action permanently removes the library and its files from R2.
                        </p>
                        {deleteError && (
                            <p className="mt-3 text-xs text-red-400">{deleteError}</p>
                        )}
                        <div className="mt-5 flex items-center justify-end gap-2">
                            <button
                                className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-medium text-gray-200 hover:bg-white/10 transition"
                                onClick={() => setDeleteConfirmOpen(false)}
                                disabled={deleteLoading}
                            >
                                Cancel
                            </button>
                            <button
                                className="rounded-lg bg-red-500/15 px-3 py-2 text-xs font-medium text-red-200 hover:bg-red-500/25 hover:text-red-100 transition"
                                onClick={confirmDeleteLibrary}
                                disabled={deleteLoading}
                            >
                                {deleteLoading ? "Deleting..." : "Delete"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <LogPanel
                open={consoleOpen}
                onClose={toggleConsole}
                logs={logs}
                libraries={libraries.map((l) => ({ id: l.id, name: l.name, pipeline_status: l.pipeline_status ?? null }))}
                onClear={clearLogs}
            />

            <LibraryDrawer
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                library={drawerLibrary}
                organizationId={currentOrg?.id ?? null}
                supabase={supabase}
                onLog={(e) =>
                    addLog({
                        level: e.level,
                        source: "drawer",
                        message: e.message,
                        details: e.details,
                        libraryId: drawerLibrary?.id,
                    })
                }
                onDeleted={(libraryId) => {
                    setLibraries((prev) => prev.filter((l) => l.id !== libraryId));
                    if (activeLibrary?.id === libraryId) closeLibraryDetails();
                }}
            />
        </div>
    );

}
