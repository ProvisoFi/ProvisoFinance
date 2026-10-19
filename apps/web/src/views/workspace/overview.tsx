"use client";
import Link from "next/link";
import { Glyph } from "@/views/proviso/glyph";
import { Icon } from "@/views/proviso/shared";
import { dollars } from "@/lib/proviso/domain";
import { LiveStatus } from "./live-status";
import { useWorkspace } from "./provider";
import {
  Action,
  Panel,
  PageTitle,
  Tag,
  Lifecycle,
  SectionTitle,
  Empty,
} from "./ui";

export function Overview() {
  const { data } = useWorkspace();
  const allocated = data.drafts.reduce((s, d) => s + d.allocation, 0);
  return (
    <>
      <PageTitle
        index="00 / OVERVIEW"
        title="The conviction desk."
        description="Your ideas, their conditions, and the record they leave behind."
        action={<Action href="/dashboard/compose/">Write a thesis</Action>}
      />
      <div className="w-stats-strip">
        {[
          [
            String(data.drafts.length).padStart(2, "0"),
            "Working theses",
            "Saved in your workspace",
          ],
          [
            dollars(allocated),
            "Planned allocation",
            "Draft amounts, not invested funds",
          ],
          ["—", "Live positions", "Account not linked"],
          ["—", "Realized outcome", "Available after verified fills"],
        ].map(([value, label, sub]) => (
          <div key={label}>
            <span className="w-label">{label}</span>
            <strong>{value}</strong>
            <small>{sub}</small>
          </div>
        ))}
      </div>
      <LiveStatus />
      <div className="w-overview-grid">
        <Panel
          className="w-start-card"
          light
          label="01 / YOUR NEXT CALL"
          icon="compose"
        >
          <div>
            <span className="w-overline">
              A THOUGHT IS A START. A RULE IS A COMMITMENT.
            </span>
            <h2>
              Make room
              <br />
              for conviction.
            </h2>
            <p>
              Start with a market observation. Define what has to happen, what
              you’ll do, and exactly where the idea ends.
            </p>
            <Action href="/dashboard/compose/">Open the composer</Action>
          </div>
          <div className="w-condition-object" aria-hidden="true">
            <div>
              <span>WHEN</span>
              <b>Condition</b>
              <i />
            </div>
            <div>
              <span>THEN</span>
              <b>Consequence</b>
              <i />
            </div>
            <div>
              <span>EXIT</span>
              <b>Discipline</b>
              <i />
            </div>
            <small>THESIS / 001</small>
          </div>
        </Panel>
        <Panel
          className="w-readiness"
          label="WORKSPACE READINESS"
          icon="network"
        >
          <div className="readiness-ring">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle cx="60" cy="60" r="51" />
              <circle cx="60" cy="60" r="51" strokeDasharray="80 321" />
            </svg>
            <strong>
              01<span>/ 04</span>
            </strong>
          </div>
          <h3>Ready to draft.</h3>
          <p>
            Bring the structure first.
            <br />
            Set your boundaries. Link your accounts.
          </p>
          <ol>
            <li className="done">
              <Icon name="check" size={14} />
              Thesis desk ready
            </li>
            <li>
              <span>02</span>Link your accounts
            </li>
            <li>
              <span>03</span>Confirm permissions
            </li>
            <li>
              <span>04</span>Seal your first call
            </li>
          </ol>
          <Link className="w-text-link" href="/dashboard/connections/">
            Manage your accounts <Icon name="arrow" size={15} />
          </Link>
        </Panel>
      </div>

      <SectionTitle
        title="From intent to evidence."
        caption="The complete thesis lifecycle, designed as one continuous record."
        link={["Protocol guide", "/protocol/"]}
      />
      <Panel className="w-lifecycle-panel">
        <Lifecycle />
        <div className="w-panel-foot">
          <Tag solid>START WITH WRITE + REVIEW</Tag>
          <p>
            Confirm the rules before a signature. Every stage preserves the
            intent of the original thesis.
          </p>
        </div>
      </Panel>
      <div className="w-columns two-one">
        <Panel
          label="02 / YOUR WORKING THESES"
          icon="records"
          aside={
            <Link className="w-text-link" href="/dashboard/records/">
              View ledger <Icon name="arrow" size={15} />
            </Link>
          }
        >
          {data.drafts.length ? (
            <div className="w-recent-list">
              {data.drafts.slice(0, 4).map((d) => (
                <Link
                  href={`/dashboard/compose/?draft=${encodeURIComponent(d.id)}`}
                  key={d.id}
                >
                  <span className="market-tile">{d.market.slice(0, 2)}</span>
                  <div>
                    <strong>{d.title}</strong>
                    <small>
                      {d.side.toUpperCase()} {d.market} · {d.leverage}× ·{" "}
                      {d.expiryDays}-day expiry
                    </small>
                  </div>
                  <span>{dollars(d.allocation)}</span>
                  <Icon name="diagonal" size={15} />
                </Link>
              ))}
            </div>
          ) : (
            <Empty
              icon="records"
              title="Your record starts with a rule."
              body="Write an idea, review its conditions, and save your first thesis."
            >
              <Action secondary href="/dashboard/compose/">
                Create your first thesis
              </Action>
            </Empty>
          )}
        </Panel>
        <Panel label="03 / RISK ENVELOPE" icon="limits">
          <div className="w-budget-value">
            <strong>{dollars(data.limits.maxAllocation)}</strong>
            <span>Maximum per idea</span>
          </div>
          <div className="w-range-graphic">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="w-mini-metrics">
            <div>
              <strong>{data.limits.maxLeverage}×</strong>
              <small>Leverage ceiling</small>
            </div>
            <div>
              <strong>{dollars(data.limits.dailyLoss)}</strong>
              <small>Daily loss limit</small>
            </div>
          </div>
          <p className="w-note">
            These boundaries apply to your drafts. Account limits also require a
            connected trading policy.
          </p>
          <Link className="w-text-link" href="/dashboard/controls/">
            Set your boundaries <Icon name="arrow" size={15} />
          </Link>
        </Panel>
      </div>
      <div className="w-columns equal">
        <Panel label="04 / THE TWO-VENUE DESIGN" icon="accounts">
          <div className="venue-summary">
            <div>
              <span className="venue-monogram">HL</span>
              <h3>Hyperliquid</h3>
              <p>
                Perpetuals and spot. Price, funding, and open-interest feeds.
                Trade-only agent execution.
              </p>
              <Tag>Not connected</Tag>
            </div>
            <div>
              <span className="venue-monogram rh">RH</span>
              <h3>Robinhood Chain</h3>
              <p>
                Proof of Call, stamp roots, and permissioned Stock Token swaps
                with signed limits.
              </p>
              <Tag>Not connected</Tag>
            </div>
          </div>
          <Link className="w-text-link" href="/dashboard/connections/">
            Explore accounts & routes <Icon name="arrow" size={15} />
          </Link>
        </Panel>
        <Panel label="05 / RECENT ACTIVITY" icon="activity">
          {data.events.length ? (
            <div className="w-event-mini">
              {data.events.slice(0, 3).map((e) => (
                <div key={e.id}>
                  <span className="event-dot" />
                  <div>
                    <strong>{e.title}</strong>
                    <p>{e.detail}</p>
                    <small>{new Date(e.at).toLocaleString()}</small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="quiet-log">
              <span className="w-label">THE RECORD IS QUIET.</span>
              <p>
                Saved theses and policy changes will appear here. This is your
                workspace history, separate from blockchain stamps.
              </p>
            </div>
          )}
          <Link className="w-text-link" href="/dashboard/activity/">
            Open activity log <Icon name="arrow" size={15} />
          </Link>
        </Panel>
      </div>
      <div className="w-research-strip">
        <Glyph name="architecture" size={34} />
        <div>
          <h3>A system with a reason for every step.</h3>
          <p>
            Explore commitment timing, order waves, data checks, and permission
            boundaries.
          </p>
        </div>
        <Action secondary href="/docs/architecture/">
          Inside the architecture
        </Action>
      </div>
    </>
  );
}
