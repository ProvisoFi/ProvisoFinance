"use client";
import { useState } from "react";
import { Glyph } from "@/views/proviso/glyph";
import { Icon } from "@/views/proviso/shared";
import {
  ProductShell,
  ProductHero,
  ProductSection,
  ProductCTA,
} from "./site-shell";

const states = [
  [
    "Sealed",
    "An idea, before an outcome.",
    "The entry and exit hashes establish a commitment. The rule remains private until the appropriate reveal event.",
    "Commitment",
    "Owner signature · chain stamp",
    "Disclosure",
    "Entry and exit remain sealed",
  ],
  [
    "Fired",
    "The conditions held.",
    "The entry is disclosed at fire. Order acknowledgements, fills, and the follower-to-caller sequence add context to what happened next.",
    "Commitment",
    "Entry matched to its original hash",
    "Disclosure",
    "Entry public · exit sealed",
  ],
  [
    "Closed",
    "The result joins the reasoning.",
    "The exit rules become public after the position closes. Realized outcomes sit alongside the size, timing, fills, and flags needed to interpret them.",
    "Commitment",
    "Entry and exit independently verifiable",
    "Disclosure",
    "Rules and outcome visible",
  ],
  [
    "Expired",
    "A non-event still counts.",
    "An unfired idea reaches its deadline. Its entry must be revealed, and shadow scoring asks whether the conditions would have held. Shadow results are separate from traded returns.",
    "Commitment",
    "Original expiry retained",
    "Disclosure",
    "Entry reveal · shadow outcome",
  ],
  [
    "Retired",
    "Withdrawal leaves a trace.",
    "Retiring an idea does not erase the commitment. Entry disclosure is required within 24 hours, with a visible status when the reveal is missing.",
    "Commitment",
    "Retirement recorded",
    "Disclosure",
    "Entry due within 24 hours",
  ],
];
export function RecordProduct() {
  const [selected, setSelected] = useState(0);
  const state = states[selected];
  return (
    <ProductShell className="record-product">
      <ProductHero
        index="08"
        kicker="The record"
        title={
          <>
            Every call.
            <br />
            <em>The whole story.</em>
          </>
        }
        description="A result means more when you can inspect the commitment, the sequence, and the context. Keep the wins, the losses, and the ideas that never fired together."
      >
        <div
          className="p-record-archive"
          aria-label="A record connects intent, execution, and outcome"
        >
          <div className="archive-spine">
            <span>01</span>
            <b>INTENT</b>
            <Glyph name="compose" size={24} />
          </div>
          <div className="archive-spine">
            <span>02</span>
            <b>EVIDENCE</b>
            <Glyph name="proof" size={24} />
          </div>
          <div className="archive-cover">
            <span className="eyebrow">PROVISO / CALL RECORD</span>
            <Glyph name="records" size={55} />
            <strong>
              Nothing
              <br />
              out of context.
            </strong>
            <div>
              <span>COMMITMENT</span>
              <span>SEQUENCE</span>
              <span>OUTCOME</span>
            </div>
          </div>
        </div>
      </ProductHero>
      <section
        className="p-record-states"
        id="record-lifecycle"
        data-chapter="A complete lifecycle"
      >
        <div className="p-record-state-heading">
          <span className="eyebrow">01 / A COMPLETE LIFECYCLE</span>
          <h2>
            Five states.
            <br />
            One continuous record.
          </h2>
          <p>Inspect what belongs in the record at each stage.</p>
        </div>
        <div className="p-record-state-nav" aria-label="Record states">
          {states.map(([name], i) => (
            <button
              key={name}
              aria-pressed={i === selected}
              onClick={() => setSelected(i)}
            >
              <span>0{i + 1}</span>
              {name}
              <Icon name="arrow" size={16} />
            </button>
          ))}
        </div>
        <article className="p-record-state-detail" key={selected}>
          <span className="eyebrow">
            RECORD STATE / {state[0].toUpperCase()}
          </span>
          <h3>{state[1]}</h3>
          <p>{state[2]}</p>
          <dl>
            <div>
              <dt>{state[3]}</dt>
              <dd>{state[4]}</dd>
            </div>
            <div>
              <dt>{state[5]}</dt>
              <dd>{state[6]}</dd>
            </div>
          </dl>
        </article>
      </section>
      <ProductSection
        number="02"
        label="Reading a call"
        title={
          <>
            The number is
            <br />
            only the beginning.
          </>
        }
      >
        <div className="p-record-anatomy">
          {[
            [
              "position",
              "Position & exposure",
              "Market, direction, leverage, allocation, and caller-to-follower size ratios.",
            ],
            [
              "activity",
              "Timing & sequence",
              "Signed-at, stamped-at, fire, acknowledgements, fills, and close events.",
            ],
            [
              "privacy",
              "Caller conduct",
              "Copy Promise status, linked-account actions, and outside-close flags.",
            ],
            [
              "proof",
              "Evidence & disclosure",
              "Commitment hashes, revealed rules, event sequences, and root inclusion proofs.",
            ],
          ].map(([icon, title, body], i) => (
            <article key={title}>
              <span className="anatomy-index">0{i + 1}</span>
              <Glyph
                name={icon as "position" | "activity" | "privacy" | "proof"}
                size={32}
              />
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </article>
          ))}
        </div>
      </ProductSection>
      <ProductSection
        number="03"
        label="Integrity signals"
        title={
          <>
            Context stays.
            <br />
            Even when it is inconvenient.
          </>
        }
        className="p-dark-section"
      >
        <div className="p-integrity-flags">
          {[
            [
              "OUTSIDE CLOSE",
              "A position closed elsewhere.",
              "An action on the linked caller account may require follower closes and a visible record flag.",
            ],
            [
              "MISSING REVEAL",
              "A disclosure is overdue.",
              "An expired or retired idea remains visible when its entry reveal is missing.",
            ],
            [
              "TRIGGER CONTEXT",
              "The signal needs perspective.",
              "Self-triggered and trivially true conditions carry context rather than silently appearing as independent predictions.",
            ],
          ].map(([label, title, body]) => (
            <article key={label}>
              <span className="eyebrow">
                <i />
                {label}
              </span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
        <p className="p-small">
          A commitment proves what was recorded and when. It cannot prove the
          quality of an idea or reveal activity in unrelated wallets.
        </p>
      </ProductSection>
      <ProductCTA
        title="Build a record worth reading."
        body="Start with a precise thesis. Keep its conditions and limits together as the idea develops."
        href="/dashboard/records/"
        label="Open the call ledger"
      />
    </ProductShell>
  );
}
