import { CATEGORY_STYLE, CATEGORY_TEXT, notableReasons, reasonText } from "@/lib/reasons";
import type { FindingView } from "@/lib/snapshot-detail";

interface Props {
  finding: FindingView;
  /** e.g. "TypeSafe Jev (jev-1.13.0)" or "Test classifier (not a real model)". Null when none ran. */
  modelLabel: string | null;
}

/**
 * One decision card. Sections are labelled by where their content comes from:
 * facts calculated from the file, the model's suggestion, our rules, and human review.
 */
export function FindingCard({ finding: f, modelLabel }: Props) {
  const overridden = f.model && f.model.category !== f.finalCategory;
  // The report says once, at the top, that every finding needs human confirmation. This footer is
  // for the reasons that single THIS finding out; when there are none, it stays quiet.
  const reasons = notableReasons(f.policyReasons, f.model?.confidence ?? null);
  return (
    <article
      aria-label={f.title}
      className="rounded-xl border border-border bg-white shadow-sm"
      data-testid="finding-card"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <span className={`rounded-md px-2 py-1 text-xs font-semibold tracking-wide uppercase ${CATEGORY_STYLE[f.finalCategory] ?? ""}`}>
          {CATEGORY_TEXT[f.finalCategory] ?? f.finalCategory}
        </span>
        <span className="text-xs text-muted">
          #{f.rank} · {f.severity} severity
        </span>
      </header>

      <div className="space-y-5 px-5 py-5 text-sm leading-6">
        <h3 className="text-base font-semibold">{f.title}</h3>

        <Section title="What changed" source="Calculated from your file">
          <p>{f.whatChanged}</p>
        </Section>

        <Section title="What we know" source="Calculated from your file">
          <ul className="list-disc space-y-1 pl-5">
            {f.whatWeKnow.map((s) => (
              <li key={s.text}>{s.text}</li>
            ))}
          </ul>
        </Section>

        <Section title="What is missing">
          <ul className="list-disc space-y-1 pl-5">
            {f.missing.map((m) => (
              <li key={m.code}>{m.label}</li>
            ))}
          </ul>
        </Section>

        <Section title="Safest next action">
          <p>{f.nextAction}</p>
        </Section>

        <section className="rounded-lg bg-subtle p-4" aria-label="Classification">
          <h4 className="text-xs font-semibold tracking-wide text-muted uppercase">Classification</h4>
          {f.model && modelLabel ? (
            <div className="mt-1 space-y-1">
              <p>
                Model-assisted · {modelLabel}: suggested{" "}
                <strong>{CATEGORY_TEXT[f.model.category] ?? f.model.category}</strong>
                {f.model.confidence !== null && ` (${Math.round(f.model.confidence * 100)}% confidence)`}.
              </p>
              <p className="text-muted">
                Likely owner: {f.model.ownerLabel ?? "unknown"} · urgency {f.model.urgency ?? "n/a"} · risk of acting
                without more evidence {f.model.risk ?? "n/a"}.
              </p>
              {f.ruleCategory && f.ruleCategory !== f.model.category && (
                <p className="text-muted">
                  Without the model, our rules alone would have said{" "}
                  <strong>{CATEGORY_TEXT[f.ruleCategory] ?? f.ruleCategory}</strong>.
                </p>
              )}
              {overridden && (
                <p>
                  Our rules set the category to <strong>{CATEGORY_TEXT[f.finalCategory]}</strong> instead.
                </p>
              )}
            </div>
          ) : (
            <p className="mt-1">Rule-based: no model classified this finding.</p>
          )}
          <p className="mt-2 text-xs text-muted">
            {f.explanationSource === "template"
              ? "The text above was written from a fixed template using only the calculated facts."
              : `Explanation: ${f.explanationSource}.`}{" "}
            Confidence values are the model&apos;s own estimate and are not yet calibrated.
          </p>
        </section>
      </div>

      {reasons.length > 0 && (
        <footer className="border-t border-border px-5 py-3 text-xs" aria-label="Human review">
          <p className="font-semibold text-foreground">Read this one with extra care</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
            {reasons.map((r) => (
              <li key={r}>{reasonText(r)}</li>
            ))}
          </ul>
        </footer>
      )}
    </article>
  );
}

function Section({ title, source, children }: { title: string; source?: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs font-semibold tracking-wide text-muted uppercase">
        {title}
        {source && <span className="font-normal normal-case tracking-normal">· {source}</span>}
      </h4>
      {children}
    </section>
  );
}
