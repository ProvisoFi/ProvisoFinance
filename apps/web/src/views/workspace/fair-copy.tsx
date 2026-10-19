"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/views/proviso/shared";
import { exampleMarkets, validateCopy, dollars } from "@/lib/proviso/domain";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "@/lib/backend/account";
import { useTRPC } from "@/lib/backend/api";
import { FollowCaller } from "./follows";
import { useWorkspace } from "./provider";
import {
  Panel,
  PageTitle,
  Action,
  Tag,
  WaveDiagram,
  DefinitionList,
  Note,
} from "./ui";

const steps = [
  [
    "Eligibility",
    "A follower’s allow-list, direction, leverage, and allocation must match the revealed entry. Otherwise a sealed idea needs confirmation.",
  ],
  [
    "Followers first",
    "The first wave submits follower orders in their own accounts. The design waits for acknowledgements before the caller wave.",
  ],
  [
    "Caller second",
    "The caller’s linked account follows. This does not control other wallets, and execution across accounts is not atomic.",
  ],
  [
    "Shared exit reference",
    "Stops and targets use the trigger mark. Followers close before the caller. A wider native stop provides a separate disaster backstop.",
  ],
];
export function FairCopyWorkspace() {
  const { data, ready, saveCopy } = useWorkspace();
  const trpc = useTRPC();
  const signedIn = useAccount().status === "signed-in";
  const follows = useQuery({ ...trpc.follow.mine.queryOptions(), enabled: signedIn });
  const [policy, setPolicy] = useState(data.copy),
    [step, setStep] = useState(1),
    [error, setError] = useState("");
  useEffect(() => {
    if (ready) setPolicy(data.copy);
  }, [ready, data.copy]);
  const update = (patch: Partial<typeof policy>) => {
    setPolicy({ ...policy, ...patch });
    setError("");
  };
  return (
    <>
      <PageTitle
        index="04 / FAIR COPY"
        title="The order is the principle."
        description="A caller’s idea. Your account. An explicit sequence for entry and exit."
        action={
          <Action secondary href="/fair-copy/">
            Fair Copy explained
          </Action>
        }
      />
      <div className="w-copy-top">
        <div className="w-copy-statement">
          <span className="w-label">ONE IDEA / TWO WAVES</span>
          <h2>
            Followers first.
            <br />
            <span>Caller second.</span>
          </h2>
          <p>
            Ordering should be visible, not assumed. Proviso’s design puts
            follower orders ahead of the caller’s linked account and records the
            timing of both waves.
          </p>
        </div>
        <WaveDiagram step={step} />
      </div>
      <div className="w-step-selector">
        {steps.map(([title], i) => (
          <button
            key={title}
            aria-pressed={step === i}
            onClick={() => setStep(i)}
          >
            <span>0{i + 1}</span>
            <strong>{title}</strong>
            <Icon name="arrow" size={16} />
          </button>
        ))}
      </div>
      <div className="w-step-description">
        <Tag>STEP 0{step + 1}</Tag>
        <p>{steps[step][1]}</p>
      </div>
      <div className="w-columns two-one">
        <Panel light label="YOUR FOLLOWING POLICY" icon="copy">
          <h3>Set the terms of your participation.</h3>
          <p>
            Define the limits every copied idea must respect. Save your policy
            before connecting a caller.
          </p>
          <div className="w-form-grid">
            <label className="w-field">
              Per-idea allocation · USD
              <input
                type="number"
                min="1"
                value={policy.allocation || ""}
                onChange={(e) => update({ allocation: Number(e.target.value) })}
              />
            </label>
            <label className="w-field">
              Maximum leverage · ×
              <input
                type="number"
                min="1"
                max="10"
                value={policy.leverage || ""}
                onChange={(e) => update({ leverage: Number(e.target.value) })}
              />
            </label>
            <label className="w-field">
              Allowed direction
              <select
                value={policy.side}
                onChange={(e) =>
                  update({ side: e.target.value as typeof policy.side })
                }
              >
                <option value="both">Long & short</option>
                <option value="long">Long only</option>
                <option value="short">Short only</option>
              </select>
            </label>
            <label className="w-field">
              Sealed ideas
              <select
                value={policy.sealed}
                onChange={(e) =>
                  update({ sealed: e.target.value as typeof policy.sealed })
                }
              >
                <option value="confirm">Confirm each idea</option>
                <option value="allowlist">Match my allow-list</option>
              </select>
            </label>
          </div>
          <fieldset className="w-checklist">
            <legend>Market allow-list</legend>
            {exampleMarkets.map((m) => (
              <label key={m}>
                <input
                  type="checkbox"
                  checked={policy.markets.includes(m)}
                  onChange={(e) =>
                    update({
                      markets: e.target.checked
                        ? [...policy.markets, m]
                        : policy.markets.filter((x) => x !== m),
                    })
                  }
                />
                {m}
              </label>
            ))}
          </fieldset>
          {error && (
            <p className="w-errors" role="alert">
              {error}
            </p>
          )}
          <div className="w-form-footer">
            <Note>
              {signedIn && follows.data
                ? `Active follows: ${follows.data.filter((f) => f.active).length}`
                : "Active follows: 0 · No connected caller"}
            </Note>
            <button
              className="w-button"
              disabled={!ready}
              onClick={() => {
                if (!validateCopy(policy)) {
                  setError(
                    "Choose at least one market, a positive allocation and leverage from 1× to 10×.",
                  );
                  return;
                }
                if (
                  policy.allocation > data.limits.maxAllocation ||
                  policy.leverage > data.limits.maxLeverage
                ) {
                  setError(
                    `Stay within your ${dollars(data.limits.maxAllocation)} allocation and ${data.limits.maxLeverage}× leverage limits.`,
                  );
                  return;
                }
                saveCopy(policy);
              }}
            >
              Save policy <Icon name="check" size={16} />
            </button>
          </div>
        </Panel>
        <Panel label="EXECUTION GUARDRAILS" icon="position">
          <DefinitionList
            items={[
              ["Batch cap", "20% of top-10 book depth"],
              ["Entry order band", "Mark ±1% IOC"],
              ["When capped", "Pro-rata allocation"],
              ["Copied exits", "One trigger-mark reference"],
              ["Native backstop", "2× stop distance"],
              ["Caller closes elsewhere", "Attempt follower closes"],
            ]}
          />
          <Note>
            These rules define the execution policy. Fills can differ between
            waves; no caller is connected to this workspace.
          </Note>
        </Panel>
      </div>
      <FollowCaller />
      <div className="w-columns equal">
        <Panel label="COPY PROMISE" icon="privacy">
          <h3>A visible commitment from the caller.</h3>
          <p>
            The optional badge says copied positions will be managed through
            Proviso. Outside closes or opposite trades on the linked account are
            flagged. Unrelated wallets remain outside the system’s view.
          </p>
        </Panel>
        <Panel label="CONTEXT BEHIND EVERY CALL" icon="records">
          <h3>A complete view of participation.</h3>
          <p>
            Inspect the caller-to-follower size ratio, sequence of submissions,
            and disclosure history. A record should preserve the context around
            the outcome.
          </p>
          <Link className="w-text-link" href="/records/">
            Explore the record <Icon name="arrow" size={15} />
          </Link>
        </Panel>
      </div>
    </>
  );
}
