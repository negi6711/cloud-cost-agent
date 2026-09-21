import type { CarriedFinding, SnapshotHistory } from "@/lib/history";
import { money, monthLabel } from "@/lib/format";
import { CATEGORY_TEXT } from "@/lib/reasons";

const OUTCOME_TEXT: Record<CarriedFinding["outcome"], string> = {
  grew: "still here, and larger",
  shrank: "still here, but smaller",
  unchanged: "still here, about the same",
  resolved: "not a finding this month",
};

/**
 * What happened to last month's findings.
 *
 * This is the only part of the report that can show the product did anything. Every other section
 * describes one file; this one says "you were told to look at ECS, and here is what it did". It
 * states outcomes and never claims credit for them: a bill cannot show that a change was caused by
 * reading a report.
 */
export function SinceLastSnapshot({ history, currency }: { history: SnapshotHistory; currency: string | null }) {
  const { carried, resolved, previousMonth, newCount } = history;
  const when = previousMonth ? monthLabel(previousMonth) : "your last snapshot";

  return (
    <section className="mt-8 rounded-xl border border-border p-5" aria-labelledby="since-heading">
      <h2 id="since-heading" className="text-xl font-semibold">
        Since {when}
      </h2>
      <p className="mt-1 text-sm text-muted">
        Matched to your previous snapshot by what each finding is about. Amounts are what your files
        say; whether anything here changed because of the report is not something a bill can show.
      </p>

      <ul className="mt-4 space-y-3 text-sm">
        {resolved.map((f) => (
          <li key={f.findingKey} className="rounded-lg bg-subtle p-3">
            <p className="font-medium">
              {f.title} — <span className="text-foreground">no longer a finding</span>
            </p>
            <p className="mt-0.5 text-muted">
              {monthLabel(f.previousMonth ?? "")} said {CATEGORY_TEXT[f.previousCategory] ?? f.previousCategory}
              {f.previousCurrent && <> at {money(f.previousCurrent, currency)} a month</>}. It is not material
              this month.
            </p>
          </li>
        ))}
        {carried.map((f) => (
          <li key={f.findingKey} className="rounded-lg bg-subtle p-3">
            <p className="font-medium">
              {f.title} — <span className="text-foreground">{OUTCOME_TEXT[f.outcome]}</span>
            </p>
            <p className="mt-0.5 text-muted">
              {CATEGORY_TEXT[f.previousCategory] ?? f.previousCategory} last time
              {f.previousCurrent && <> at {money(f.previousCurrent, currency)} a month</>}
              {f.currentCurrent && <>, now {money(f.currentCurrent, currency)}</>}.
            </p>
          </li>
        ))}
      </ul>

      {newCount > 0 && (
        <p className="mt-3 text-sm text-muted">
          {newCount} finding{newCount === 1 ? " is" : "s are"} new since {when}.
        </p>
      )}
      {carried.length === 0 && resolved.length === 0 && (
        <p className="mt-3 text-sm text-muted">Nothing from that snapshot is still a finding.</p>
      )}
    </section>
  );
}
