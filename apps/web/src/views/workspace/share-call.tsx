"use client";
// Share buttons for one sealed call (TU-13): X, Telegram, copy link, open the public card.
import { useState } from "react";
import { shareLinks } from "@/lib/proviso/call";
import { Icon } from "@/views/proviso/shared";

/** Share a sealed call. The link opens its public page, whose card X and Telegram preview. */
export function ShareCall({ id, state }: { id: string; state: string }) {
  return <ShareButtons links={shareLinks(id, state)} />;
}

/** X, Telegram, copy and open buttons for any public link. */
export function ShareButtons({ links: l, openLabel = "Open the card" }: { links: { x: string; telegram: string; url: string }; openLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(l.url);
    } catch {
      const t = document.createElement("textarea");
      t.value = l.url;
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="w-share">
      <a className="w-button" href={l.x} target="_blank" rel="noopener noreferrer">
        Share on X <Icon name="x" size={15} />
      </a>
      <a className="w-button secondary" href={l.telegram} target="_blank" rel="noopener noreferrer">
        Telegram <Icon name="telegram" size={15} />
      </a>
      <button className="w-button secondary" type="button" onClick={copy}>
        {copied ? "Copied" : "Copy link"} <Icon name={copied ? "check" : "copy"} size={15} />
      </button>
      <a className="w-text-link" href={l.url} target="_blank" rel="noopener noreferrer">
        {openLabel} <Icon name="diagonal" size={14} />
      </a>
    </div>
  );
}
