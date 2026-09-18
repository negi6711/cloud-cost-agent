/**
 * The example snapshot from docs/product-spec.md §4. Synthetic content, labelled as such; it is the
 * only snapshot shown without login.
 */
export function SampleSnapshot() {
  return (
    <article
      aria-label="Example Cloud Cost Decision Snapshot"
      className="rounded-xl border border-border bg-white shadow-sm"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-semibold tracking-wide text-amber-900">
          REQUEST EVIDENCE
        </span>
        <span className="text-xs text-muted">Example · synthetic data</span>
      </header>

      <div className="space-y-5 px-5 py-5 text-sm leading-6">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Fact label="Spend change" value="+$1,840/month" />
          <Fact label="Area" value="shared ECS services" />
          <Fact label="Likely owner" value="Platform Engineering" />
        </dl>

        <Section title="What changed">
          A new service family appeared in the latest period and represents 18% of the increase.
        </Section>

        <Section title="What we know">
          <ul className="list-disc space-y-1 pl-5">
            <li>Increase is concentrated in one AWS account.</li>
            <li>No team allocation tag was present.</li>
            <li>Billing evidence confirms the change.</li>
          </ul>
        </Section>

        <Section title="What is missing">
          CloudWatch utilization and confirmation that the service is production-critical.
        </Section>

        <Section title="Safest next action">
          Confirm owner and collect utilization evidence before considering a cost change.
        </Section>
      </div>

      <footer className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border px-5 py-3 text-xs text-muted">
        <span>
          Risk: <strong className="text-foreground">Low</strong>
        </span>
        <span>
          Status: <strong className="text-foreground">Awaiting human review</strong>
        </span>
      </footer>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-subtle px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h4>
      <div>{children}</div>
    </section>
  );
}
