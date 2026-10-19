"use client";
import { useState } from "react";
import { Glyph } from "@/views/proviso/glyph";
import {
  ProductShell,
  ProductHero,
  ProductSection,
  ProductCTA,
} from "./site-shell";
const events = [
  [
    "FIRE",
    "The entry opens.",
    "The executor is designed to reveal the entry within one minute. The exit commitment remains private.",
  ],
  [
    "CLOSE",
    "The exit opens.",
    "Once the position closes, the exit specification and salt make the earlier commitment inspectable.",
  ],
  [
    "EXPIRE",
    "An unfired idea still counts.",
    "At expiry the entry is disclosed and shadow-scored. A missing disclosure remains visible as “unrevealed after expiry.”",
  ],
  [
    "RETIRE",
    "Retirement is not erasure.",
    "The owner may retire an idea. Entry reveal is required within 24 hours and the idea still receives a shadow score.",
  ],
  [
    "MANUAL",
    "A reveal is not a trade.",
    "A voluntary reveal of an unfired idea is marked MANUAL_NO_TRADE. It is not presented as executed performance.",
  ],
];
export function ProofProduct() {
  const [event, setEvent] = useState(0);
  return (
    <ProductShell className="proof-product">
      <ProductHero
        index="02"
        kicker="Proof of Call"
        title={
          <>
            Before the outcome.
            <br />
            <em>On the record.</em>
          </>
        }
        description="A timestamped commitment to the idea you actually made. Entry and exit are sealed separately, then disclosed as the thesis unfolds."
      >
        <div className="proof-folio">
          <span className="folio-index">RECORD / 0001</span>
          <div className="folio-seal">
            <Glyph name="proof" size={70} />
          </div>
          <div className="folio-hashes">
            <div>
              <span>ENTRY HASH</span>
              <b>0x ▪▪▪▪ ▪▪▪▪ ▪▪▪▪</b>
            </div>
            <div>
              <span>EXIT HASH</span>
              <b>0x ▪▪▪▪ ▪▪▪▪ ▪▪▪▪</b>
            </div>
          </div>
          <div className="folio-meta">
            <span>OWNER SIGNED</span>
            <span>EXPIRY ≤ 30 DAYS</span>
          </div>
        </div>
      </ProductHero>
      <ProductSection
        number="01"
        label="The commitment"
        title={
          <>
            The device prepares.
            <br />
            The owner signs.
          </>
        }
      >
        <div className="p-proof-steps">
          {[
            [
              "01",
              "Canonicalize",
              "Entry and exit each become a deterministic JSON representation using RFC 8785.",
            ],
            [
              "02",
              "Salt & hash",
              "The device generates two separate 32-byte salts and computes Keccak-256 commitments.",
            ],
            [
              "03",
              "Sign the stamp",
              "An EIP-712 signature covers the owner, hashes, expiry, nonce, and deadline.",
            ],
            [
              "04",
              "Relay & retain",
              "ThesisSeal records the stamp. Signed-at and stamped-at remain separate. The user keeps an encrypted export of specification and salts.",
            ],
          ].map(([n, t, b]) => (
            <article key={n}>
              <span>{n}</span>
              <h3>{t}</h3>
              <p>{b}</p>
            </article>
          ))}
        </div>
      </ProductSection>
      <section
        className="p-disclosure-stage"
        id="disclosure-timeline"
        data-chapter="Disclosure timeline"
      >
        <div>
          <span className="eyebrow">02 / DISCLOSURE TIMELINE</span>
          <h2>
            Privacy has
            <br />a defined horizon.
          </h2>
          <div className="p-disclosure-tabs">
            {events.map(([label], i) => (
              <button
                key={label}
                aria-pressed={event === i}
                onClick={() => setEvent(i)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <article key={event}>
          <span className="disclosure-n">0{event + 1}</span>
          <span className="eyebrow">{events[event][0]} / RECORD EVENT</span>
          <h3>{events[event][1]}</h3>
          <p>{events[event][2]}</p>
        </article>
      </section>
      <ProductSection
        number="03"
        label="Evidence, in sequence"
        title={
          <>
            Small events.
            <br />A verifiable trail.
          </>
        }
      >
        <div className="p-root-tree">
          <div className="p-root">
            HOURLY MERKLE ROOT <Glyph name="proof" size={22} />
          </div>
          <div className="p-tree-branches">
            <span />
            <span />
          </div>
          <div className="p-root-leaves">
            {["FIRE", "FILL", "EXIT", "PNL", "EXPIRE"].map((e, i) => (
              <div key={e}>
                <span>SEQ {String(i + 1).padStart(2, "0")}</span>
                <b>{e}</b>
              </div>
            ))}
          </div>
        </div>
        <div className="p-prose-columns">
          <div>
            <h3>A gap should leave a trace.</h3>
            <p>
              Each event leaf includes the thesis ID, its sequence number, event
              kind, and data. Hourly roots and leaf counts are posted to
              StampRoots. The proof API is designed to connect an event to a
              committed root.
            </p>
          </div>
          <div>
            <h3>Timing is evidence, not quality.</h3>
            <p>
              A stamp does not prove that an idea is profitable or show every
              wallet a caller controls. Proviso remains the event poster. The
              evaluator must decrypt sealed rules inside an isolated environment
              to run them.
            </p>
          </div>
        </div>
      </ProductSection>
      <ProductCTA
        title="Inspect how a record is built."
        body="Explore the commitment parameters, event types, and reveal states in the workspace."
        href="/dashboard/proof/"
        label="Open Proof of Call"
      />
    </ProductShell>
  );
}
