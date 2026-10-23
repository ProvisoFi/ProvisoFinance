"use client";
import { useEffect, useState } from "react";
import { chainConfig } from "@proviso/chain";
import Link from "next/link";
import { Icon } from "@/views/proviso/shared";
import { Glyph } from "@/views/proviso/glyph";
import { templates } from "@/lib/proviso/templates";
import { isPreIpo } from "@proviso/dsl";
import {
  newThesis,
  validateThesis,
  signalLabels,
  formatCondition,
  toSpec,
  exportJson,
  exampleMarkets,
  swapTokens,
  dollars,
  type Thesis,
  type Signal,
  type Condition,
} from "@/lib/proviso/domain";
import { useWorkspace } from "./provider";
import { SealPanel } from "./seal";
import { ReadBack, Writer } from "./writer";
import { Panel, PageTitle, Tag, Note, DefinitionList } from "./ui";

export function Composer() {
  const { data, ready, saveDraft } = useWorkspace();
  const [thesis, setThesis] = useState(newThesis),
    [tab, setTab] = useState<"builder" | "english">("builder"),
    [errors, setErrors] = useState<string[]>([]),
    [review, setReview] = useState(false),
    [showSpec, setShowSpec] = useState(false),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!ready || loaded) return;
    const id = new URLSearchParams(window.location.search).get("draft");
    const draft = data.drafts.find((d) => d.id === id);
    if (draft) setThesis(structuredClone(draft));
    setLoaded(true);
  }, [ready, loaded, data.drafts]);
  const update = (patch: Partial<Thesis>) => {
    setThesis((t) => ({ ...t, ...patch }));
    setReview(false);
    setErrors([]);
  };
  const editCondition = (id: string, patch: Partial<Condition>) =>
    update({
      conditions: thesis.conditions.map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    });
  const inspect = () => {
    const next = thesis;
    const issues = validateThesis(next, data.limits);
    setErrors(issues);
    setReview(issues.length === 0);
    if (!issues.length)
      requestAnimationFrame(() =>
        document.getElementById("rule-review")?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
          block: "start",
        }),
      );
  };
  const save = () => {
    const issues = validateThesis(thesis, data.limits);
    if (issues.length) {
      setErrors(issues);
      return;
    }
    const next = {
      ...thesis,
      id: thesis.id || crypto.randomUUID(),
      created: thesis.created || new Date().toISOString(),
    };
    if (saveDraft(next)) {
      setThesis(next);
      setReview(false);
    }
  };
  return (
    <>
      <PageTitle
        index="01 / WRITE A THESIS"
        title="Be precise. Before."
        description="Turn an observation into conditions, an action, and a defined way out."
      />
      <div className="w-composer-grid">
        <div>
          <Panel
            light
            label="THESIS FILE / WORKING DRAFT"
            icon="compose"
            className="w-composer"
          >
            {!thesis.id && (
              <section className="w-templates" aria-labelledby="templates-title">
                <span id="templates-title" className="w-label">
                  START FROM A TEMPLATE
                </span>
                <p className="w-templates-note">
                  Example structures, not recommendations. Every number is a placeholder to set
                  yourself, and each opens as an alert: nothing trades until you choose live.
                </p>
                {[
                  { label: null, list: templates.filter((t) => t.group !== "rwa") },
                  { label: "STOCKS, METALS AND OIL", list: templates.filter((t) => t.group === "rwa") },
                ].map(({ label, list }) => (
                  <div key={label ?? "crypto"}>
                    {label && <span className="w-label w-templates-group">{label}</span>}
                    <div className="w-templates-grid">
                      {list.map((tpl) => (
                        <button
                          key={tpl.id}
                          type="button"
                          className="w-template"
                          onClick={() => {
                            setThesis(tpl.thesis());
                            setTab("builder");
                            setReview(false);
                            setErrors([]);
                          }}
                        >
                          <strong>{tpl.name}</strong>
                          <span>{tpl.watches}</span>
                          <em>{tpl.does}</em>
                          {tpl.relies && <small><b>Relies on</b> {tpl.relies}</small>}
                          {tpl.fails && <small><b>How it fails</b> {tpl.fails}</small>}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            )}
            <label className="w-field title-field">
              Name your thesis
              <input
                value={thesis.title}
                maxLength={100}
                onChange={(e) => update({ title: e.target.value })}
                placeholder="A title for your conviction"
              />
            </label>
            <div className="w-segmented" role="group" aria-label="Thesis input">
              <button
                aria-pressed={tab === "builder"}
                onClick={() => {
                  setTab("builder");
                  setReview(false);
                }}
              >
                Rule builder
              </button>
              <button
                aria-pressed={tab === "english"}
                onClick={() => {
                  setTab("english");
                  setReview(false);
                }}
              >
                Plain English
              </button>
            </div>
            {tab === "english" ? (
              <Writer
                onUse={(spec, idea) => {
                  const next: Thesis = {
                    ...thesis,
                    spec,
                    title: thesis.title.trim() || idea.trim().slice(0, 80),
                    intent: spec.mode ?? "live",
                  };
                  setThesis(next);
                  const issues = validateThesis(next, data.limits);
                  setErrors(issues);
                  setReview(issues.length === 0);
                  if (!issues.length)
                    requestAnimationFrame(() =>
                      document.getElementById("rule-review")?.scrollIntoView({ behavior: "smooth", block: "start" }),
                    );
                }}
              />
            ) : (
              <>
                {thesis.spec && (
                  <div className="w-writer-banner">
                    <Note>
                      This draft holds a full rule (from the writer or a template), sealed exactly as read
                      back. The builder below isn&apos;t used for it; to change its numbers, describe it in
                      Plain English.
                    </Note>
                    <button className="w-text-link" onClick={() => update({ spec: undefined })}>
                      Clear it and build by hand <Icon name="close" size={14} />
                    </button>
                  </div>
                )}
                <div className="w-form-section">
                  <div className="w-number-title">
                    <span>01</span>
                    <h3>When the conditions hold.</h3>
                  </div>
                  <div className="w-condition-control">
                    <span>Match</span>
                    <select
                      aria-label="Condition matching"
                      value={thesis.match}
                      onChange={(e) =>
                        update({ match: e.target.value as Thesis["match"] })
                      }
                    >
                      <option value="all">All conditions</option>
                      <option value="any">Any condition</option>
                    </select>
                    <span>on</span>
                    <select
                      aria-label="Thesis market"
                      value={thesis.market}
                      onChange={(e) => update({ market: e.target.value })}
                    >
                      {exampleMarkets.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                  <div className="w-condition-list">
                    {thesis.conditions.map((c, i) => (
                      <div className="w-condition-line" key={c.id}>
                        <span>{String(i + 1).padStart(2, "0")}</span>
                        <select
                          aria-label={`Condition ${i + 1} signal`}
                          value={c.signal}
                          onChange={(e) =>
                            editCondition(c.id, {
                              signal: e.target.value as Signal,
                            })
                          }
                        >
                          {Object.entries(signalLabels).map(
                            ([value, label]) => (
                              <option value={value} key={value}>
                                {label}
                              </option>
                            ),
                          )}
                        </select>
                        <select
                          aria-label={`Condition ${i + 1} operator`}
                          value={c.op}
                          onChange={(e) =>
                            editCondition(c.id, {
                              op: e.target.value as Condition["op"],
                            })
                          }
                        >
                          {[">", "<", ">=", "<="].map((op) => (
                            <option value={op} key={op}>
                              {op}
                            </option>
                          ))}
                        </select>
                        <input
                          aria-label={`Condition ${i + 1} value`}
                          type="number"
                          step="any"
                          value={Number.isFinite(c.value) ? c.value : ""}
                          onChange={(e) =>
                            editCondition(c.id, {
                              value:
                                e.target.value === ""
                                  ? NaN
                                  : Number(e.target.value),
                            })
                          }
                        />
                        <button
                          aria-label={`Remove condition ${i + 1}`}
                          disabled={thesis.conditions.length === 1}
                          onClick={() =>
                            update({
                              conditions: thesis.conditions.filter(
                                (x) => x.id !== c.id,
                              ),
                            })
                          }
                        >
                          <Icon name="close" size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    className="w-add-condition"
                    disabled={thesis.conditions.length >= 8}
                    onClick={() =>
                      update({
                        conditions: [
                          ...thesis.conditions,
                          {
                            id: crypto.randomUUID(),
                            signal: "price",
                            op: ">",
                            value: 40,
                          },
                        ],
                      })
                    }
                  >
                    <Icon name="plus" size={15} />
                    Add a condition
                  </button>
                </div>
                <div className="w-form-section">
                  <div className="w-number-title">
                    <span>02</span>
                    <h3>Define the action.</h3>
                  </div>
                  <div className="w-form-grid">
                    <label className="w-field">
                      Venue
                      <select
                        value={thesis.swap ? (thesis.swap.withPerp ? "both" : "rhc") : "hl"}
                        onChange={(e) =>
                          update({
                            swap:
                              e.target.value === "hl"
                                ? undefined
                                : {
                                    tokenOut: thesis.swap?.tokenOut ?? swapTokens[0]!,
                                    slipPct: thesis.swap?.slipPct ?? 1,
                                    withPerp: e.target.value === "both",
                                  },
                          })
                        }
                      >
                        <option value="hl">Hyperliquid perp</option>
                        <option value="rhc">Robinhood Chain swap</option>
                        <option value="both">Both: perp + swap</option>
                      </select>
                    </label>
                  </div>
                  <div className="w-form-grid three">
                    {thesis.swap && (
                      <>
                        <label className="w-field">
                          Buy with USDG
                          <select
                            value={thesis.swap.tokenOut}
                            onChange={(e) =>
                              update({ swap: { ...thesis.swap!, tokenOut: e.target.value } })
                            }
                          >
                            {swapTokens.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="w-field">
                          Max slippage · %
                          <input
                            type="number"
                            min="0.1"
                            max="2"
                            step="0.1"
                            value={thesis.swap.slipPct || ""}
                            onChange={(e) =>
                              update({ swap: { ...thesis.swap!, slipPct: Number(e.target.value) } })
                            }
                          />
                        </label>
                      </>
                    )}
                    {(!thesis.swap || thesis.swap.withPerp) && (
                      <>
                        <label className="w-field">
                          Direction
                          <select
                            value={thesis.side}
                            onChange={(e) =>
                              update({ side: e.target.value as Thesis["side"] })
                            }
                          >
                            <option value="long">Long</option>
                            <option value="short">Short</option>
                          </select>
                        </label>
                        <label className="w-field">
                          Leverage · ×
                          <input
                            type="number"
                            min="1"
                            max="10"
                            value={thesis.leverage || ""}
                            onChange={(e) =>
                              update({ leverage: Number(e.target.value) })
                            }
                          />
                        </label>
                      </>
                    )}
                    <label className="w-field">
                      {thesis.swap?.withPerp ? "Allocation each · USD" : "Allocation · USD"}
                      <input
                        type="number"
                        min="1"
                        value={thesis.allocation || ""}
                        onChange={(e) =>
                          update({ allocation: Number(e.target.value) })
                        }
                      />
                    </label>
                  </div>
                  <Note>
                    {thesis.swap
                      ? `${chainConfig().label} swap through your session key (set it up on Connections; embedded wallets only). The stop and target sell it back${thesis.swap.withPerp ? " together with the perp, which sets the exit" : ""}.`
                      : "Perpetual market selection. Instrument availability, liquidity, and your approved limits must be verified before execution."}
                  </Note>
                </div>
                <div className="w-form-section">
                  <div className="w-number-title">
                    <span>03</span>
                    <h3>Decide how it ends.</h3>
                  </div>
                  <div className="w-form-grid">
                    <label className="w-field">
                      Stop distance · %
                      <input
                        type="number"
                        min="0.1"
                        max="99.9"
                        step="any"
                        value={thesis.stop || ""}
                        onChange={(e) =>
                          update({ stop: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label className="w-field">
                      Take-profit distance · %
                      <input
                        type="number"
                        min="0.1"
                        step="any"
                        value={thesis.take || ""}
                        onChange={(e) =>
                          update({ take: Number(e.target.value) })
                        }
                      />
                    </label>
                  </div>
                  <div className="exit-range">
                    <span>STOP −{thesis.stop}%</span>
                    <i />
                    <b>TRIGGER MARK</b>
                    <i />
                    <span>TAKE +{thesis.take}%</span>
                  </div>
                  <div className="w-form-grid">
                    <label className="w-field">
                      Trailing stop · % · optional
                      <input
                        type="number"
                        min="0.1"
                        max="50"
                        step="any"
                        placeholder="Off"
                        value={thesis.trail ?? ""}
                        onChange={(e) => update({ trail: e.target.value ? Number(e.target.value) : undefined })}
                      />
                    </label>
                    <label className="w-field">
                      Close after · hours · optional
                      <input
                        type="number"
                        min="1"
                        max="2160"
                        step="1"
                        placeholder="Off"
                        value={thesis.maxHoldHours ?? ""}
                        onChange={(e) => update({ maxHoldHours: e.target.value ? Number(e.target.value) : undefined })}
                      />
                    </label>
                    <label className="w-field">
                      Partial take at · % · optional
                      <input
                        type="number"
                        min="0.1"
                        step="any"
                        placeholder="Off"
                        value={thesis.partial?.pct ?? ""}
                        onChange={(e) =>
                          update({ partial: e.target.value ? { pct: Number(e.target.value), fraction: thesis.partial?.fraction ?? 0.5 } : undefined })
                        }
                      />
                    </label>
                    <label className="w-field">
                      Partial size · % of position
                      <input
                        type="number"
                        min="1"
                        max="99"
                        step="1"
                        disabled={!thesis.partial}
                        value={thesis.partial ? Math.round(thesis.partial.fraction * 100) : ""}
                        onChange={(e) => thesis.partial && update({ partial: { ...thesis.partial, fraction: Number(e.target.value) / 100 } })}
                      />
                    </label>
                  </div>
                </div>
              </>
            )}
            <div className="w-form-section">
              <div className="w-number-title">
                <span>04</span>
                <h3>Set the operating window.</h3>
              </div>
              <div className="w-form-grid three">
                <label className="w-field">
                  Expiry · days
                  <input
                    type="number"
                    min="1"
                    max="30"
                    value={thesis.expiryDays || ""}
                    onChange={(e) =>
                      update({ expiryDays: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="w-field">
                  Fires
                  <select
                    value={thesis.fire ?? "once"}
                    onChange={(e) =>
                      update({ fire: e.target.value as "once" | "repeat" })
                    }
                  >
                    <option value="once">Once</option>
                    <option value="repeat">Repeat</option>
                  </select>
                </label>
                {thesis.fire === "repeat" && (
                  <label className="w-field">
                    Cooldown · minutes
                    <input
                      type="number"
                      min="0"
                      max="43200"
                      value={thesis.cooldownMinutes}
                      onChange={(e) =>
                        update({ cooldownMinutes: Number(e.target.value) })
                      }
                    />
                  </label>
                )}
                <label className="w-field">
                  Intended mode
                  <select
                    value={thesis.intent}
                    onChange={(e) =>
                      update({ intent: e.target.value as Thesis["intent"] })
                    }
                  >
                    <option value="alert">Alert only</option>
                    <option value="paper">Paper (simulated, no money moves)</option>
                    <option value="live">Live, when connected</option>
                  </select>
                </label>
              </div>
              <Note>
                Fires once by default; repeat re-fires each time the
                conditions turn true again, after the cooldown. The 30-day
                expiry cap keeps unfired ideas accountable. Saving creates a draft in either intended
                mode; it does not submit an order.
              </Note>
            </div>
            {errors.length > 0 && (
              <div className="w-errors" role="alert">
                {errors.map((e) => (
                  <p key={e}>{e}</p>
                ))}
              </div>
            )}
            <div className="w-form-footer">
              <span>
                <Glyph name="privacy" size={18} />
                Nothing runs before confirmation.
              </span>
              {tab === "builder" && (
                <button className="w-button" onClick={inspect}>
                  Review the rules <Icon name="arrow" size={17} />
                </button>
              )}
            </div>
          </Panel>
        </div>
        <aside className="w-composer-aside">
          <Panel label="THE THESIS CONTRACT" icon="protocol">
            <h3>
              A call with
              <br />
              every clause.
            </h3>
            <DefinitionList
              items={[
                ["Condition", "What must become true"],
                ["Action", "Market, direction and size"],
                ["Exit", "Stop and take-profit distances"],
                ["Expiry", "The end of the idea’s validity"],
              ]}
            />
            <div className="w-clause-example">
              <span className="w-label">YOUR CURRENT CONDITIONS</span>
              {thesis.conditions.map((c) => (
                <code key={c.id}>{formatCondition(c, thesis.market)}</code>
              ))}
            </div>
          </Panel>
          <Panel label="YOUR RISK BOUNDARY" icon="limits">
            <DefinitionList
              items={[
                ["Per idea", dollars(data.limits.maxAllocation)],
                ["Leverage", `${data.limits.maxLeverage}× maximum`],
                ["Daily loss", dollars(data.limits.dailyLoss)],
              ]}
            />
            <Link href="/dashboard/controls/" className="w-text-link">
              Adjust your limits <Icon name="diagonal" size={14} />
            </Link>
          </Panel>
          <div className="w-side-note">
            <Glyph name="signal" size={27} />
            <h4>More than price.</h4>
            <p>
              The full rule design also covers time windows, sessions, earnings,
              corporate actions, cross-venue gaps, and later X-post triggers.
            </p>
            <Link href="/protocol/#language">
              Explore the full language <Icon name="arrow" size={15} />
            </Link>
          </div>
        </aside>
      </div>
      <section
        id="rule-review"
        className={`w-review-zone ${review ? "ready" : ""}`}
      >
        <div className="w-review-marker">
          <Glyph name="proof" size={34} />
          <span className="w-label">05 / READ IT BACK</span>
        </div>
        {review ? (
          <>
            <div className="w-review-heading">
              <h2>{thesis.title}</h2>
              <Tag>RULES VALIDATED</Tag>
            </div>
            {[...new Set(JSON.stringify(toSpec(thesis)).match(/xyz:[A-Z0-9]+/g) ?? [])].filter(isPreIpo).map((coin) => (
              <Note key={coin}>
                <strong>{coin} is a pre-IPO market.</strong> Its price comes only from its own order book on Hyperliquid, with no
                outside market to check it against, so it can swing hard on thin trading. Live trades here are capped at 2×, and
                Proviso closes the position if funding costs more than 0.5% of its value.
              </Note>
            ))}
            {thesis.spec ? (
              <ReadBack spec={thesis.spec} />
            ) : (
            <div className="w-review-grid">
              <div>
                <span className="w-label">
                  WHEN / {thesis.match.toUpperCase()}
                </span>
                {thesis.conditions.map((c) => (
                  <code key={c.id}>{formatCondition(c, thesis.market)}</code>
                ))}
              </div>
              <div>
                <span className="w-label">
                  THEN {thesis.intent === "paper" ? "· PAPER (SIMULATED)" : thesis.intent === "alert" ? "· ALERT ONLY" : "· LIVE"}
                </span>
                <strong>
                  {[
                    ...(!thesis.swap || thesis.swap.withPerp ? [`${thesis.side} ${thesis.market} · ${thesis.leverage}×`] : []),
                    ...(thesis.swap ? [`swap USDG → ${thesis.swap.tokenOut} · max ${thesis.swap.slipPct}% slip`] : []),
                  ].join(" + ")}
                </strong>
                <p>{dollars(thesis.allocation)} allocation</p>
              </div>
              <div>
                <span className="w-label">EXIT & EXPIRY</span>
                <strong>
                  −{thesis.stop}% / +{thesis.take}%
                </strong>
                <p>
                  Trigger-mark reference · {thesis.expiryDays} days
                  {thesis.partial && ` · take ${Math.round(thesis.partial.fraction * 100)}% at +${thesis.partial.pct}%`}
                  {thesis.trail && ` · trailing ${thesis.trail}%`}
                  {thesis.maxHoldHours && ` · close after ${thesis.maxHoldHours}h`}
                </p>
              </div>
            </div>
            )}
            <div className="w-review-actions">
              <button
                className="w-text-link"
                onClick={() => setShowSpec(!showSpec)}
              >
                {showSpec ? "Hide" : "Inspect"} rule JSON{" "}
                <Icon name="chevron" size={14} />
              </button>
              <button
                className="w-button secondary"
                onClick={() =>
                  exportJson("proviso-thesis-spec.json", {
                    kind: "unsigned-local-draft",
                    spec: toSpec(thesis),
                  })
                }
              >
                Export draft <Icon name="download" size={16} />
              </button>
              <button className="w-button" disabled={!ready} onClick={save}>
                Save {thesis.id ? "changes" : "thesis"}{" "}
                <Icon name="check" size={17} />
              </button>
            </div>
            <SealPanel
              thesis={thesis}
              onPromote={() => update({ intent: "live", spec: thesis.spec ? { ...thesis.spec, mode: "live" } : undefined })}
              saved={data.drafts.some((d) => d.id === thesis.id && JSON.stringify(toSpec(d)) === JSON.stringify(toSpec(thesis)))}
            />
            {showSpec && (
              <pre className="w-code">
                {JSON.stringify(toSpec(thesis), null, 2)}
              </pre>
            )}
          </>
        ) : (
          <div className="w-review-awaiting">
            <h3>A clear decision starts with a clear rule.</h3>
            <p>
              Review the draft above to see the exact conditions, action, and
              exits together.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
