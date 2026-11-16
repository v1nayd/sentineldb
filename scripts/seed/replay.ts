/**
 * Emits a seed as a REPLAY of the real lifecycle (ADR-2): incidents are inserted as 'open' and then moved through the
 * same procedures and triggers the application uses, with @sentinel_actor / @sentinel_clock set before each step.
 * The seed therefore doubles as an end-to-end test of the triggers: if a generated step breaks a rule, loading fails.
 *
 * The emitter also checks, at generation time, the two things the database would reject later anyway, so mistakes in
 * a generator fail with a readable TypeScript stack instead of an SQL error halfway through a 4,000-statement file:
 * the clock never moves backwards within one incident, and a note's author is always the acting user.
 */

export type Ts = Date;

export function fmt(t: Ts): string {
  return t.toISOString().slice(0, 19).replace("T", " ");
}

/** SQL string literal. Only generator-authored text reaches here, but escape properly anyway (\ and '). */
export function q(v: string | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

export type IocReview = "confirmed" | "dismissed";

export class ReplayScript {
  private out: string[] = [];
  private actor: number | undefined;
  private clock: string | undefined;
  private lastAt = new Map<number, number>(); // incident -> last lifecycle timestamp (ms)

  constructor(header: string[]) {
    for (const h of header) this.out.push(h ? `-- ${h}` : "--");
    this.out.push("", "START TRANSACTION;", "");
  }

  comment(text: string): void { this.out.push("", `-- ${text}`); }
  raw(sql: string): void { this.out.push(sql); }

  /** Sets the acting user and the replay clock for the next statements (only emits what changed). */
  private as(actor: number, at: Ts): void {
    const c = fmt(at);
    if (actor !== this.actor && c !== this.clock) this.out.push(`SET @sentinel_actor = ${actor}, @sentinel_clock = '${c}';`);
    else if (actor !== this.actor) this.out.push(`SET @sentinel_actor = ${actor};`);
    else if (c !== this.clock) this.out.push(`SET @sentinel_clock = '${c}';`);
    this.actor = actor; this.clock = c;
  }

  private lifecycle(incident: number, at: Ts): void {
    const prev = this.lastAt.get(incident);
    if (prev !== undefined && at.getTime() < prev) {
      throw new Error(`generator bug: incident ${incident} step at ${fmt(at)} is earlier than its previous step ${fmt(new Date(prev))}`);
    }
    this.lastAt.set(incident, at.getTime());
  }

  createIncident(i: { id: number; title: string; narrative: string; severity: string; reportedBy: number; at: Ts }): void {
    this.as(i.reportedBy, i.at); this.lifecycle(i.id, i.at);
    this.out.push(`INSERT INTO Incidents (incident_id, title, narrative, severity, reported_by) VALUES (${i.id}, ${q(i.title)}, ${q(i.narrative)}, ${q(i.severity)}, ${i.reportedBy});`);
  }

  linkIoc(actor: number, at: Ts, incident: number, ioc: number, notes: string | null): void {
    this.as(actor, at);
    this.out.push(`INSERT INTO Incident_IOC (incident_id, ioc_id, notes) VALUES (${incident}, ${ioc}, ${q(notes)});`);
  }

  unlinkIoc(actor: number, at: Ts, incident: number, ioc: number): void {
    this.as(actor, at);
    this.out.push(`DELETE FROM Incident_IOC WHERE incident_id = ${incident} AND ioc_id = ${ioc};`);
  }

  linkAsset(actor: number, at: Ts, incident: number, asset: number, impact: string | null): void {
    this.as(actor, at);
    this.out.push(`INSERT INTO Incident_Asset (incident_id, asset_id, impact_description) VALUES (${incident}, ${asset}, ${q(impact)});`);
  }

  describeImpact(actor: number, at: Ts, incident: number, asset: number, impact: string): void {
    this.as(actor, at);
    this.out.push(`UPDATE Incident_Asset SET impact_description = ${q(impact)} WHERE incident_id = ${incident} AND asset_id = ${asset};`);
  }

  reviewIoc(actor: number, at: Ts, incident: number, ioc: number, decision: IocReview): void {
    this.as(actor, at);
    this.out.push(`UPDATE Incident_IOC SET review_status = '${decision}' WHERE incident_id = ${incident} AND ioc_id = ${ioc};`);
  }

  note(actor: number, at: Ts, incident: number, content: string): void {
    this.as(actor, at);
    this.out.push(`INSERT INTO Notes (incident_id, author_id, content) VALUES (${incident}, ${actor}, ${q(content)});`);
  }

  applyPlaybook(at: Ts, incident: number, playbook: number): void {
    // Incident_Playbook has no trigger; the import account may set applied_at directly (the runtime account may not).
    this.out.push(`INSERT INTO Incident_Playbook (incident_id, playbook_id, applied_at) VALUES (${incident}, ${playbook}, '${fmt(at)}');`);
  }

  reassign(actor: number, at: Ts, incident: number, to: number, reason: string): void {
    this.as(actor, at); this.lifecycle(incident, at);
    this.out.push(`CALL reassign_incident(${incident}, ${to}, ${q(reason)});`);
  }

  transition(actor: number, at: Ts, incident: number, to: string, reason: string | null = null): void {
    if (to === "closed") throw new Error("use close()");
    this.as(actor, at); this.lifecycle(incident, at);
    this.out.push(`CALL transition_incident(${incident}, '${to}', ${q(reason)});`);
  }

  close(actor: number, at: Ts, incident: number, reason: string | null): void {
    this.as(actor, at); this.lifecycle(incident, at);
    this.out.push(`CALL close_incident(${incident}, ${q(reason)});`);
  }

  archive(actor: number, at: Ts, incident: number, reason: string): void {
    this.as(actor, at); this.lifecycle(incident, at);
    this.out.push(`CALL archive_incident(${incident}, ${q(reason)});`);
  }

  toString(): string {
    return [...this.out, "", "SET @sentinel_actor = NULL, @sentinel_clock = NULL, @sentinel_reason = NULL;", "COMMIT;", ""].join("\n");
  }
}

/** Small deterministic PRNG (mulberry32): the same seed always yields the same dataset, byte for byte. */
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => { if (xs.length === 0) throw new Error("pick from empty"); return xs[Math.floor(next() * xs.length)]!; };
  const chance = (p: number) => next() < p;
  const weighted = <T>(pairs: ReadonlyArray<readonly [T, number]>): T => {
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let r = next() * total;
    for (const [v, w] of pairs) { if ((r -= w) < 0) return v; }
    return pairs[pairs.length - 1]![0];
  };
  const shuffle = <T>(xs: T[]): T[] => { for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [xs[i], xs[j]] = [xs[j]!, xs[i]!]; } return xs; };
  return { next, int, pick, chance, weighted, shuffle };
}
export type Rng = ReturnType<typeof prng>;

export const minutes = (t: Ts, m: number): Ts => new Date(t.getTime() + Math.round(m) * 60_000);
