import { api, idParam, json, readJson } from "@/lib/http";
import { reviewIoc, reviewSchema, unlinkIoc } from "@/lib/repo/incidents";

export const dynamic = "force-dynamic";
type P = { id: string; iocId: string };

/** PATCH /api/incidents/:id/iocs/:iocId {review_status} — record your review decision (assignee or admin). */
export const PATCH = api<P>("user", async ({ req, params, user }) => {
  await reviewIoc(user!, idParam(params.id), idParam(params.iocId, "IOC link"), (await readJson(req, reviewSchema)).review_status);
  return json({ ok: true });
});

/** DELETE /api/incidents/:id/iocs/:iocId — unlink (audited, including the review state the link had). */
export const DELETE = api<P>("user", async ({ params, user }) => {
  await unlinkIoc(user!, idParam(params.id), idParam(params.iocId, "IOC link"));
  return json({ ok: true });
});
