"use client";
import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/views/proviso/shared";
import { Glyph } from "@/views/proviso/glyph";
import {
  ProductShell,
  ProductHero,
  ProductSection,
  ProductCTA,
} from "./site-shell";

export const conditions = [
  [
    "price",
    "Market price",
    "Hyperliquid or Robinhood Chain price against a defined threshold.",
    "Market",
    "~5 seconds",
  ],
  [
    "funding",
    "Funding rate",
    "A funding comparison on a specified perpetual market.",
    "Market",
    "Stream / ~5 seconds",
  ],
  [
    "oi",
    "Open interest",
    "Open-interest conditions using venue data.",
    "Market",
    "Stream / ~5 seconds",
  ],
  [
    "change",
    "Price change",
    "A price movement over an explicitly defined window.",
    "Market",
    "Underlying feed",
  ],
  [
    "fear_greed",
    "Fear & Greed",
    "A threshold on a sentiment index.",
    "Context",
    "15 minutes",
  ],
  [
    "time_window",
    "Time window",
    "An explicit operating window; timezone and semantics must be confirmed.",
    "Context",
    "Clock-based",
  ],
  [
    "market_session",
    "Market session",
    "US market open or closed context for Stock Tokens.",
    "Stock Tokens",
    "60 seconds",
  ],
  [
    "earnings_window",
    "Earnings window",
    "Calendar context around an earnings event. Provider not yet selected.",
    "Stock Tokens",
    "Daily",
  ],
  [
    "corporate_action",
    "Corporate action",
    "Stock Token corporate-action context.",
    "Stock Tokens",
    "60 seconds",
  ],
  [
    "gap",
    "Cross-venue gap",
    "A Stock Token and corresponding perpetual, each independently price-checked.",
    "Stock Tokens",
    "~5 seconds",
  ],
  [
    "post",
    "X-post text",
    "String matching on a bounded list of accounts; confirmation before trading by default.",
    "Later",
    "30–60 seconds target",
  ],
];
const lifecycle = [
  [
    "Write",
    "Describe the idea.",
    "Plain English becomes a proposed rule. The writer returns readable conditions, actions, and any ambiguity that needs your decision.",
  ],
  [
    "Review & test",
    "Read every clause.",
    "Check market, units, allocation, leverage, exit, mode, and expiry. A strategy replay adds a 90-day historical view before you decide.",
  ],
  [
    "Seal",
    "Commit before the outcome.",
    "Your device creates separate entry and exit commitments. You sign the stamp; a relayer records it on Robinhood Chain.",
  ],
  [
    "Evaluate",
    "Wait for the right conditions.",
    "The evaluator applies source-specific freshness checks, price agreement, liquidity rules, and the confirmed expression.",
  ],
  [
    "Act or alert",
    "Follow the approved intent.",
    "An alert-only idea sends a notification. A live idea attempts execution under approved permissions and limits. Nothing runs merely because you wrote it.",
  ],
  [
    "Reveal & record",
    "Keep the entire sequence.",
    "Entry reveals at fire; exit reveals at close. Unfired, expired, and retired ideas remain part of the record.",
  ],
];
export function Protocol() {
  const [filter, setFilter] = useState("All");
  return (
    <ProductShell className="protocol-page">
      <ProductHero
        index="01"
        kicker="The protocol"
        title={
          <>
            A thesis.
            <br />
            With every clause.
          </>
        }
        description="A market idea becomes useful when its conditions, consequences, and limits are explicit. Proviso brings that whole sequence into one place."
      >
        <div className="p-rule-manuscript">
          <div>
            <span>THESIS / 001</span>
            <Glyph name="compose" size={28} />
          </div>
          <p>
            “If funding turns negative
            <br />
            while price holds above $40…”
          </p>
          <div className="p-manuscript-rule">
            <b>WHEN</b>
            <code>funding(HYPE) &lt; 0</code>
          </div>
          <div className="p-manuscript-rule">
            <b>AND</b>
            <code>price(HYPE) &gt; 40</code>
          </div>
          <div className="p-manuscript-rule">
            <b>THEN</b>
            <code>long HYPE · 3×</code>
          </div>
          <div className="p-manuscript-rule">
            <b>EXIT</b>
            <code>stop −6% · take +15%</code>
          </div>
          <small>READABLE RULE / YOUR CONFIRMATION</small>
        </div>
      </ProductHero>
      <ProductSection
        number="01"
        label="The complete sequence"
        title={
          <>
            One continuous
            <br />
            line of intent.
          </>
        }
      >
        <div className="p-lifecycle-story">
          {lifecycle.map(([label, title, body], i) => (
            <article key={label}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <div>
                <span className="eyebrow">{label}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </article>
          ))}
        </div>
      </ProductSection>
      <ProductSection
        id="language"
        number="02"
        label="The rule language"
        title={
          <>
            Give the idea
            <br />
            its vocabulary.
          </>
        }
        className="p-dark-section"
      >
        <div className="p-filter-tabs" aria-label="Condition category">
          {["All", "Market", "Context", "Stock Tokens", "Later"].map((f) => (
            <button
              key={f}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="p-condition-catalog">
          {conditions
            .filter((c) => filter === "All" || c[3] === filter)
            .map(([code, title, body, , cadence], i) => (
              <article key={code}>
                <span className="condition-index">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <code>{code}</code>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
                <span>{cadence}</span>
              </article>
            ))}
        </div>
        <p className="p-small">
          These are specification targets, not live feed measurements. Faster
          evaluation cannot make a daily calendar or 15-minute index fresh every
          five seconds.
        </p>
      </ProductSection>
      <ProductSection
        number="03"
        label="Composition & action"
        title={
          <>
            Simple parts.
            <br />
            Precise meaning.
          </>
        }
      >
        <div className="p-language-grid">
          <article>
            <Glyph name="protocol" size={34} />
            <h3>Compose the condition.</h3>
            <dl>
              <div>
                <dt>ALL</dt>
                <dd>Every condition must hold.</dd>
              </div>
              <div>
                <dt>ANY</dt>
                <dd>At least one condition must hold.</dd>
              </div>
              <div>
                <dt>NOT</dt>
                <dd>Negate a condition.</dd>
              </div>
              <div>
                <dt>AFTER</dt>
                <dd>
                  A temporal combinator; detailed semantics remain to be
                  defined.
                </dd>
              </div>
            </dl>
          </article>
          <article>
            <Glyph name="position" size={34} />
            <h3>Choose the consequence.</h3>
            <dl>
              <div>
                <dt>hl.open</dt>
                <dd>Open a perpetual position.</dd>
              </div>
              <div>
                <dt>hl.close / reduce</dt>
                <dd>Close or reduce a position.</dd>
              </div>
              <div>
                <dt>hl.spot</dt>
                <dd>Hyperliquid spot action.</dd>
              </div>
              <div>
                <dt>rhc.swap</dt>
                <dd>
                  Allow-listed Robinhood Chain swap, subject to route and
                  account availability.
                </dd>
              </div>
            </dl>
          </article>
        </div>
        <div className="p-validation-band">
          <h3>Nothing vague becomes a live rule.</h3>
          <p>
            The design validates the schema, market existence, size, and
            leverage. The cap is the lowest of the user limit, market maximum,
            and 10×. Expiry is never more than 30 days. Ambiguities must come
            back to the owner.
          </p>
        </div>
      </ProductSection>
      <ProductCTA
        title="Start with a condition."
        body="Build a thesis, inspect the readable rules, and save a working thesis."
        href="/dashboard/compose/"
        label="Write your first thesis"
      />
    </ProductShell>
  );
}
