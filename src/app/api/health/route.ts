import { NextResponse } from "next/server";
import { appPool } from "../../../lib/db";
import { qdrant } from "../../../lib/qdrant";

export const dynamic = "force-dynamic"; // never cache a health probe

/** Reports reachability only. Error details are logged server-side, never returned to the caller. */
export async function GET() {
  const status = { mysql: "down", qdrant: "down" } as Record<string, string>;
  try {
    await appPool().query("SELECT 1");
    status.mysql = "up";
  } catch (err) {
    console.error("[health] mysql check failed:", (err as Error).message);
  }
  try {
    await qdrant().getCollections();
    status.qdrant = "up";
  } catch (err) {
    console.error("[health] qdrant check failed:", (err as Error).message);
  }
  const ok = status.mysql === "up" && status.qdrant === "up";
  return NextResponse.json({ ok, ...status }, { status: ok ? 200 : 503 });
}
