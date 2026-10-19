import { expect, test } from "bun:test";
import { isPushEndpoint } from "./push.ts";

test("only known Web Push services are accepted", () => {
  for (const ok of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QGt",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ])
    expect(isPushEndpoint(ok)).toBe(true);
  for (const bad of [
    "http://fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evilnotify.windows.com/x",
    "https://notify.windows.com/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/x",
    "not a url",
  ])
    expect(isPushEndpoint(bad)).toBe(false);
});
