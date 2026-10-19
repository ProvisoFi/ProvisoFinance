import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/views/proviso/shared";
import { Glyph, type GlyphName } from "@/views/proviso/glyph";

export function Panel({
  children,
  label,
  icon,
  className = "",
  light = false,
  aside,
}: {
  children: ReactNode;
  label?: string;
  icon?: GlyphName;
  className?: string;
  light?: boolean;
  aside?: ReactNode;
}) {
  return (
    <section className={`w-panel ${light ? "w-paper" : ""} ${className}`}>
      <div className="w-panel-edge" aria-hidden="true" />
      {label && (
        <div className="w-panel-head">
          <span className="w-label">{label}</span>
          {aside || (icon && <Glyph name={icon} size={23} />)}
        </div>
      )}
      <div className="w-panel-body">{children}</div>
    </section>
  );
}
export function PageTitle({
  index,
  title,
  description,
  action,
}: {
  index: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="w-page-title">
      <div>
        <span className="w-label">WORKSPACE / {index}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Action({
  href,
  children,
  secondary = false,
}: {
  href: string;
  children: ReactNode;
  secondary?: boolean;
}) {
  return (
    <Link className={`w-button ${secondary ? "secondary" : ""}`} href={href}>
      {children}
      <Icon name="diagonal" size={16} />
    </Link>
  );
}
export function Tag({
  children,
  solid = false,
}: {
  children: ReactNode;
  solid?: boolean;
}) {
  return <span className={`w-tag ${solid ? "solid" : ""}`}>{children}</span>;
}
export function Note({ children }: { children: ReactNode }) {
  return <p className="w-note">{children}</p>;
}
export function DefinitionList({ items }: { items: [string, string][] }) {
  return (
    <dl className="w-definition">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
export function SectionTitle({
  title,
  caption,
  link,
}: {
  title: string;
  caption?: string;
  link?: [string, string];
}) {
  return (
    <div className="w-section-title">
      <div>
        <h2>{title}</h2>
        {caption && <p>{caption}</p>}
      </div>
      {link && (
        <Link href={link[1]}>
          {link[0]} <Icon name="arrow" size={16} />
        </Link>
      )}
    </div>
  );
}
export function Empty({
  icon,
  title,
  body,
  children,
}: {
  icon: GlyphName;
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className="w-empty">
      <Glyph name={icon} size={38} />
      <h3>{title}</h3>
      <p>{body}</p>
      {children}
    </div>
  );
}
export function Lifecycle({
  active = 0,
  compact = false,
}: {
  active?: number;
  compact?: boolean;
}) {
  const stages: [GlyphName, string, string][] = [
    ["compose", "Write", "Define the idea"],
    ["protocol", "Review", "Confirm every rule"],
    ["proof", "Seal", "Commit on-chain"],
    ["signal", "Evaluate", "Wait for conditions"],
    ["copy", "Execute", "Followers → caller"],
    ["records", "Record", "Reveal the result"],
  ];
  return (
    <div className={`lifecycle ${compact ? "compact" : ""}`}>
      {stages.map(([icon, label, sub], i) => (
        <div className={i === active ? "current" : ""} key={label}>
          <div className="lifecycle-mark">
            <Glyph name={icon} size={compact ? 22 : 28} />
          </div>
          <span className="w-label">0{i + 1}</span>
          <strong>{label}</strong>
          <small>{sub}</small>
        </div>
      ))}
    </div>
  );
}
export function WaveDiagram({ step = 1 }: { step?: number }) {
  return (
    <div
      className="wave-diagram"
      aria-label={`Fair Copy sequence, step ${step}`}
    >
      <div className="wave-axis">
        <span>TRIGGER MARK</span>
        <strong>P₀</strong>
        <i />
      </div>
      <div className={`wave-lane ${step === 1 ? "selected" : ""}`}>
        <span className="w-label">WAVE 01</span>
        <div className="wave-nodes">
          {Array.from({ length: 9 }, (_, i) => (
            <i key={i} style={{ animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
        <b>Followers</b>
        <small>Own account · own limits</small>
      </div>
      <div className={`wave-lane caller ${step === 2 ? "selected" : ""}`}>
        <span className="w-label">WAVE 02</span>
        <div className="wave-nodes">
          <i />
        </div>
        <b>Caller</b>
        <small>After acknowledgements</small>
      </div>
      <div className="wave-result">
        <span className="w-label">SHARED EXIT BASIS</span>
        <strong>
          One reference.
          <br />
          Separate fills.
        </strong>
      </div>
    </div>
  );
}
export function SealDiagram() {
  return (
    <div className="seal-diagram">
      <div className="seal-branch">
        <span className="w-label">ENTRY</span>
        <span className="seal-hash">
          0x<span>████ ████ ████</span>
        </span>
        <small>Private until fire</small>
      </div>
      <div className="seal-junction">
        <Glyph name="proof" size={38} />
        <span>ONE SIGNED STAMP</span>
      </div>
      <div className="seal-branch exit">
        <span className="w-label">EXIT</span>
        <span className="seal-hash">
          0x<span>████ ████ ████</span>
        </span>
        <small>Private until close</small>
      </div>
    </div>
  );
}
