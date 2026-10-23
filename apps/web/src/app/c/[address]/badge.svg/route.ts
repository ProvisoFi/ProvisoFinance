// The caller's live record badge, served at /c/<address>/badge.svg (a file extension skips the trailing-slash redirect).
import { LADDER } from "@proviso/api/standing";
import { badgeSvg } from "@/lib/proviso/badge";
import { callerLabel, standingText } from "@/lib/proviso/call";
import { getProfile } from "@/lib/server/call";

export const revalidate = 300;

export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const p = await getProfile(address);
  if (!p) return new Response("Unknown caller", { status: 404 });
  const t = standingText(p.standing, LADDER);
  const f = p.copy?.followerReturnPct;
  const svg = badgeSvg({
    who: callerLabel(p.caller, p.displayName),
    calls: p.standing.sealedCalls,
    returnText: t.returnText,
    scoreText: t.scoreText,
    followersText: f == null ? null : `${f > 0 ? "+" : f < 0 ? "−" : ""}${Math.abs(f).toFixed(1)}%`,
  });
  return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=300, s-maxage=300" } });
}
