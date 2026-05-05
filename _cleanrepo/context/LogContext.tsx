"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export type LogLevel = "info" | "success" | "warn" | "error";

export type LogEntry = {
  id: string;
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
  /**
   * Optional stable key for "live" logs (e.g. pipeline batch+stage).
   * If provided, new logs with the same key will replace the previous entry instead of appending.
   */
  key?: string;
  details?: unknown;
  libraryId?: string;
};

type LogContextValue = {
  logs: LogEntry[];
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  addLog: (entry: Omit<LogEntry, "id" | "ts"> & { ts?: number }) => void;
  clear: () => void;
};

const LogContext = createContext<LogContextValue | null>(null);

function makeId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function LogProvider({ children }: { children: React.ReactNode }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const keyToIdRef = useRef<Map<string, string>>(new Map());
  const originalConsoleRef = useRef<{
    error?: typeof console.error;
    warn?: typeof console.warn;
    info?: typeof console.info;
  }>({});

  const addLog = useCallback((entry: Omit<LogEntry, "id" | "ts"> & { ts?: number }) => {
    const key = entry.key;
    const existingId = key ? keyToIdRef.current.get(key) : undefined;
    const id = existingId ?? makeId();
    const item: LogEntry = {
      id,
      ts: typeof entry.ts === "number" ? entry.ts : Date.now(),
      level: entry.level,
      source: entry.source,
      message: entry.message,
      key,
      details: entry.details,
      libraryId: entry.libraryId,
    };
    setLogs((prev) => {
      let next: LogEntry[];
      if (existingId) {
        next = prev.map((l) => (l.id === existingId ? { ...l, ...item } : l));
      } else {
        next = [...prev, item];
      }

      // Keep memory bounded (and keep key map consistent).
      const max = 2000;
      if (next.length > max) {
        next = next.slice(next.length - max);
        const validIds = new Set(next.map((l) => l.id));
        for (const [k, vid] of keyToIdRef.current.entries()) {
          if (!validIds.has(vid)) keyToIdRef.current.delete(k);
        }
      }

      if (key && !existingId) {
        keyToIdRef.current.set(key, id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    keyToIdRef.current.clear();
    setLogs([]);
  }, []);

  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  useEffect(() => {
    // Frontend crash capture.
    const onError = (ev: ErrorEvent) => {
      addLog({
        level: "error",
        source: "frontend",
        message: ev.message || "Unhandled error",
        details: {
          filename: ev.filename,
          lineno: ev.lineno,
          colno: ev.colno,
          stack: ev.error?.stack,
        },
      });
    };

    const onUnhandled = (ev: PromiseRejectionEvent) => {
      const reason = ev.reason;
      addLog({
        level: "error",
        source: "frontend",
        message: "Unhandled promise rejection",
        details:
          reason instanceof Error
            ? { message: reason.message, stack: reason.stack }
            : reason,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandled);

    // Console mirroring (kept lightweight).
    originalConsoleRef.current.error = console.error;
    originalConsoleRef.current.warn = console.warn;
    originalConsoleRef.current.info = console.info;
    const originals = { ...originalConsoleRef.current };

    console.error = (...args: unknown[]) => {
      addLog({ level: "error", source: "console", message: args.map(String).join(" "), details: args });
      originalConsoleRef.current.error?.(...(args as Parameters<typeof console.error>));
    };
    console.warn = (...args: unknown[]) => {
      addLog({ level: "warn", source: "console", message: args.map(String).join(" "), details: args });
      originalConsoleRef.current.warn?.(...(args as Parameters<typeof console.warn>));
    };
    console.info = (...args: unknown[]) => {
      addLog({ level: "info", source: "console", message: args.map(String).join(" "), details: args });
      originalConsoleRef.current.info?.(...(args as Parameters<typeof console.info>));
    };

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandled);
      // Restore originals.
      if (originals.error) console.error = originals.error;
      if (originals.warn) console.warn = originals.warn;
      if (originals.info) console.info = originals.info;
    };
  }, [addLog]);

  const value = useMemo<LogContextValue>(
    () => ({
      logs,
      isOpen,
      setOpen: setIsOpen,
      toggle,
      addLog,
      clear,
    }),
    [logs, isOpen, toggle, addLog, clear]
  );

  return <LogContext.Provider value={value}>{children}</LogContext.Provider>;
}

export function useLog() {
  const ctx = useContext(LogContext);
  if (!ctx) throw new Error("useLog must be used within LogProvider");
  return ctx;
}
