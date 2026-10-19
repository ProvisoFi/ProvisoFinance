// Web Push endpoints the ops sender will POST to. Anything else is refused at subscribe time
// and again before sending, so a stored URL can't make the enclave call an arbitrary host.
const EXACT = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const SUFFIXES = [".notify.windows.com", ".push.apple.com"];

export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return EXACT.has(host) || SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}
