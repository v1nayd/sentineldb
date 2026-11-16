"use client";

/**
 * Browser-side calls to the JSON API (same origin, so the session cookie and the Origin header the CSRF check expects
 * are sent automatically). Errors become ApiError with the server's message and, for database rules, the SDB code.
 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly rule?: string) { super(message); }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const e = (data as { error?: { message?: string; rule?: string } } | null)?.error;
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth/login")) window.location.href = "/login";
    throw new ApiError(res.status, e?.message ?? `request failed (${res.status})`, e?.rule);
  }
  return data as T;
}

export const describeError = (e: unknown) =>
  e instanceof ApiError ? `${e.message}${e.rule ? ` (rule ${e.rule})` : ""}` : "Something went wrong. Please try again.";
