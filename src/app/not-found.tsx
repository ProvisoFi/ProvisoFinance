import Link from "next/link";
export default function NotFound() {
  return (
    <main className="not-found">
      <span className="eyebrow">PROVISO / 404</span>
      <h1>Off the record.</h1>
      <p>This page does not exist. Your next call is still ahead.</p>
      <Link href="/" className="button light">
        Back to Proviso
      </Link>
    </main>
  );
}
