"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/views/proviso/shared";
import { Glyph } from "@/views/proviso/glyph";
import { parseRule } from "@/views/proviso/rules";
import {
  newThesis,
  validateThesis,
  signalLabels,
  formatCondition,
  toSpec,
  exportJson,
  exampleMarkets,
  dollars,
  type Thesis,
  type Signal,
  type Condition,
} from "@/lib/proviso/domain";
import { useWorkspace } from "./provider";
import { Panel, PageTitle, Tag, Note, DefinitionList } from "./ui";

const sample =
  "If HYPE funding turns negative while price holds above $40, long HYPE 3×, stop −6%, take +15%.";
export function Composer() {
  const { data, ready, saveDraft } = useWorkspace();
  const [thesis, setThesis] = useState(newThesis),
    [tab, setTab] = useState<"builder" | "english">("builder"),
    [text, setText] = useState(sample),
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
    let next = thesis;
    if (tab === "english") {
      const result = parseRule(text);
      if (result.error || !result.rule) {
        setErrors([result.error || "Check the idea wording."]);
        return;
      }
      const r = result.rule;
      next = {
        ...thesis,
        market: r.market,
        side: r.side,
        leverage: r.leverage,
        stop: r.stop,
        take: r.take,
        match: "all",
        conditions: [
          { id: "c1", signal: "funding", op: "<", value: 0 },
          { id: "c2", signal: "price", op: ">", value: r.price },
        ],
      };
      setThesis(next);
    }
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
              <div className="w-english">
                <label className="w-label" htmlFor="idea-text">
                  YOUR IDEA
                </label>
                <textarea
                  id="idea-text"
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setReview(false);
                  }}
                  maxLength={1200}
                />
                <button
                  className="w-text-link"
                  onClick={() => {
                    setText(sample);
                    setReview(false);
                  }}
                >
                  Use the funding-reversal pattern{" "}
                  <Icon name="diagonal" size={14} />
                </button>
                <Note>
                  Use this sentence pattern for the text-to-rule shortcut. The
                  structured builder gives you direct control over each clause.
                </Note>
              </div>
            ) : (
              <>
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
                  <div className="w-form-grid three">
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
                    <label className="w-field">
                      Allocation · USD
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
                    Perpetual market selection. Instrument availability,
                    liquidity, and your approved limits must be verified before
                    execution.
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
                <label className="w-field">
                  Intended mode
                  <select
                    value={thesis.intent}
                    onChange={(e) =>
                      update({ intent: e.target.value as Thesis["intent"] })
                    }
                  >
                    <option value="alert">Alert only</option>
                    <option value="live">Live, when connected</option>
                  </select>
                </label>
              </div>
              <Note>
                Single fire by default. The 30-day expiry cap keeps unfired
                ideas accountable. Saving creates a draft in either intended
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
              <button className="w-button" onClick={inspect}>
                Review the rules <Icon name="arrow" size={17} />
              </button>
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
                <span className="w-label">THEN</span>
                <strong>
                  {thesis.side} {thesis.market} · {thesis.leverage}×
                </strong>
                <p>{dollars(thesis.allocation)} allocation</p>
              </div>
              <div>
                <span className="w-label">EXIT & EXPIRY</span>
                <strong>
                  −{thesis.stop}% / +{thesis.take}%
                </strong>
                <p>Trigger-mark reference · {thesis.expiryDays} days</p>
              </div>
            </div>
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
