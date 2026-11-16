import { requireUser } from "@/lib/auth/current-user";
import { NewIncidentForm } from "./form";

export const metadata = { title: "Report incident" };

export default async function NewIncidentPage() {
  await requireUser();
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Report an incident</h1>
          <p className="muted" style={{ margin: 0 }}>You become the reporter. It starts open and unassigned; an admin assigns it.</p>
        </div>
      </div>
      <NewIncidentForm />
    </div>
  );
}
