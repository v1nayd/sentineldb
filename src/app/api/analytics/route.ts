import { api, json } from "@/lib/http";
import { analyticsOverview } from "@/lib/repo/admin";

export const dynamic = "force-dynamic";

/** GET /api/analytics — organisation-wide dashboards (admins only: analysts may not see colleagues' metrics, spec s.10). */
export const GET = api("admin", async () => json(await analyticsOverview()));
