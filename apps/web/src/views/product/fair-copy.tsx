"use client";
import { useState } from "react";
import { Glyph } from "@/views/proviso/glyph";
import {
  ProductShell,
  ProductHero,
  ProductSection,
  ProductCTA,
} from "./site-shell";
export function CopyProduct() {
  const [depth, setDepth] = useState(100000),
    [requested, setRequested] = useState(30000);
  const valid =
    Number.isFinite(depth) &&
    depth > 0 &&
    Number.isFinite(requested) &&
    requested > 0;
  const cap = valid ? depth * 0.2 : 0;
  const fraction = valid ? Math.min(1, cap / requested) : 0;
  return (
    <ProductShell className="copy-product">
      <ProductHero
        index="03"
        kicker="Fair Copy"
        title={
          <>
            Followers first.
            <br />
            <em>Caller second.</em>
          </>
        }
        description="An explicit submission sequence. Your own allocation and limits. A shared reference for exits, with the timing of both waves on record."
      >
        <div className="p-wave-sculpture">
          <div className="p-wave-track followers">
            <span>01 / FOLLOWERS</span>
            {Array.from({ length: 12 }, (_, i) => (
              <i key={i} />
            ))}
          </div>
          <div className="p-wave-track caller">
            <span>02 / CALLER</span>
            <b />
          </div>
          <small>THE SUBMISSION SEQUENCE</small>
        </div>
      </ProductHero>
      <ProductSection
        number="01"
        label="Before the first wave"
        title={
          <>
            Your copy.
            <br />
            Your conditions.
          </>
        }
      >
        <div className="p-copy-intro">
          <p>
            Following an idea does not mean surrendering its sizing. Each
            follower uses their own account, allocation, direction policy, and
            leverage ceiling.
          </p>
          <div>
            <Glyph name="privacy" size={32} />
            <h3>A sealed idea needs a boundary.</h3>
            <p>
              Automatic following requires a matching allow-list of coins, side,
              and maximum leverage. Without that match, the design asks for
              confirmation instead of silently placing an order.
            </p>
          </div>
        </div>
        <div className="p-wave-story">
          {[
            [
              "01",
              "Eligible followers",
              "Resolve active follows and each follower’s rules.",
            ],
            [
              "02",
              "Capacity check",
              "Cap notional against order-book depth and allocate pro-rata when needed.",
            ],
            [
              "03",
              "Follower submission",
              "Submit wave one within the specified IOC price band.",
            ],
            [
              "04",
              "Caller submission",
              "Wait for acknowledgements, then submit the linked caller account.",
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
        className="p-capacity-section"
        id="capacity-model"
        data-chapter="Capacity model"
      >
        <div>
          <span className="eyebrow">02 / CAPACITY MODEL</span>
          <h2>
            A wave should
            <br />
            respect its market.
          </h2>
          <p>
            The capacity rule caps total notional at 20% of top-ten-level book
            depth, with pro-rata sizing if demand exceeds that cap. Explore the
            allocation arithmetic using your own inputs.
          </p>
          <small>
            Calculated from your inputs. Actual depth changes with the market.
          </small>
        </div>
        <div className="p-capacity-tool">
          <label>
            Top-ten-level depth · USD
            <input
              type="number"
              value={depth || ""}
              min="1"
              onChange={(e) => setDepth(Number(e.target.value))}
            />
          </label>
          <label>
            Requested batch notional · USD
            <input
              type="number"
              value={requested || ""}
              min="1"
              onChange={(e) => setRequested(Number(e.target.value))}
            />
          </label>
          <div className="capacity-result">
            <span>MAXIMUM BATCH</span>
            <strong>
              {valid
                ? "$" +
                  cap.toLocaleString("en-US", { maximumFractionDigits: 0 })
                : "—"}
            </strong>
            <div className="capacity-meter">
              <i style={{ width: `${fraction * 100}%` }} />
            </div>
            <p>
              {valid
                ? `${(fraction * 100).toFixed(1)}% of each requested allocation fits this capacity limit.`
                : "Enter two positive values to inspect the capacity rule."}
            </p>
          </div>
        </div>
      </section>
      <ProductSection
        number="03"
        label="A shared exit basis"
        title={
          <>
            One reference.
            <br />
            Separate fills.
          </>
        }
      >
        <div className="p-exit-reference">
          <span>TRIGGER MARK / P₀</span>
          <div>
            <b>STOP</b>
            <i />
            <strong>P₀</strong>
            <i />
            <b>TARGET</b>
          </div>
          <small>Followers’ reduce-only closes → caller’s close</small>
        </div>
        <div className="p-prose-columns">
          <div>
            <h3>The exit rule is calculated once.</h3>
            <p>
              Copied stops and targets use the trigger mark as a common
              reference. This can differ from a follower’s individual entry. A
              wider native stop, set at twice the stop distance, is specified as
              a disaster backstop.
            </p>
          </div>
          <div>
            <h3>Outside activity should be visible.</h3>
            <p>
              A close outside Proviso on the linked caller account triggers
              follower closes and a flag. The optional Copy Promise states that
              copied positions will be managed through Proviso. Other wallets
              remain outside that promise’s observable boundary.
            </p>
          </div>
        </div>
        <div className="p-limit-statement">
          <strong>Submission order is not fill equality.</strong>
          <p>
            Separate accounts can receive different fills. Markets move between
            waves. Robinhood Chain sequencing and cross-account ordering require
            verification. Following and caller incentives carry additional
            risks.
          </p>
        </div>
      </ProductSection>
      <ProductCTA
        title="Write your own following policy."
        body="Set your allocation, market, direction, leverage, and sealed-idea preferences."
        href="/dashboard/fair-copy/"
        label="Explore Fair Copy"
      />
    </ProductShell>
  );
}
