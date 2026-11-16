import { api, idParam, json, readJson } from "@/lib/http";
import { addNote, noteSchema } from "@/lib/repo/incidents";

export const dynamic = "force-dynamic";

/** POST /api/incidents/:id/notes {content} — append a note as yourself (notes are append-only). */
export const POST = api<{ id: string }>("user", async ({ req, params, user }) => {
  const noteId = await addNote(user!, idParam(params.id), (await readJson(req, noteSchema)).content);
  return json({ note_id: noteId }, 201);
});
