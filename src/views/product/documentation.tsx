"use client";
import Link from "next/link";
import { useState } from "react";
import { Glyph, type GlyphName } from "@/views/proviso/glyph";
import { Icon } from "@/views/proviso/shared";
import {
  productLinks,
  ProductShell,
  ProductHero,
  ProductSection,
  ProductCTA,
} from "./site-shell";

const services = [
  [
    "writer",
    "compose",
    "Text → confirmed rules",
    "Produces a DSL draft, readable rendering, validation results, and an ambiguity list. No ambiguous phrase should silently become a live action.",
    "idea.draft",
  ],
  [
    "stamper",
    "proof",
    "Signature → chain commitment",
    "Relays the owner-signed stamp and tracks signed-at separately from stamped-at. Coordinates entry and exit reveal workflows.",
    "idea.stamp",
  ],
  [
    "evaluator",
    "signal",
    "Inputs → condition state",
    "Decrypts the encrypted specification to an attested key, applies state machines and source checks, and emits condition state and trigger flags.",
    "Internal evaluation service",
  ],
  [
    "executor",
    "position",
    "Confirmed fire → order attempt",
    "Signer enclave for Hyperliquid; swap-key bundler for Robinhood Chain. Enforces limits, reduce-only exits, and partial-fill handling.",
    "idea.stop / execution services",
  ],
  [
    "fair-copy",
    "copy",
    "Eligible follows → ordered waves",
    "Coordinates caps, follower acknowledgements, caller orders, shared exit references, backstops, and outside-close detection.",
    "follow.create",
  ],
  [
    "tester",
    "replay",
    "Rule + snapshots → replay",
    "Runs deterministic 90-day history and returns trigger times, simulated fills, P&L, drawdown, and a reproducible test ID.",
    "idea.test",
  ],
  [
    "stamps",
    "records",
    "Events → evidence",
    "Assigns per-idea sequence numbers, builds event leaves and hourly roots, and serves Merkle proofs.",
    "stamp.proof / records.get",
  ],
  [
    "shares",
    "fees",
    "Qualifying fees → funded claims",
    "Evaluates qualification, excludes flagged links, funds USDG epochs, and prepares caller claim proofs.",
    "CallerShare contract",
  ],
  [
    "routes",
    "route",
    "Funding intent → route",
    "Builds quotes and transaction routes between USDG and Hyperliquid USDC, with source refunds on failure.",
    "route.quote / route.build",
  ],
  [
    "notify",
    "activity",
    "Lifecycle events → messages",
    "Delivers push and Telegram notification requests. Retry semantics and delivery guarantees remain to be defined.",
    "Notification integration",
  ],
] as const;
export function Architecture() {
  const [active, setActive] = useState(0);
  const current = services[active];
  return (
    <ProductShell className="architecture-product">
      <ProductHero
        index="DOCS"
        kicker="Architecture"
        title={
          <>
            A system you
            <br />
            can inspect.
          </>
        }
        description="The service architecture separates the idea, the permission to act, the execution attempt, and the evidence. Each boundary has a defined responsibility."
      >
        <div className="p-architecture-hero">
          <div>
            <span>DEVICE</span>
            <b>Intent + owner signature</b>
          </div>
          <i />
          <div>
            <span>SERVICES</span>
            <b>Evaluate + execute</b>
          </div>
          <i />
          <div>
            <span>CHAIN</span>
            <b>Commit + verify</b>
          </div>
        </div>
      </ProductHero>
      <ProductSection
        number="01"
        label="Service explorer"
        title={
          <>
            Different jobs.
            <br />
            Explicit boundaries.
          </>
        }
      >
        <div className="p-service-explorer">
          <nav aria-label="Architecture services">
            {services.map(([name, icon], i) => (
              <button
                key={name}
                aria-pressed={active === i}
                onClick={() => setActive(i)}
              >
                <Glyph name={icon as GlyphName} size={22} />
                {name}
                <span>{String(i + 1).padStart(2, "0")}</span>
              </button>
            ))}
          </nav>
          <article>
            <Glyph name={current[1] as GlyphName} size={52} />
            <span className="eyebrow">
              SERVICE / {current[0].toUpperCase()}
            </span>
            <h3>{current[2]}</h3>
            <p>{current[3]}</p>
            <div>
              <span>INTERFACE</span>
              <code>{current[4]}</code>
            </div>
          </article>
        </div>
      </ProductSection>
      <ProductSection
        number="02"
        label="The data & trust model"
        title={
          <>
            Store the record.
            <br />
            Protect the rule.
          </>
        }
        className="p-dark-section"
      >
        <div className="p-prose-columns">
          <article>
            <h3>Client responsibilities.</h3>
            <p>
              The device owns canonicalization, secure salts, commitment
              generation, signing, and the encrypted recovery export. The
              owner’s main key is never passed to Proviso.
            </p>
          </article>
          <article>
            <h3>Encrypted specifications.</h3>
            <p>
              The database stores enc_spec encrypted to the evaluator enclave’s
              attested key. The evaluator necessarily decrypts inside its
              isolated environment. Plaintext specifications and salts must not
              leak into ordinary storage or logs.
            </p>
          </article>
          <article>
            <h3>Operational entities.</h3>
            <p>
              Users, agent keys, swap policies, theses, fires, orders, follows,
              stamps, caller shares, link flags, and funding routes form the
              data model.
            </p>
          </article>
          <article>
            <h3>State has several dimensions.</h3>
            <p>
              Thesis state, position state, reveal state, and evidence status
              should be modelled separately. A fire, a fill, a reveal, and a
              posted root are related events, not interchangeable successes.
            </p>
          </article>
        </div>
        <div className="p-stack-labels">
          {[
            "Bun",
            "Hono",
            "tRPC v11",
            "Drizzle",
            "Postgres + Timescale",
            "Redis + BullMQ",
            "viem",
            "Foundry",
          ].map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </ProductSection>
      <ProductSection
        number="03"
        label="Contracts"
        title={
          <>
            Small contracts.
            <br />
            Specific responsibilities.
          </>
        }
      >
        <div className="p-contract-list">
          {[
            [
              "ThesisSeal",
              "Owner-signed commitments, reveal types, retirement, nonces, and deadlines.",
              "seal · revealEntry · revealExit · retire",
            ],
            [
              "StampRoots",
              "Hourly roots and leaf counts; poster-key rotation by a 2-of-3 multisig.",
              "post",
            ],
            [
              "CallerShare",
              "Funded USDG epochs and caller-directed claims with Merkle proofs.",
              "postEpoch · claim",
            ],
            [
              "ProvisoSwapAdapter",
              "The only allowed swap target, constrained by signed policy and oracle bounds.",
              "swap",
            ],
          ].map(([name, body, methods], i) => (
            <article key={name}>
              <span>0{i + 1}</span>
              <div>
                <h3>{name}</h3>
                <p>{body}</p>
              </div>
              <code>{methods}</code>
            </article>
          ))}
        </div>
        <p className="p-small">
          The contract model separates commitments, evidence roots, claims, and
          constrained swaps. Verify addresses and permissions before authorizing
          a transaction.
        </p>
      </ProductSection>
      <ProductSection
        number="04"
        label="Operating principles"
        title={
          <>
            Define the boundary.
            <br />
            Inspect every decision.
          </>
        }
      >
        <div className="p-gate-list">
          {[
            [
              "Writer quality",
              "An ambiguous instruction needs a decision from its author. Readable rules make that decision explicit.",
            ],
            [
              "Signer policy",
              "Every order must belong to a confirmed, live idea and remain within the owner’s approved limits.",
            ],
            [
              "Swap confinement",
              "Only the permitted adapter, pool keys, and exact approvals belong inside the swap policy.",
            ],
            [
              "Fair Copy ordering",
              "Follower submissions precede the linked caller, with acknowledgements and timestamps preserving the sequence.",
            ],
            [
              "Plaintext handling",
              "Specifications and salts must stay out of ordinary application storage and logs.",
            ],
          ].map(([a, b], i) => (
            <div key={a}>
              <span>G0{i + 1}</span>
              <h3>{a}</h3>
              <p>{b}</p>
              <Icon name="diagonal" size={15} />
            </div>
          ))}
        </div>
      </ProductSection>
      <ProductCTA
        title="Connect the whole picture."
        body="Explore the principles that connect each service to the thesis lifecycle."
        href="/docs/"
        label="Explore the guide library"
      />
    </ProductShell>
  );
}

export function DocsHub() {
  const [query, setQuery] = useState("");
  const links = [
    ...productLinks,
    [
      "/docs/architecture/",
      "Architecture",
      "Services, contracts, and trust boundaries",
      "architecture",
    ] as [string, string, string, GlyphName],
  ];
  const filtered = links.filter(([, title, body]) =>
    `${title} ${body}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <ProductShell className="docs-hub">
      <ProductHero
        index="LIBRARY"
        kicker="Documentation"
        title={
          <>
            The whole idea.
            <br />
            In full.
          </>
        }
        description="The rules, the commitments, and the systems behind thesis trading. Explore the complete product, one connected guide at a time."
      >
        <div className="p-doc-index">
          <span className="eyebrow">PROVISO / KNOWLEDGE INDEX</span>
          <strong>09</strong>
          <span>connected guides</span>
          <div>
            <Glyph name="records" size={32} />
            <span>
              FROM THE FIRST RULE
              <br />
              TO THE FINAL RECORD
            </span>
          </div>
        </div>
      </ProductHero>
      <section
        className="p-doc-library"
        id="guide-library"
        data-chapter="The guide library"
      >
        <div className="p-library-toolbar">
          <h2>Choose your next chapter.</h2>
          <label>
            <Icon name="menu" size={18} />
            <input
              aria-label="Search documentation"
              placeholder="Find a topic…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        <div className="p-doc-grid">
          {filtered.map(([href, title, body, icon], i) => (
            <Link key={href} href={href}>
              <div>
                <Glyph name={icon} size={35} />
                <span>{String(i + 1).padStart(2, "0")}</span>
              </div>
              <h3>{title}</h3>
              <p>{body}</p>
              <span className="doc-read">
                Read the guide <Icon name="diagonal" size={17} />
              </span>
            </Link>
          ))}
        </div>
        {!filtered.length && (
          <p className="p-search-empty">
            No matching guides. Try “rules”, “security”, “records”, or
            “architecture”.
          </p>
        )}
      </section>
      <section
        className="p-reading-path"
        id="reading-path"
        data-chapter="Find your starting point"
      >
        <div>
          <span className="eyebrow">A GUIDED PATH</span>
          <h2>
            Start with the idea.
            <br />
            Follow it all the way through.
          </h2>
        </div>
        <div>
          {[
            [
              "01",
              "Define the thesis",
              "Conditions, actions, exits, and expiry.",
              "/protocol/",
              "compose",
            ],
            [
              "02",
              "Understand the commitment",
              "What is sealed, what is revealed, and when.",
              "/proof-of-call/",
              "proof",
            ],
            [
              "03",
              "Inspect the boundaries",
              "Account authority, execution checks, and your limits.",
              "/security/",
              "privacy",
            ],
          ].map(([n, title, body, href, icon]) => (
            <Link key={n} href={href}>
              <span>{n}</span>
              <Glyph name={icon as GlyphName} size={25} />
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
              <Icon name="diagonal" size={17} />
            </Link>
          ))}
        </div>
      </section>
      <ProductSection
        number="WORKSPACE"
        label="Put the principles to work"
        title={
          <>
            A place for
            <br />
            every decision.
          </>
        }
      >
        <div className="p-availability">
          <article>
            <span className="eyebrow">YOUR THESIS DESK</span>
            <h3>Give conviction a structure.</h3>
            <p>
              Write a thesis, inspect every condition, set your limits, and keep
              your working ideas in one place.
            </p>
            <Link href="/dashboard/">
              Open the workspace <Icon name="arrow" size={16} />
            </Link>
          </article>
          <article>
            <span className="eyebrow">THE SYSTEM BEHIND IT</span>
            <h3>Understand each boundary.</h3>
            <p>
              Follow the path from confirmed rules to permission checks,
              execution attempts, and a verifiable event sequence.
            </p>
            <Link href="/docs/architecture/">
              Explore the architecture <Icon name="arrow" size={16} />
            </Link>
          </article>
        </div>
      </ProductSection>
    </ProductShell>
  );
}
