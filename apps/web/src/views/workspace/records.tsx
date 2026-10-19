"use client";
import { useState } from "react";
import Link from "next/link";
import { Glyph } from "@/views/proviso/glyph";
import { Icon } from "@/views/proviso/shared";
import {
  dollars,
  exportJson,
  toSpec,
  formatCondition,
} from "@/lib/proviso/domain";
import { OnChainRecord } from "./onchain-record";
import { useWorkspace } from "./provider";
import {
  Action,
  Panel,
  PageTitle,
  Tag,
  Note,
  Empty,
  SealDiagram,
  DefinitionList,
} from "./ui";

export function Records() {
  const { data, removeDraft } = useWorkspace();
  const [filter, setFilter] = useState("All"),
    [query, setQuery] = useState(""),
    [expanded, setExpanded] = useState(""),
    [pendingDelete, setPendingDelete] = useState("");
  const drafts = data.drafts.filter(
    (d) =>
      (filter === "All" || filter === "Draft") &&
      `${d.title} ${d.market}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <PageTitle
        index="02 / CALL LEDGER"
        title="Keep the entire record."
        description="The calls that worked. The ones that didn’t. The ideas that never fired."
        action={<Action href="/dashboard/compose/">New thesis</Action>}
      />
      <OnChainRecord />
      <div className="ledger-summary">
        <div>
          <strong>{String(data.drafts.length).padStart(2, "0")}</strong>
          <span>Working drafts</span>
        </div>
        <div>
          <strong>00</strong>
          <span>Verified stamps</span>
        </div>
        <div>
          <strong>00</strong>
          <span>Closed positions</span>
        </div>
        <p>
          Intent. Evidence. Outcome.
          <br />
          Keep the sequence together.
        </p>
      </div>
      <Panel
        className="w-ledger"
        label="THE FULL SEQUENCE"
        icon="records"
        aside={
          <button
            className="w-text-link"
            disabled={!data.drafts.length}
            onClick={() =>
              exportJson("proviso-drafts.json", {
                kind: "local-drafts",
                drafts: data.drafts,
              })
            }
          >
            Export drafts <Icon name="download" size={16} />
          </button>
        }
      >
        <div className="w-ledger-tools">
          <div className="w-filter-group" aria-label="Record status">
            {["All", "Draft", "Sealed", "Closed", "Expired"].map((f) => (
              <button
                key={f}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <label className="w-search">
            <span>⌕</span>
            <input
              placeholder="Search a thesis or market"
              aria-label="Search records"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        <div className="w-record-header">
          <span>THESIS / MARKET</span>
          <span>STATUS</span>
          <span>ALLOCATION / RESULT</span>
          <span>INSPECT</span>
        </div>
        {drafts.map((d) => (
          <div className="w-record" key={d.id}>
            <button
              className="w-record-row"
              aria-expanded={expanded === d.id}
              onClick={() => setExpanded(expanded === d.id ? "" : d.id)}
            >
              <span className="record-name">
                <i>{d.market.slice(0, 2)}</i>
                <span>
                  <strong>{d.title}</strong>
                  <small>
                    {d.side.toUpperCase()} {d.market} · {d.leverage}×
                  </small>
                </span>
              </span>
              <Tag>Draft</Tag>
              <span>
                {dollars(d.allocation)}
                <small>Planned allocation</small>
              </span>
              <Icon name={expanded === d.id ? "close" : "plus"} size={18} />
            </button>
            {expanded === d.id && (
              <div className="w-record-detail">
                <div>
                  <span className="w-label">
                    CONDITIONS / {d.match.toUpperCase()}
                  </span>
                  {d.conditions.map((c) => (
                    <code key={c.id}>{formatCondition(c, d.market)}</code>
                  ))}
                  <p>
                    Stop −{d.stop}% · target +{d.take}% · expires after{" "}
                    {d.expiryDays} days.
                  </p>
                  <small>
                    Updated {new Date(d.updated).toLocaleString()}. No chain
                    stamp exists.
                  </small>
                </div>
                <div className="record-detail-actions">
                  <Link
                    className="w-button"
                    href={`/dashboard/compose/?draft=${encodeURIComponent(d.id)}`}
                  >
                    Edit thesis <Icon name="diagonal" size={15} />
                  </Link>
                  <button
                    className="w-button secondary"
                    onClick={() =>
                      exportJson(
                        `proviso-${d.market.toLowerCase()}-draft.json`,
                        { kind: "unsigned-local-draft", spec: toSpec(d) },
                      )
                    }
                  >
                    Export <Icon name="download" size={15} />
                  </button>
                  <button
                    className="w-text-link"
                    onClick={() => setPendingDelete(d.id)}
                  >
                    Remove draft
                  </button>
                  {pendingDelete === d.id && (
                    <div className="delete-confirm">
                      <p>Remove this draft from this browser?</p>
                      <button
                        onClick={() => {
                          removeDraft(d.id);
                          setPendingDelete("");
                        }}
                      >
                        Remove
                      </button>
                      <button onClick={() => setPendingDelete("")}>
                        Keep draft
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
        {!drafts.length && (
          <Empty
            icon="records"
            title={
              query || filter !== "All"
                ? "No matching calls."
                : "Your first call starts here."
            }
            body={
              query || filter !== "All"
                ? "Try a different status or search term."
                : "Define an idea and save its rules. Your working theses and their records belong here."
            }
          >
            {(query || filter !== "All") && (
              <button
                className="w-button secondary"
                onClick={() => {
                  setFilter("All");
                  setQuery("");
                }}
              >
                Reset filters
              </button>
            )}
            <Action href="/dashboard/compose/">Write a thesis</Action>
          </Empty>
        )}
        <Note>
          Drafts stay editable until they are signed and sealed. Verified
          records appear after an account is connected.
        </Note>
      </Panel>
      <div className="w-columns equal">
        <Panel label="A RECORD WITHOUT SELECTIVE MEMORY" icon="expiry">
          <h3>Unfired is still a result.</h3>
          <p>
            Sealed, expired, and retired ideas stay visible. Expiry and
            retirement lead to entry reveal and shadow scoring, including an
            “unrevealed after expiry” status when disclosure is missing.
          </p>
          <Link className="w-text-link" href="/proof-of-call/">
            Read the disclosure timeline <Icon name="arrow" size={15} />
          </Link>
        </Panel>
        <Panel label="CONTEXT BEHIND THE NUMBERS" icon="position">
          <h3>Size matters. So does timing.</h3>
          <p>
            The record brings together caller-to-follower size ratios, money ×
            days weighting, Copy Promise status, and flags for self-triggered,
            trivially true, linked, and outside-close activity.
          </p>
          <Link className="w-text-link" href="/fair-copy/">
            Understand record integrity <Icon name="arrow" size={15} />
          </Link>
        </Panel>
      </div>
    </>
  );
}

export function Proof() {
  const [event, setEvent] = useState("FIRE");
  const stages = [
    [
      "FIRE",
      "Entry conditions are disclosed",
      "The disclosure rule requires revealing the entry within one minute of a fire. Exit terms stay sealed.",
    ],
    [
      "FILL",
      "Execution evidence is appended",
      "Each fill belongs to an idea and an incrementing sequence number. Timestamps distinguish follower and caller waves.",
    ],
    [
      "EXIT",
      "The exit commitment is revealed",
      "After the position closes, exit rules and the closing event complete the idea’s public story.",
    ],
    [
      "PNL",
      "The outcome joins the record",
      "The signed event stream supports the outcome record. Missing sequence numbers can be detected.",
    ],
    [
      "EXPIRE",
      "Unfired ideas are still accounted for",
      "The entry must be revealed at expiry. Retirement requires disclosure within 24 hours; shadow outcomes remain distinct from trades.",
    ],
  ];
  const current = stages.find((s) => s[0] === event)!;
  return (
    <>
      <PageTitle
        index="03 / PROOF OF CALL"
        title="Evidence, before hindsight."
        description="Separate commitments. Timed disclosures. A record with detectable gaps."
        action={
          <Action secondary href="/proof-of-call/">
            Full protocol
          </Action>
        }
      />
      <Panel
        light
        label="THE TWO-PART COMMITMENT"
        icon="proof"
        className="proof-hero"
      >
        <div>
          <h2>
            One idea.
            <br />
            Two sealed clauses.
          </h2>
          <p>
            Entry and exit are committed separately, so the market can verify
            what you called without exposing your exit levels before the
            position closes.
          </p>
        </div>
        <SealDiagram />
      </Panel>
      <div className="w-columns two-one">
        <Panel label="EVENT EXPLORER / THE EVIDENCE SEQUENCE" icon="activity">
          <div className="proof-event-tabs">
            {stages.map(([id], i) => (
              <button
                key={id}
                onClick={() => setEvent(id)}
                aria-pressed={id === event}
              >
                <span>0{i + 1}</span>
                {id}
              </button>
            ))}
          </div>
          <div className="proof-event-detail">
            <span className="w-label">{event} / EVENT LEAF</span>
            <h2>{current[1]}</h2>
            <p>{current[2]}</p>
            <div className="proof-sequence">
              <span>THESIS ID</span>
              <b>→</b>
              <span>SEQUENCE</span>
              <b>→</b>
              <span>KIND</span>
              <b>→</b>
              <span>DATA</span>
            </div>
            <Note>
              Hourly Merkle roots group event leaves in StampRoots. A proof
              links an event to its posted root. Each sequence number makes
              missing events detectable.
            </Note>
          </div>
        </Panel>
        <Panel label="COMMITMENT PARAMETERS" icon="privacy">
          <DefinitionList
            items={[
              ["Canonicalization", "RFC 8785 JSON"],
              ["Entry / exit hashes", "Keccak-256"],
              ["Salts", "32 random bytes each"],
              ["Signing", "EIP-712 owner signature"],
              ["Maximum expiry", "30 days"],
              ["Replay protection", "Unused nonce + deadline"],
            ]}
          />
          <Note>
            Each commitment uses its own salt. Keep the encrypted recovery copy
            of the rules and salts to preserve your ability to reveal.
          </Note>
        </Panel>
      </div>
      <div className="w-columns equal">
        <Panel label="DISCLOSURE RULES" icon="expiry">
          <DefinitionList
            items={[
              ["Idea fires", "Reveal entry within one minute"],
              ["Position closes", "Reveal exit"],
              ["Idea expires", "Reveal entry + shadow-score"],
              ["Owner retires idea", "Reveal within 24 hours"],
              ["Manual reveal", "Label MANUAL_NO_TRADE"],
            ]}
          />
        </Panel>
        <Panel label="VERIFIED RECORDS" icon="records">
          <Empty
            icon="proof"
            title="Your evidence belongs here."
            body="No verified stamps are available. A signed and sealed thesis creates the commitment that begins the evidence trail."
          >
            <Action secondary href="/dashboard/records/">
              Inspect the call ledger
            </Action>
          </Empty>
        </Panel>
      </div>
    </>
  );
}
