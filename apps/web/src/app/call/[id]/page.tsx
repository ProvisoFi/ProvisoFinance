import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { chainConfig } from "@proviso/chain";
import { callStatus, callUrl, shortAddr } from "@/lib/proviso/call";
import { getCall } from "@/lib/server/call";
import { Mark } from "@/views/proviso/shared";
import { ShareCall } from "@/views/workspace/share-call";

export const revalidate = 60;

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const c = await getCall(id);
  if (!c) return { title: "Call not found" };
  const s = callStatus(c);
  const title = `Sealed call #${c.id} · ${s.label}`;
  const description = `${s.line}. Sealed on ${chainConfig().label} by ${shortAddr(c.owner)}: the rule stays private until it fires, and nobody can edit it.`;
  return {
    title,
    description,
    alternates: { canonical: callUrl(c.id) },
    openGraph: {
      title,
      description,
      url: callUrl(c.id),
      type: "article",
      images: [{ url: `${callUrl(c.id)}card.png`, width: 1200, height: 630, alt: "A sealed call on Proviso" }],
    },
    twitter: { card: "summary_large_image", title, description, images: [`${callUrl(c.id)}card.png`] },
  };
}

const when = (d: string | Date) =>
  new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

export default async function CallPage({ params }: Props) {
  const { id } = await params;
  const c = await getCall(id);
  if (!c) notFound();
  const s = callStatus(c);
  const explorer = chainConfig().chain.blockExplorers?.default.url;
  const tx = (h: string | null) =>
    h && explorer ? (
      <a href={`${explorer}/tx/${h}`} target="_blank" rel="noopener noreferrer">
        {h.slice(0, 10)}…{h.slice(-6)}
      </a>
    ) : (
      "—"
    );
  const rows: [string, React.ReactNode][] = [
    ["Caller", shortAddr(c.owner)],
    ["Sealed", when(c.stampedAt)],
    ["Expires", when(c.expiresAt)],
    ["Mode", c.mode === "alert" ? "Alert only" : "Live trading"],
    ["Seal transaction", tx(c.sealTx)],
    ...(c.revealKind ? ([["Revealed", <>{c.revealKind.toLowerCase()} · {tx(c.revealTx)}</>]] as [string, React.ReactNode][]) : []),
  ];
  return (
    <main className="call-page">
      <header className="call-top">
        <Link href="/" className="call-brand" aria-label="Proviso home">
          <Mark className="call-mark" /> Proviso
        </Link>
        <Link href="/dashboard/compose/" className="call-cta">
          Write your own call
        </Link>
      </header>
      <article className="call-card">
        <span className="call-eyebrow">SEALED CALL #{c.id}</span>
        <h1>
          <span className="call-state">{s.label}</span>
          {s.line}
        </h1>
        <p className="call-why">
          This call was sealed on {chainConfig().label} before it could fire. The rule stays private until it does, then it
          is revealed and checked against the seal. Nobody can edit or backdate it, not even its caller.
        </p>
        <dl className="call-facts">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <ShareCall id={c.id} state={c.state} />
      </article>
      <p className="call-foot">WRITE. SEAL. PROVE.</p>
    </main>
  );
}
