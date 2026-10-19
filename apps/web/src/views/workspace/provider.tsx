"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  initialWorkspace,
  isThesis,
  newThesis,
  validateCopy,
  validateRisk,
  type Workspace,
  type Thesis,
  type RiskLimits,
  type CopyPolicy,
  type LocalEvent,
} from "@/lib/proviso/domain";
import { isDraft, validateLimits } from "@/views/proviso/rules";

const KEY = "proviso:workspace:v2";
type Store = {
  data: Workspace;
  ready: boolean;
  notice: string;
  clearNotice: () => void;
  saveDraft: (draft: Thesis) => boolean;
  removeDraft: (id: string) => void;
  saveLimits: (limits: RiskLimits) => boolean;
  saveCopy: (copy: CopyPolicy) => boolean;
  log: (kind: LocalEvent["kind"], title: string, detail: string) => void;
};
const Context = createContext<Store | null>(null);
export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error("WorkspaceProvider is required.");
  return value;
}
function load(): Workspace {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const value = JSON.parse(raw);
    if (
      value.version !== 2 ||
      !Array.isArray(value.drafts) ||
      !validateRisk(value.limits) ||
      !validateCopy(value.copy)
    )
      throw new Error("Invalid workspace");
    return {
      ...value,
      drafts: value.drafts.filter(isThesis),
      events: Array.isArray(value.events)
        ? value.events
            .filter(
              (e: LocalEvent) =>
                e &&
                typeof e.title === "string" &&
                typeof e.detail === "string" &&
                typeof e.at === "string",
            )
            .slice(0, 200)
        : [],
    };
  }
  const data = structuredClone(initialWorkspace);
  const drafts = JSON.parse(localStorage.getItem("proviso:drafts:v1") || "[]");
  if (Array.isArray(drafts))
    data.drafts = drafts.filter(isDraft).map((d) => ({
      ...newThesis(),
      id: d.id,
      title: `${d.rule.market} funding thesis`,
      market: d.rule.market,
      side: d.rule.side,
      leverage: d.rule.leverage,
      allocation: d.size,
      stop: d.rule.stop,
      take: d.rule.take,
      conditions: [
        { id: "funding", signal: "funding", op: "<", value: 0 },
        { id: "price", signal: "price", op: ">", value: d.rule.price },
      ],
      created: d.created,
      updated: d.created,
    }));
  const limits = JSON.parse(
    localStorage.getItem("proviso:limits:v1") || "null",
  );
  if (limits && validateLimits(limits))
    data.limits = {
      ...data.limits,
      maxAllocation: limits.size,
      maxLeverage: limits.leverage,
      dailyLoss: limits.loss,
    };
  return data;
}
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Workspace>(initialWorkspace),
    [ready, setReady] = useState(false),
    [notice, setNotice] = useState("");
  useEffect(() => {
    try {
      setData(load());
    } catch {
      setNotice(
        "Stored workspace data could not be read. Your existing storage has not been changed.",
      );
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 7000);
    return () => clearTimeout(id);
  }, [notice]);
  const persist = (next: Workspace, message: string) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
      setData(next);
      setNotice(message);
      return true;
    } catch {
      setNotice(
        "This browser could not save the change. Export your work and check browser storage settings.",
      );
      return false;
    }
  };
  const event = (
    kind: LocalEvent["kind"],
    title: string,
    detail: string,
  ): LocalEvent => ({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    kind,
    title,
    detail,
  });
  const append = (e: LocalEvent) => [e, ...data.events].slice(0, 200);
  return (
    <Context.Provider
      value={{
        data,
        ready,
        notice,
        clearNotice: () => setNotice(""),
        saveDraft: (d) => {
          const now = new Date().toISOString();
          const draft = {
            ...d,
            id: d.id || crypto.randomUUID(),
            created: d.created || now,
            updated: now,
          };
          return persist(
            {
              ...data,
              drafts: [draft, ...data.drafts.filter((x) => x.id !== draft.id)],
              events: append(
                event(
                  "draft",
                  data.drafts.some((x) => x.id === d.id)
                    ? "Thesis updated"
                    : "Thesis drafted",
                  `${d.title} · ${d.market} · ${d.allocation} USD`,
                ),
              ),
            },
            "Thesis saved to this browser. No order or stamp was submitted.",
          );
        },
        removeDraft: (id) =>
          persist(
            {
              ...data,
              drafts: data.drafts.filter((d) => d.id !== id),
              events: append(
                event(
                  "draft",
                  "Draft removed",
                  "Removed from your working theses.",
                ),
              ),
            },
            "Draft removed from this browser.",
          ),
        saveLimits: (limits) =>
          persist(
            {
              ...data,
              limits,
              events: append(
                event(
                  "limits",
                  "Risk limits updated",
                  `Allocation ${limits.maxAllocation} USD · maximum ${limits.maxLeverage}× leverage`,
                ),
              ),
            },
            "Risk limits saved.",
          ),
        saveCopy: (copy) =>
          persist(
            {
              ...data,
              copy,
              events: append(
                event(
                  "copy",
                  "Copy policy updated",
                  `${copy.markets.join(", ")} · ${copy.allocation} USD per idea`,
                ),
              ),
            },
            "Copy preferences saved locally. No caller is being followed.",
          ),
        log: (kind, title, detail) => {
          persist(
            { ...data, events: append(event(kind, title, detail)) },
            "Recorded in your activity log.",
          );
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
