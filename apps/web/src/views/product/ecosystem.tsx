"use client";
import Link from "next/link";
import { Icon } from "@/views/proviso/shared";
import { Glyph } from "@/views/proviso/glyph";
import {
  ProductShell,
  ProductHero,
  ProductSection,
  ProductCTA,
} from "./site-shell";
const stages = [
  [
    "R1",
    "Write & commit",
    "Wallet and Hyperliquid linking, rule writer, alert mode, and client-side sealing.",
  ],
  [
    "R2",
    "Evaluate & execute",
    "Hyperliquid execution, limits, stop workflow, and the 90-day tester.",
  ],
  [
    "R3",
    "Follow & record",
    "Fair Copy, complete caller records, and disclosure history.",
  ],
  [
    "R4",
    "Extend the venues",
    "Robinhood Chain spot actions and Stock Token conditions.",
  ],
  [
    "R5",
    "Expand the signals",
    "Costed X-post polling and a Telegram interface.",
  ],
];
export function Integrations() {
  return (
    <ProductShell className="integrations-product">
      <ProductHero
        index="07"
        kicker="Integrations"
        title={
          <>
            Two venues.
            <br />
            <em>Distinct responsibilities.</em>
          </>
        }
        description="The Proviso architecture connects a commitment layer, market access, and reference data. Each dependency has a specific job and its own constraints."
      >
        <div className="p-venue-orbits">
          <div>
            <b>HL</b>
            <span>MARKETS / EXECUTION</span>
          </div>
          <i />
          <div>
            <b>RH</b>
            <span>COMMITMENTS / SWAPS</span>
          </div>
          <small>MARKET ACCESS / EVIDENCE LAYER</small>
        </div>
      </ProductHero>
      <ProductSection
        number="01"
        label="The venue map"
        title={
          <>
            One workflow.
            <br />
            Different systems.
          </>
        }
      >
        <div className="p-venue-grid">
          <article>
            <span className="eyebrow">HYPERLIQUID / HYPERCORE</span>
            <h3>The market side.</h3>
            <ul>
              <li>Perpetual and spot actions via public APIs.</li>
              <li>Price, funding, and open-interest feeds.</li>
              <li>Per-user trade-only agent keys.</li>
              <li>Builder approvals and order identifiers tied to theses.</li>
              <li>Independent acknowledgements and fills per account.</li>
            </ul>
            <p>
              Market availability follows venue metadata. Review the instrument,
              session, and liquidity before confirming an action.
            </p>
          </article>
          <article>
            <span className="eyebrow">ROBINHOOD CHAIN</span>
            <h3>The commitment side.</h3>
            <ul>
              <li>ThesisSeal commitments and reveal events.</li>
              <li>Hourly StampRoots evidence batches.</li>
              <li>Record indexing and commitment proofs.</li>
              <li>Allow-listed swaps through a dedicated adapter.</li>
              <li>Wallet and gas-sponsorship assumptions to verify.</li>
            </ul>
            <p>
              Contract permissions, token identity, and chain support must align
              before a route can be authorized. References to a venue do not
              imply a partnership.
            </p>
          </article>
        </div>
      </ProductSection>
      <ProductSection
        number="02"
        label="Supporting connections"
        title={
          <>
            Every input
            <br />
            has a provenance.
          </>
        }
        className="p-dark-section"
      >
        <div className="p-integration-list">
          {[
            [
              "Reference prices",
              "Chainlink and pool references",
              "Per-leg agreement, freshness, and explicit multiplier handling.",
            ],
            [
              "Sessions & actions",
              "Robinhood market APIs",
              "US session context, canonical assets, and corporate actions.",
            ],
            [
              "Sentiment",
              "Public Fear & Greed index",
              "15-minute design cadence; provider remains to be selected.",
            ],
            [
              "Earnings",
              "Calendar provider",
              "Daily design cadence; vendor and exact coverage remain unresolved.",
            ],
            [
              "Social signals",
              "Selected X accounts",
              "Bounded string matching, costed polling, self-trigger flags.",
            ],
            [
              "Delivery",
              "Push + Telegram",
              "Lifecycle notifications and the later Telegram interface.",
            ],
          ].map(([a, b, c], i) => (
            <article key={a}>
              <span>0{i + 1}</span>
              <h3>{a}</h3>
              <div>
                <strong>{b}</strong>
                <p>{c}</p>
              </div>
            </article>
          ))}
        </div>
      </ProductSection>
      <ProductSection
        number="03"
        label="The capability map"
        title={
          <>
            Connected by purpose.
            <br />
            Clear at every boundary.
          </>
        }
      >
        <div className="p-roadmap">
          {stages.map(([id, title, body]) => (
            <article key={id}>
              <b>{id}</b>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
              <Icon name="diagonal" size={15} />
            </article>
          ))}
        </div>
        <p className="p-small">
          Each capability depends on the account permissions, data coverage, and
          venue support it needs. Your workspace shows the state of each
          connection.
        </p>
      </ProductSection>
      <ProductCTA
        title="Understand the account requirements."
        body="Inspect key permissions, funding routes, and what each connection is designed to permit."
        href="/dashboard/connections/"
        label="View accounts & routes"
      />
    </ProductShell>
  );
}
