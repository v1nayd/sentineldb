import { requireUser } from "@/lib/auth/current-user";
import { SearchForm } from "./search-form";

export const metadata = { title: "Similar search" };

export default async function SearchPage() {
  const user = await requireUser();
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Have we seen this before?</h1>
          <p className="muted" style={{ margin: 0 }}>
            Describe an incident and, if you have them, its indicators. Results combine semantic similarity with shared evidence.
            {user.role !== "admin" && " Only incidents you reported or are assigned to are searched."}
          </p>
        </div>
      </div>
      <SearchForm />
    </div>
  );
}
