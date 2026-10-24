import type { Metadata } from "next";
import Link from "next/link";
import { TOOLS } from "@proviso/api/mcp";
import { Mark } from "@/views/proviso/shared";

export const metadata: Metadata = {
  title: "Proviso for AI agents",
  description:
    "Connect any AI assistant to Proviso over MCP: it can research markets, draft a rule, Dry Run it and check it. Only you can seal it, with your own wallet.",
  alternates: { canonical: "https://provisofi.com/agents/" },
};

const URL = "https://provisofi.com/api/mcp/";
const CONFIG = JSON.stringify({ mcpServers: { proviso: { url: URL } } }, null, 2);

export default function AgentsPage() {
  return (
    <main className="call-page">
      <header className="call-top">
        <Link href="/" className="call-brand" aria-label="Proviso home">
          <Mark className="call-mark" /> Proviso
        </Link>
        <Link href="/dashboard/dry-run/" className="call-cta">
          Try a Dry Run
        </Link>
      </header>
      <article className="call-card">
        <span className="call-eyebrow">PROVISO FOR AI AGENTS · MCP</span>
        <h1>The AI proposes. The seal constrains.</h1>
        <p className="call-why">
          Connect your AI assistant to Proviso and it can look up markets and records, turn your idea into a rule, replay it over 90
          days and check it for mistakes. It can&apos;t seal, trade, sign or hold a key. When the rule is ready, it hands you a link: you read
          the rule back and seal it on Robinhood Chain with your own wallet. After that, nobody can change it, the AI included.
        </p>
        <dl className="call-facts">
          <div>
            <dt>Server URL</dt>
            <dd>
              <code>{URL}</code>
            </dd>
          </div>
          <div>
            <dt>Transport</dt>
            <dd>Streamable HTTP, no sign-in or API key</dd>
          </div>
          <div>
            <dt>Can</dt>
            <dd>Read markets, records and the Arena; draft, Dry Run and check rules; prepare a seal link</dd>
          </div>
          <div>
            <dt>Can&apos;t</dt>
            <dd>Seal, trade, move money, sign, or change a sealed rule</dd>
          </div>
        </dl>
      </article>
      <section className="agents-setup" aria-label="Connect">
        <span className="call-eyebrow">CONNECT</span>
        <p className="call-why">
          In your assistant&apos;s connector or MCP settings, add a remote MCP server with the URL above. Apps that read an <code>mcp.json</code>{" "}
          file take:
        </p>
        <pre className="agents-code">{CONFIG}</pre>
        <p className="call-why">
          Then ask something like: &quot;Draft a Proviso rule that buys gold on a 2% daily dip at 2×, Dry Run it, check it, and give me the
          seal link.&quot;
        </p>
      </section>
      <section className="agents-tools" aria-label="Tools">
        <span className="call-eyebrow">TOOLS</span>
        <dl className="call-facts">
          {TOOLS.map((t) => (
            <div key={t.name}>
              <dt>
                <code>{t.name}</code>
              </dt>
              <dd>{t.description}</dd>
            </div>
          ))}
        </dl>
      </section>
      <p className="call-why leaderboard-note">
        Every tool runs the same public, rate-limited checks as the site. Results are simulations and records, not financial advice.
      </p>
      <p className="call-foot">WRITE. SEAL. PROVE.</p>
    </main>
  );
}
