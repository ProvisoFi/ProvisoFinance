"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Glyph } from "@/views/proviso/glyph";
import { Icon, useModal } from "@/views/proviso/shared";
import {
  dollars,
  exportJson,
  toSpec,
  validateThesis,
  validateRisk,
} from "@/lib/proviso/domain";
import { useWorkspace } from "./provider";
import {
  Action,
  Panel,
  PageTitle,
  Tag,
  DefinitionList,
  Note,
  Empty,
  SectionTitle,
} from "./ui";

export function Replay() {
  const { data, log } = useWorkspace();
  const [selected, setSelected] = useState(""),
    [slippage, setSlippage] = useState(10),
    [prepared, setPrepared] = useState(false),
    [error, setError] = useState("");
  const open = useModal();
  const draft = data.drafts.find((d) => d.id === selected);
  const prepare = () => {
    if (!draft) {
      setError("Select a saved thesis first.");
      return;
    }
    const issues = validateThesis(draft, data.limits);
    if (issues.length) {
      setError(issues.join(" "));
      return;
    }
    if (!Number.isFinite(slippage) || slippage < 0 || slippage > 200) {
      setError("Set modelled slippage between 0 and 200 basis points.");
      return;
    }
    setError("");
    setPrepared(true);
    log(
      "test",
      "Replay request prepared",
      `${draft.title} · 90-day horizon · ${slippage} bps modelled slippage. No replay executed.`,
    );
  };
  return (
    <>
      <PageTitle
        index="05 / STRATEGY TESTER"
        title="Interrogate the idea."
        description="A deterministic replay should make the assumptions as visible as the outcome."
        action={
          <Action secondary href="/testing/">
            Testing methodology
          </Action>
        }
      />
      <div className="w-test-top">
        <Panel light label="REPLAY REQUEST / 90 DAYS" icon="replay">
          <h2>
            Test the rules.
            <br />
            Keep the assumptions.
          </h2>
          <label className="w-field">
            Saved thesis
            <select
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setPrepared(false);
                setError("");
              }}
            >
              <option value="">Choose a saved thesis</option>
              {data.drafts.map((d) => (
                <option value={d.id} key={d.id}>
                  {d.title} · {d.market}
                </option>
              ))}
            </select>
          </label>
          <div className="w-form-grid">
            <label className="w-field">
              Lookback
              <input value="90 days" readOnly />
            </label>
            <label className="w-field">
              Modelled slippage · bps
              <input
                type="number"
                value={slippage}
                min="0"
                max="200"
                onChange={(e) => {
                  setSlippage(Number(e.target.value));
                  setPrepared(false);
                }}
              />
            </label>
          </div>
          <p className="w-note">
            Choose a thesis and set the replay assumptions. Results become
            available after a completed test.
          </p>
          {error && (
            <p className="w-errors" role="alert">
              {error}
            </p>
          )}
          <button className="w-button" onClick={prepare}>
            Prepare replay request <Icon name="arrow" size={16} />
          </button>
          {!data.drafts.length && (
            <Link className="w-text-link" href="/dashboard/compose/">
              Create a thesis first <Icon name="diagonal" size={14} />
            </Link>
          )}
        </Panel>
        <div className="w-replay-visual">
          <div className="w-chart-top">
            <span className="w-label">REPLAY WINDOW / OUTCOME SERIES</span>
            <Tag>Awaiting data</Tag>
          </div>
          <div className="w-empty-chart">
            <span>+ RETURN</span>
            <div className="chart-baseline" />
            <p>
              Your outcome series will appear here.
              <br />
              <small>Prepare a request to define the test.</small>
            </p>
            <div className="chart-x">
              <span>DAY −90</span>
              <span>−60</span>
              <span>−30</span>
              <span>TODAY</span>
            </div>
          </div>
          <div className="w-mini-metrics">
            <div>
              <strong>—</strong>
              <small>Firing events</small>
            </div>
            <div>
              <strong>—</strong>
              <small>Net P&L</small>
            </div>
            <div>
              <strong>—</strong>
              <small>Max drawdown</small>
            </div>
          </div>
        </div>
      </div>
      {prepared && draft && (
        <div className="w-test-prepared" role="status">
          <Glyph name="replay" size={30} />
          <div>
            <h3>Request prepared. Ready for the tester.</h3>
            <p>
              {draft.title} · 90 days · {slippage} bps slippage assumption. This
              is a request, not a completed test.
            </p>
          </div>
          <button
            className="w-button secondary"
            onClick={() =>
              exportJson("proviso-replay-request.json", {
                kind: "unsubmitted-replay-request",
                route: "idea.test",
                input: { draftId: draft.id },
                clientAssumptions: { lookbackDays: 90, slippageBps: slippage },
                spec: toSpec(draft),
              })
            }
          >
            Export request <Icon name="download" size={16} />
          </button>
          <button
            className="w-button"
            onClick={() =>
              open({
                title: "Tester not connected.",
                body: "Your request is ready. A connected testing service is required to run the replay and return its report. You can export the request with its assumptions intact.",
              })
            }
          >
            Run replay <Icon name="play" size={14} />
          </button>
        </div>
      )}
      <SectionTitle
        title="What a test has to account for."
        caption="The data and assumptions that make an outcome reproducible."
      />
      <div className="w-columns three">
        <Panel label="01 / THE DATA" icon="signal">
          <h3>Versioned inputs.</h3>
          <p>
            Hyperliquid candles, funding and open interest. Robinhood Chain pool
            history. Fear & Greed snapshots. X-post history is a later,
            cost-dependent extension.
          </p>
        </Panel>
        <Panel label="02 / THE FILL MODEL" icon="position">
          <h3>Execution has a cost.</h3>
          <p>
            Simulated fills use the mark plus or minus modelled slippage.
            Funding, venue fees, liquidity, and partial fills need explicit
            assumptions before interpreting the result.
          </p>
        </Panel>
        <Panel label="03 / THE IDENTITY" icon="proof">
          <h3>A test you can repeat.</h3>
          <p>
            The specified test ID is SHA-256 over the specification, snapshot
            IDs, and tester version. Identical inputs should reproduce the same
            replay.
          </p>
        </Panel>
      </div>
      <div className="w-wide-note">
        <strong>Evidence is not a forecast.</strong>
        <p>
          Historical results do not predict future returns. A good test reveals
          sensitivity and failure cases; it does not remove market or execution
          risk.
        </p>
        <Link href="/legal/risk/">
          Risk disclosure <Icon name="diagonal" size={14} />
        </Link>
      </div>
    </>
  );
}

export function Connections() {
  const open = useModal();
  const [direction, setDirection] = useState("to-hl"),
    [amount, setAmount] = useState(100),
    [error, setError] = useState("");
  return (
    <>
      <PageTitle
        index="06 / ACCOUNTS & ROUTES"
        title="Your accounts. Connected by intent."
        description="One ownership model, distinct execution permissions, and funding routes you control."
      />
      <div className="w-connection-banner">
        <div className="account-hub">
          <Glyph name="accounts" size={44} />
          <span>YOUR MAIN KEY</span>
        </div>
        <div>
          <h2>Ownership stays with you.</h2>
          <p>
            The design keeps trading funds in your own venue accounts. Proviso’s
            access is limited to approved trading and swap permissions, with
            revocation in your hands.
          </p>
        </div>
        <Tag>No account connected</Tag>
      </div>
      <div className="w-columns equal">
        <Panel label="01 / HYPERLIQUID" icon="position">
          <div className="w-venue-heading">
            <span className="venue-monogram">HL</span>
            <div>
              <h3>Trading account</h3>
              <p>Perpetuals + spot</p>
            </div>
            <Tag>Disconnected</Tag>
          </div>
          <DefinitionList
            items={[
              ["Key type", "Per-user trade-only agent"],
              ["Main key", "Never held by Proviso"],
              ["Exit orders", "Reduce-only"],
              ["Price boundary", "Within 2% of mark"],
              ["Agent lifecycle", "Versioned name + expiry"],
            ]}
          />
          <div className="permission-checks">
            <span>
              <Icon name="check" size={14} />
              Orders and stops
            </span>
            <span>
              <Icon name="close" size={14} />
              No withdrawal authority
            </span>
          </div>
          <button
            className="w-button"
            onClick={() =>
              open({
                title: "Hyperliquid is not connected.",
                body: "Account linking is currently unavailable. Your draft rules and risk limits remain saved. When linking is available, review the trade-only permissions before signing.",
              })
            }
          >
            Connect Hyperliquid <Icon name="diagonal" size={16} />
          </button>
          <Note>
            Hyperliquid agent keys are not natively scoped to a thesis.
            Proviso’s enclave policy must enforce those limits. Empty-account
            re-funding requires a fresh key.
          </Note>
        </Panel>
        <Panel label="02 / ROBINHOOD CHAIN" icon="network">
          <div className="w-venue-heading">
            <span className="venue-monogram rh">RH</span>
            <div>
              <h3>Commitments & swaps</h3>
              <p>On-chain records + Stock Token routes</p>
            </div>
            <Tag>Disconnected</Tag>
          </div>
          <DefinitionList
            items={[
              ["Key type", "Signed swap-key policy"],
              ["Allowed target", "ProvisoSwapAdapter only"],
              ["Approval", "Exact amount, same user operation"],
              ["Pool access", "User-signed allow-list"],
              ["Caps", "Per-transaction, per-day, expiry"],
            ]}
          />
          <div className="permission-checks">
            <span>
              <Icon name="check" size={14} />
              Allow-listed swaps
            </span>
            <span>
              <Icon name="close" size={14} />
              No transfers or Permit2
            </span>
          </div>
          <button
            className="w-button secondary"
            onClick={() =>
              open({
                title: "Robinhood Chain is not connected.",
                body: "Wallet linking is currently unavailable. Review the swap permissions and account limits here before authorizing a connection.",
              })
            }
          >
            Review connection <Icon name="diagonal" size={16} />
          </button>
          <Note>
            The adapter design checks oracle freshness, slippage bounds, fixed
            pool keys, and audited hooks. Integration assumptions require
            verification before launch.
          </Note>
        </Panel>
      </div>
      <SectionTitle
        title="Between accounts, an explicit route."
        caption="Prepare a direction and amount. A real quote must disclose fees, timing, and refund behavior."
      />
      <Panel
        className="w-route-panel"
        label="FUNDING ROUTE PLANNER"
        icon="route"
      >
        <div className="route-map">
          <div>
            <span className="w-label">
              {direction === "to-hl" ? "ROBINHOOD CHAIN" : "HYPERLIQUID"}
            </span>
            <strong>{direction === "to-hl" ? "USDG" : "USDC"}</strong>
          </div>
          <div className="route-bridge">
            <i />
            <Glyph name="route" size={30} />
            <i />
            <small>PUBLIC RELAYER</small>
          </div>
          <div>
            <span className="w-label">
              {direction === "to-hl" ? "HYPERLIQUID" : "ROBINHOOD CHAIN"}
            </span>
            <strong>{direction === "to-hl" ? "USDC" : "USDG"}</strong>
          </div>
        </div>
        <div className="w-form-grid three">
          <label className="w-field">
            Direction
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
            >
              <option value="to-hl">Fund Hyperliquid</option>
              <option value="from-hl">Return to Robinhood Chain</option>
            </select>
          </label>
          <label className="w-field">
            Source amount
            <input
              type="number"
              min="1"
              value={amount || ""}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </label>
          <div className="route-quote">
            <span>Expected received</span>
            <strong>Quote required</strong>
          </div>
        </div>
        {error && (
          <p className="w-errors" role="alert">
            {error}
          </p>
        )}
        <div className="w-form-footer">
          <Note>
            Failed routes are designed to refund to the source account. No
            transfer is initiated here.
          </Note>
          <button
            className="w-button"
            onClick={() => {
              if (!Number.isFinite(amount) || amount <= 0) {
                setError("Enter a positive source amount.");
                return;
              }
              setError("");
              open({
                title: "Live route quotes are coming.",
                body: `Your ${amount} ${direction === "to-hl" ? "USDG" : "USDC"} route needs a connected route.quote service. The final quote must disclose output, fees, timing, and source-refund terms before approval.`,
              });
            }}
          >
            Request route quote <Icon name="arrow" size={16} />
          </button>
        </div>
      </Panel>
      <div className="w-wide-note">
        <strong>Revoke from the source.</strong>
        <p>
          Live permissions must remain revocable from the user’s account. The
          application should show key version, expiry, approval status, and
          rotation requirements once connected.
        </p>
        <Link href="/security/">
          Security model <Icon name="diagonal" size={14} />
        </Link>
      </div>
    </>
  );
}

export function Controls() {
  const { data, ready, saveLimits } = useWorkspace();
  const [limits, setLimits] = useState(data.limits),
    [error, setError] = useState("");
  useEffect(() => {
    if (ready) setLimits(data.limits);
  }, [ready, data.limits]);
  return (
    <>
      <PageTitle
        index="07 / RISK CONTROLS"
        title="A boundary for every action."
        description="Define the envelope before the idea meets the market."
      />
      <div className="w-controls-layout">
        <Panel light label="YOUR RISK ENVELOPE" icon="limits">
          <h2>
            Decide the limits.
            <br />
            Then write the call.
          </h2>
          <p>
            These limits apply to your thesis and following configurations. A
            connected signer must enforce them for every live order.
          </p>
          <div className="risk-form">
            {(
              [
                [
                  "maxAllocation",
                  "Maximum allocation",
                  "USD / idea",
                  "The largest planned allocation for any one thesis.",
                ],
                [
                  "maxLeverage",
                  "Maximum leverage",
                  "×",
                  "Hard design ceiling: 10×, or the lower user and market limit.",
                ],
                [
                  "dailyLoss",
                  "Daily loss limit",
                  "USD / day",
                  "Your account-level loss boundary. Tracking requires a connected account.",
                ],
                [
                  "maxSlippage",
                  "Maximum slippage",
                  "%",
                  "The maximum permitted price deviation, up to 2%.",
                ],
              ] as const
            ).map(([key, label, unit, help], i) => (
              <label className="risk-input" key={key}>
                <span className="risk-input-number">0{i + 1}</span>
                <span>
                  <strong>{label}</strong>
                  <small>{help}</small>
                </span>
                <div>
                  <input
                    aria-label={label}
                    type="number"
                    min={key === "maxSlippage" ? 0.1 : 1}
                    step={key === "maxSlippage" ? 0.1 : 1}
                    value={limits[key] || ""}
                    onChange={(e) => {
                      setLimits({ ...limits, [key]: Number(e.target.value) });
                      setError("");
                    }}
                  />
                  <span>{unit}</span>
                </div>
              </label>
            ))}
          </div>
          {error && (
            <p className="w-errors" role="alert">
              {error}
            </p>
          )}
          <div className="w-form-footer">
            <button
              className="w-text-link"
              onClick={() => {
                setLimits(data.limits);
                setError("");
              }}
            >
              Revert unsaved changes
            </button>
            <button
              className="w-button"
              disabled={!ready}
              onClick={() => {
                if (!validateRisk(limits)) {
                  setError(
                    "Use positive monetary limits up to $1,000,000, whole-number leverage from 1× to 10×, and slippage above 0% and at most 2%.",
                  );
                  return;
                }
                saveLimits(limits);
              }}
            >
              Save limits <Icon name="check" size={16} />
            </button>
          </div>
        </Panel>
        <div>
          <Panel label="VALIDATION ORDER" icon="privacy">
            <ol className="w-ordered-list">
              <li>
                <strong>Confirmed idea</strong>
                <p>An order must belong to a live, user-confirmed thesis.</p>
              </li>
              <li>
                <strong>Idea boundaries</strong>
                <p>
                  Allocation, leverage, market, and action must match the
                  confirmed rules.
                </p>
              </li>
              <li>
                <strong>User + market limits</strong>
                <p>
                  The most restrictive applicable limit wins. Exits remain
                  reduce-only.
                </p>
              </li>
              <li>
                <strong>Price and data checks</strong>
                <p>
                  Source agreement, liquidity, price bands, and market status
                  are checked before signing.
                </p>
              </li>
            </ol>
          </Panel>
          <Panel label="TWO-LEG IDEAS" icon="exit">
            <h3>Partial fills need a plan.</h3>
            <p>
              The design declares multi-leg execution non-atomic, with
              unwind-on-partial behavior. One successful leg does not guarantee
              the other will fill.
            </p>
            <Tag>atomic: false</Tag>
          </Panel>
        </div>
      </div>
      <div className="w-columns three">
        <Panel label="SOURCE AGREEMENT" icon="signal">
          <strong className="w-large-number">
            1<span>%</span>
          </strong>
          <p>
            Each price leg must agree with its own second source. Cross-venue
            gap legs are not required to agree with one another.
          </p>
        </Panel>
        <Panel label="HYPERLIQUID LIQUIDITY" icon="funding">
          <strong className="w-large-number">
            250<span>k</span>
          </strong>
          <p>
            Minimum specified 24-hour market volume in USD for markets used in
            conditions or actions.
          </p>
        </Panel>
        <Panel label="ROBINHOOD POOL DEPTH" icon="network">
          <strong className="w-large-number">
            100<span>k</span>
          </strong>
          <p>
            Minimum specified pool depth in USD. Closed-session flags remain
            visible on Stock Token prices.
          </p>
        </Panel>
      </div>
    </>
  );
}

export function Activity() {
  const { data } = useWorkspace();
  const [filter, setFilter] = useState("all");
  const events = data.events.filter(
    (e) => filter === "all" || e.kind === filter,
  );
  return (
    <>
      <PageTitle
        index="08 / ACTIVITY"
        title="The changes behind the call."
        description="Follow the decisions behind your theses, policies, and test requests."
      />
      <Panel
        label="WORKSPACE JOURNAL"
        icon="activity"
        aside={
          <button
            className="w-text-link"
            disabled={!data.events.length}
            onClick={() =>
              exportJson("proviso-local-activity.json", {
                kind: "local-workspace-activity",
                events: data.events,
              })
            }
          >
            Export activity <Icon name="download" size={16} />
          </button>
        }
      >
        <div className="w-filter-group" aria-label="Activity type">
          {[
            ["all", "All events"],
            ["draft", "Theses"],
            ["limits", "Limits"],
            ["copy", "Fair Copy"],
            ["test", "Tests"],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {events.length ? (
          <ol className="activity-timeline">
            {events.map((e) => (
              <li key={e.id}>
                <time>
                  {new Date(e.at).toLocaleDateString()}
                  <small>{new Date(e.at).toLocaleTimeString()}</small>
                </time>
                <span className="activity-event-icon">
                  <Glyph
                    name={
                      e.kind === "draft"
                        ? "compose"
                        : e.kind === "limits"
                          ? "limits"
                          : e.kind === "copy"
                            ? "copy"
                            : "replay"
                    }
                    size={23}
                  />
                </span>
                <div>
                  <Tag>{e.kind}</Tag>
                  <h3>{e.title}</h3>
                  <p>{e.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <Empty
            icon="activity"
            title="Nothing in this view yet."
            body="Save a thesis, update a policy, or prepare a replay request to begin your activity history."
          />
        )}
        <Note>
          This journal is stored in this browser. It is not an on-chain audit
          log, execution feed, or cryptographic proof.
        </Note>
      </Panel>
      <div className="w-columns equal">
        <Panel label="WORKSPACE & ON-CHAIN RECORDS" icon="records">
          <h3>Two records. Different purposes.</h3>
          <p>
            This journal keeps your workspace decisions together. The evidence
            layer separately sequences FIRE, FILL, EXIT, PNL, and EXPIRE events
            and anchors them in hourly Merkle roots.
          </p>
          <Link className="w-text-link" href="/dashboard/proof/">
            Explore the proof record <Icon name="arrow" size={15} />
          </Link>
        </Panel>
        <Panel label="NOTIFICATION CHANNELS" icon="network">
          <h3>The right event, at the right moment.</h3>
          <p>
            The notification workflow covers push and Telegram updates for
            relevant lifecycle events. Delivery preferences and verified
            channels will appear once those services are connected.
          </p>
          <Tag>Not connected</Tag>
        </Panel>
      </div>
    </>
  );
}
