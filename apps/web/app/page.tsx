import { QualificationForm } from "@/components/qualification-form";
import { SampleSnapshot } from "@/components/sample-snapshot";

// Copy is taken from docs/product-spec.md §4. No logos, savings figures, or autonomy claims.

export default function Home() {
  return (
    <main className="flex-1">
      <Hero />
      <Problem />
      <Steps />
      <Example />
      <Audience />
      <Faq />
      <GetSnapshot />
      <footer className="border-t border-border py-8 text-center text-xs text-muted">
        Cloud Cost Decision Snapshot · AWS-first · Read-only · Decision support, not guaranteed savings
      </footer>
    </main>
  );
}

function Container({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-5xl px-4 sm:px-6 ${className}`}>{children}</div>;
}

function Hero() {
  return (
    <section className="border-b border-border bg-subtle">
      <Container className="py-16 sm:py-24">
        <p className="mb-4 text-sm font-medium text-accent">Cloud Cost Decision Snapshot · AWS</p>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Turn your AWS bill into decisions, not dashboards.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-muted">
          Upload your AWS billing data and receive a ranked Cloud Cost Decision Snapshot showing what
          changed, why it changed, who owns it, what action is safest, and what evidence is missing.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <a
            href="#get-snapshot"
            className="rounded-lg bg-accent px-5 py-3 text-center font-semibold text-accent-foreground hover:opacity-90"
          >
            Get my free Cloud Cost Decision Snapshot
          </a>
          <a
            href="#example"
            className="rounded-lg border border-border bg-white px-5 py-3 text-center font-semibold hover:bg-subtle"
          >
            View an example snapshot
          </a>
        </div>
        <p className="mt-6 text-sm text-muted">
          Read-only by default. No AWS credentials required for the first review. No automatic
          infrastructure changes.
        </p>
      </Container>
    </section>
  );
}

function Problem() {
  const items = [
    "what caused the change;",
    "whether it was intentional;",
    "which team owns it;",
    "whether the action is safe;",
    "what evidence is missing;",
    "whether the fix actually worked.",
  ];
  return (
    <section>
      <Container className="py-16">
        <h2 className="text-2xl font-semibold">Your bill changed. Your team still has to figure out:</h2>
        <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <li key={item} className="rounded-lg border border-border px-4 py-3">
              {item}
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}

function Steps() {
  const steps = [
    ["Upload", "an AWS billing export."],
    ["Understand", "the highest-impact cost changes and evidence gaps."],
    ["Decide", "what to investigate, monitor, approve, or escalate."],
  ] as const;
  return (
    <section className="border-y border-border bg-subtle">
      <Container className="py-16">
        <ol className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {steps.map(([title, text], i) => (
            <li key={title}>
              <span className="text-sm font-semibold text-accent">Step {i + 1}</span>
              <p className="mt-1">
                <strong>{title}</strong> {text}
              </p>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}

function Example() {
  return (
    <section id="example" className="scroll-mt-8">
      <Container className="grid grid-cols-1 gap-10 py-16 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <h2 className="text-2xl font-semibold">A decision, not a chart</h2>
          <p className="mt-4 leading-7 text-muted">
            Each finding says what changed, what the billing data proves, what is still missing, and
            the safest next step. Billing data alone cannot prove that resizing or deleting anything is
            safe, so the snapshot never recommends it.
          </p>
          <p className="mt-4 text-sm leading-6 text-muted">
            Numbers come from deterministic calculations on your file. Classification is model-assisted
            and marked as such, and every finding stays open to human review.
          </p>
        </div>
        <div className="lg:col-span-3">
          <SampleSnapshot />
        </div>
      </Container>
    </section>
  );
}

function Audience() {
  const builtFor = [
    "SaaS engineering teams",
    "AI and ML infrastructure teams",
    "API and developer-tool companies",
    "data-heavy software companies",
    "platform, DevOps, SRE, FinOps, and technical finance teams",
  ];
  const bestFit = [
    "AWS is material to your business",
    "your cloud spend changes frequently",
    "nobody owns a full-time FinOps function",
    "AWS Cost Explorer alone does not tell you what to do next",
  ];
  const notFor = [
    "tiny AWS bills with no recurring cost problem",
    "teams looking for autonomous production changes",
    "companies requiring GCP/Azure/Kubernetes support on day one",
    "customers expecting guaranteed savings",
  ];
  return (
    <section className="border-y border-border bg-subtle">
      <Container className="grid grid-cols-1 gap-8 py-16 md:grid-cols-3">
        <List title="Built for" items={builtFor} />
        <List title="Best fit" items={bestFit} />
        <List title="Not for" items={notFor} />
      </Container>
    </section>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-muted">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Faq() {
  const faqs = [
    [
      "Do you need AWS credentials?",
      "No. MVP 0 accepts a redacted AWS Cost Explorer CSV. A future production connector will use a documented read-only role.",
    ],
    [
      "Will the product change my infrastructure?",
      "No. MVP 0 is read-only. Every consequential action will require explicit human approval.",
    ],
    [
      "Is this another cloud-cost dashboard?",
      "No. The intended output is a short decision snapshot with evidence, owner, risk, missing information, and next action.",
    ],
    [
      "Can I upload sensitive billing data?",
      "Upload only data you are permitted to share; redacted files are supported. The raw file is kept for 30 days unless you delete it sooner. Model-assisted classification uses a minimized summary with account names and IDs removed, never the raw file, and only if you agree at upload.",
    ],
  ] as const;
  return (
    <section>
      <Container className="py-16">
        <h2 className="text-2xl font-semibold">Questions</h2>
        <dl className="mt-6 divide-y divide-border border-y border-border">
          {faqs.map(([q, a]) => (
            <div key={q} className="py-5">
              <dt className="font-medium">{q}</dt>
              <dd className="mt-2 text-sm leading-6 text-muted">{a}</dd>
            </div>
          ))}
        </dl>
      </Container>
    </section>
  );
}

function GetSnapshot() {
  return (
    <section id="get-snapshot" className="scroll-mt-8 border-t border-border bg-subtle">
      <Container className="py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-2xl font-semibold">Get your free Cloud Cost Decision Snapshot</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Tell us a little about your team. You can upload an AWS billing export on the next step, or
            ask for a manual review instead.
          </p>
          <div className="mt-8 rounded-xl border border-border bg-white p-5 sm:p-8">
            <QualificationForm />
          </div>
        </div>
      </Container>
    </section>
  );
}
