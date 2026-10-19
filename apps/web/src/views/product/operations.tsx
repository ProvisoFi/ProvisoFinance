"use client";
import Link from "next/link";
import { useState } from "react";
import { Glyph } from "@/views/proviso/glyph";
import { Icon } from "@/views/proviso/shared";
import {
  ProductShell,
  ProductHero,
  ProductSection,
  ProductCTA,
} from "./site-shell";

const scenarios = [
  [
    "Valid inputs",
    "Confirmed rule → valid data → approved limits → attempt order",
    "A valid path reaches the signer. It does not guarantee a fill or a profitable result.",
  ],
  [
    "Stale or conflicting data",
    "Confirmed rule → failed source check → withhold execution",
    "Each input leg needs its own trustworthy reference. A 1% disagreement should prevent the evaluator from treating that leg as valid.",
  ],
  [
    "Thin market",
    "Confirmed rule → insufficient liquidity → withhold execution",
    "The design requires at least $250k Hyperliquid 24h volume or $100k Robinhood Chain pool depth.",
  ],
  [
    "One leg fills",
    "First leg fills → second leg fails → attempt unwind",
    "Multi-leg ideas are non-atomic. Unwinding can cost money and may itself face liquidity or execution failures.",
  ],
];
export function Execution() {
  const [scenario, setScenario] = useState(0);
  return (
    <ProductShell className="execution-product">
      <ProductHero
        index="04"
        kicker="Execution"
        title={
          <>
            A signal is not
            <br />
            an order. <em>Yet.</em>
          </>
        }
        description="Between a condition and a trade sits a series of checks: data quality, market depth, account permissions, and the exact limits you approved."
      >
        <div className="p-execution-gates">
          {[
            ["01", "CONFIRMED IDEA"],
            ["02", "VALID INPUTS"],
            ["03", "PERMISSION"],
            ["04", "SIGNER POLICY"],
          ].map(([n, t]) => (
            <div key={n}>
              <span>{n}</span>
              <strong>{t}</strong>
              <i />
            </div>
          ))}
          <span className="gate-output">
            ORDER ATTEMPT <Icon name="arrow" size={18} />
          </span>
        </div>
      </ProductHero>
      <ProductSection
        number="01"
        label="Signals move at different speeds"
        title={
          <>
            Freshness belongs
            <br />
            to the source.
          </>
        }
      >
        <div className="p-data-table">
          <div className="p-table-head">
            <span>INPUT</span>
            <span>INPUT SOURCE</span>
            <span>REFRESH TARGET</span>
          </div>
          {[
            [
              "Price / funding / OI",
              "Hyperliquid WebSocket + info API",
              "Stream, debounced to 5s",
            ],
            [
              "Robinhood Chain prices",
              "Uniswap v4 StateView + Chainlink",
              "5 seconds",
            ],
            [
              "Sessions / corporate actions",
              "Robinhood assets and market APIs",
              "60 seconds",
            ],
            ["Fear & Greed", "Public index API", "15 minutes"],
            ["Earnings", "Calendar vendor, not yet selected", "Daily"],
            [
              "Selected X accounts",
              "Cost-dependent API polling",
              "30–60 seconds, later stage",
            ],
          ].map(([a, b, c]) => (
            <div key={a}>
              <strong>{a}</strong>
              <span>{b}</span>
              <span>{c}</span>
            </div>
          ))}
        </div>
        <p className="p-small">
          Source freshness is part of the decision. Stale inputs, unavailable
          references, or market halts prevent an input from becoming a valid
          trigger.
        </p>
      </ProductSection>
      <section
        className="p-scenario"
        id="decision-paths"
        data-chapter="Decision paths"
      >
        <div>
          <span className="eyebrow">02 / DECISION PATHS</span>
          <h2>
            The checks
            <br />
            change the outcome.
          </h2>
          <div className="p-scenario-options">
            {scenarios.map(([title], i) => (
              <button
                key={title}
                aria-pressed={scenario === i}
                onClick={() => setScenario(i)}
              >
                <span>0{i + 1}</span>
                {title}
                <Icon name="arrow" size={15} />
              </button>
            ))}
          </div>
        </div>
        <article>
          <Glyph
            name={
              scenario === 0
                ? "position"
                : scenario === 1
                  ? "signal"
                  : scenario === 2
                    ? "funding"
                    : "exit"
            }
            size={45}
          />
          <span className="eyebrow">DECISION PATH</span>
          <h3>{scenarios[scenario][0]}</h3>
          <div className="scenario-path">
            {scenarios[scenario][1].split(" → ").map((s, i) => (
              <span key={s}>
                <b>0{i + 1}</b>
                {s}
              </span>
            ))}
          </div>
          <p>{scenarios[scenario][2]}</p>
        </article>
      </section>
      <ProductSection
        number="03"
        label="The signer boundary"
        title={
          <>
            Permission is narrow.
            <br />
            Enforcement is specific.
          </>
        }
      >
        <div className="p-prose-columns">
          <article>
            <h3>Only the confirmed idea.</h3>
            <p>
              The Hyperliquid signer policy requires an order to belong to a
              live thesis, stay within idea and global limits, and sit within 2%
              of mark. Stops and exits are reduce-only. Unrecognized order
              shapes must be refused.
            </p>
          </article>
          <article>
            <h3>One leg, one reference check.</h3>
            <p>
              Hyperliquid mark is compared with its oracle; a Robinhood pool is
              compared with Chainlink or another pool. A cross-venue gap may
              exist precisely because two independently valid prices differ.
            </p>
          </article>
          <article>
            <h3>Stop is a workflow.</h3>
            <p>
              The stop workflow closes idea positions with reduce-only orders
              and stops future operation. Order acknowledgements and fill status
              must remain visible; a click cannot promise an instantaneous
              market exit.
            </p>
          </article>
          <article>
            <h3>Closed sessions stay visible.</h3>
            <p>
              Stock Token prices carry a closed-session flag when the US market
              is shut. Thin pools, halted markets, and third-party oracle
              failures remain meaningful sources of risk.
            </p>
          </article>
        </div>
      </ProductSection>
      <ProductCTA
        title="Make the boundaries concrete."
        body="Inspect and save allocation, leverage, daily-loss, and slippage preferences."
        href="/dashboard/controls/"
        label="Open risk controls"
      />
    </ProductShell>
  );
}

export function Security() {
  return (
    <ProductShell className="security-product">
      <ProductHero
        index="05"
        kicker="Self-custody"
        title={
          <>
            Your accounts.
            <br />
            <em>Limited keys.</em>
          </>
        }
        description="The owner’s main key stays with the owner. Proviso’s permission model separates trading authority from ownership, with a different permission boundary for each venue."
      >
        <div className="p-custody-diagram">
          <div className="custody-owner">
            <Glyph name="privacy" size={46} />
            <strong>YOU</strong>
            <small>MAIN KEY</small>
          </div>
          <div className="custody-arms">
            <div>
              <span>HL</span>
              <strong>Trade-only</strong>
              <small>No withdrawals</small>
            </div>
            <div>
              <span>RH</span>
              <strong>Swap-only</strong>
              <small>Signed policy</small>
            </div>
          </div>
        </div>
      </ProductHero>
      <ProductSection
        number="01"
        label="What access means"
        title={
          <>
            Two permissions.
            <br />
            Distinct boundaries.
          </>
        }
      >
        <div className="p-permission-matrix">
          <div className="p-permission-matrix-head">
            <span>CAPABILITY</span>
            <strong>Hyperliquid agent</strong>
            <strong>Robinhood swap key</strong>
          </div>
          {[
            [
              "Place supported orders",
              "Allowed, signer checks",
              "Allow-listed swaps only",
            ],
            [
              "Stops and targets",
              "Reduce-only exits",
              "Policy-specific swap flow",
            ],
            ["Withdraw / transfer", "Not permitted", "Not permitted"],
            ["Arbitrary router", "Not applicable", "Not permitted"],
            [
              "Token approvals",
              "No owner key access",
              "Exact amount to adapter only",
            ],
            [
              "Change allowed pools",
              "Not applicable",
              "New main-key signature",
            ],
            ["Key expiry", "Versioned agent with expiry", "Policy expiry"],
            ["Revoke", "Owner-controlled", "Owner-controlled"],
          ].map(([a, b, c]) => (
            <div key={a}>
              <span>{a}</span>
              <span>{b}</span>
              <span>{c}</span>
            </div>
          ))}
        </div>
      </ProductSection>
      <section className="p-trust-boundaries">
        <span className="eyebrow">02 / TRUST BOUNDARIES</span>
        <h2>
          Keep the authority
          <br />
          where it belongs.
        </h2>
        <div>
          {[
            [
              "DEVICE",
              "Owner control",
              "Main key, canonicalization, random salts, signature, and encrypted recovery export.",
            ],
            [
              "ISOLATED SERVICES",
              "Scoped execution",
              "The evaluator decrypts rules inside an isolated enclave. The signer holds per-user agent keys and enforces confirmed limits.",
            ],
            [
              "ON-CHAIN POLICY",
              "Explicit restrictions",
              "The swap adapter constrains pools, approval amounts, output recipient, price bounds, freshness, caps, and expiry.",
            ],
          ].map(([label, title, body]) => (
            <article key={label}>
              <span className="eyebrow">{label}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>
      <ProductSection
        number="03"
        label="Lifecycle & residual risk"
        title={
          <>
            A key has a life.
            <br />
            And a limit.
          </>
        }
      >
        <div className="p-prose-columns">
          <article>
            <Glyph name="expiry" size={31} />
            <h3>Rotate after re-funding.</h3>
            <p>
              The permission lifecycle calls for a fresh agent after an empty
              Hyperliquid account is re-funded. Unique names and versions
              prevent accidental reuse after agent pruning.
            </p>
          </article>
          <article>
            <Glyph name="route" size={31} />
            <h3>Fix the route.</h3>
            <p>
              A swap key can approve the exact input amount to
              ProvisoSwapAdapter and call it in the same user operation. No
              Universal Router, Permit2, unrestricted transfer, or arbitrary
              approval is intended.
            </p>
          </article>
          <article>
            <Glyph name="signal" size={31} />
            <h3>Constrain the reference.</h3>
            <p>
              The swap design requires a fresh oracle reference, a price-banded
              minimum output, and fixed pool keys. Oracle multipliers must be
              applied once, with explicit per-feed handling.
            </p>
          </article>
          <article>
            <Glyph name="position" size={31} />
            <h3>Trade-only still carries risk.</h3>
            <p>
              A key unable to withdraw can still lose funds through trades.
              Signer controls, enclave claims, permission modules, and contracts
              all need implementation tests and review before being trusted.
            </p>
          </article>
        </div>
      </ProductSection>
      <ProductCTA
        title="Inspect the account model."
        body="See connection requirements, permissions, key lifecycle, and funding-route behavior."
        href="/dashboard/connections/"
        label="Accounts & routes"
      />
    </ProductShell>
  );
}

export function Testing() {
  return (
    <ProductShell className="testing-product">
      <ProductHero
        index="06"
        kicker="Strategy testing"
        title={
          <>
            Look back.
            <br />
            <em>With the rules intact.</em>
          </>
        }
        description="A 90-day replay designed to show when an idea would have fired, what a stated fill model would have done, and how the result can be reproduced."
      >
        <div className="p-history-window">
          <div>
            <strong>90</strong>
            <span>DAYS OF CONTEXT</span>
          </div>
          <svg
            className="history-signal"
            viewBox="0 0 400 90"
            role="img"
            aria-label="Condition sampling across a historical window"
          >
            <path
              d="M0 22h400M0 65h400"
              stroke="#484848"
              strokeWidth="1"
              strokeDasharray="3 5"
            />
            <path d="M80 5v75M205 5v75M330 5v75" stroke="#373737" />
            <path
              className="trace"
              d="M0 65h35V45h25v20h35V22h40v43h30V45h25v20h40V22h50v43h40V45h20v20h60"
              fill="none"
              stroke="#cccccc"
              strokeWidth="1.5"
            />
            <circle cx="95" cy="22" r="3" fill="#f0f0f0" />
            <circle cx="230" cy="22" r="3" fill="#f0f0f0" />
          </svg>
          <div className="history-rulers">
            {Array.from({ length: 40 }, (_, i) => (
              <i key={i} style={{ height: i % 5 === 0 ? "44px" : "19px" }} />
            ))}
          </div>
          <div className="history-labels">
            <span>VERSIONED DATA</span>
            <Glyph name="replay" size={28} />
            <span>REPEATABLE TEST</span>
          </div>
        </div>
      </ProductHero>
      <ProductSection
        number="01"
        label="The replay report"
        title={
          <>
            A result, with
            <br />
            its working shown.
          </>
        }
      >
        <div className="p-report-grid">
          {[
            [
              "FIRING TIMES",
              "When the idea held.",
              "A chronological list of rule triggers, not just a single return figure.",
            ],
            [
              "SIMULATED FILLS",
              "The cost of an assumption.",
              "Fill modelling around the mark with explicit slippage. Actual execution can differ.",
            ],
            [
              "P&L",
              "The resulting path.",
              "An outcome tied to its input data, model, and fee assumptions.",
            ],
            [
              "MAXIMUM DRAWDOWN",
              "The difficult part of the path.",
              "The peak-to-trough decline in the simulated series, not only the ending balance.",
            ],
          ].map(([label, title, body], i) => (
            <article key={label}>
              <span className="report-marker">0{i + 1}</span>
              <span className="eyebrow">{label}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </ProductSection>
      <ProductSection
        number="02"
        label="Reproducibility"
        title={
          <>
            Same inputs.
            <br />
            An inspectable identity.
          </>
        }
        className="p-dark-section"
      >
        <div className="p-replay-equation">
          <span>SPECIFICATION</span>
          <b>+</b>
          <span>DATA SNAPSHOT IDS</span>
          <b>+</b>
          <span>TESTER VERSION</span>
          <b>→</b>
          <strong>TEST ID</strong>
        </div>
        <div className="p-prose-columns">
          <article>
            <h3>The test ID has a purpose.</h3>
            <p>
              The test identity uses SHA-256 of the rules, data snapshot
              identifiers, and tester version. A test can then be rerun against
              the same inputs instead of relying on an unrepeatable screenshot.
            </p>
          </article>
          <article>
            <h3>Coverage must be disclosed.</h3>
            <p>
              Historical coverage includes Hyperliquid candles, funding and open
              interest, Robinhood Chain pool history, and Fear & Greed. X-post
              replay is a later extension dependent on available data and cost.
            </p>
          </article>
        </div>
      </ProductSection>
      <ProductSection
        number="03"
        label="Interpretation"
        title={
          <>
            History is evidence.
            <br />
            It is not a forecast.
          </>
        }
      >
        <div className="p-testing-limits">
          <article>
            <h3>Check the assumptions.</h3>
            <p>
              Confirm market availability, sampling, missing-data treatment,
              slippage, funding, fees, and how partial fills are modelled. These
              details can change the apparent result materially.
            </p>
          </article>
          <article>
            <h3>Check the failure cases.</h3>
            <p>
              A replay cannot promise execution in a fast move, guarantee
              liquidity, or remove liquidation risk. A rule that worked in one
              period may fail in another.
            </p>
          </article>
          <article>
            <h3>Keep it attributable.</h3>
            <p>
              Keep the rules, data snapshot identifiers, and tester version with
              the report. An outcome without its input history cannot be
              independently reproduced.
            </p>
          </article>
        </div>
      </ProductSection>
      <ProductCTA
        title="Prepare the question for history."
        body="Choose a saved thesis and define the replay assumptions before submitting to a connected tester."
        href="/dashboard/replay/"
        label="Open strategy tester"
      />
    </ProductShell>
  );
}
