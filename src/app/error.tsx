"use client";
export default function Error({ reset }: { reset: () => void }) {
  return (
    <main className="not-found">
      <span className="eyebrow">PROVISO / SOMETHING INTERRUPTED</span>
      <h1>Let’s try again.</h1>
      <p>The page could not finish loading.</p>
      <button className="button light" onClick={reset}>
        Reload the view
      </button>
    </main>
  );
}
