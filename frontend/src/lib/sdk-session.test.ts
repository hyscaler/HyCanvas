// Regression gate for the session-death bug: concurrent 401s (multiple tabs,
// StrictMode double-bootstrap, panels loading in parallel) must funnel into
// ONE POST /v1/auth/refresh. Parallel refresh POSTs carry the same refresh
// cookie and race the server-side rotation; the browser's single cookie jar
// then keeps whichever Set-Cookie lands last, sometimes a dead token, and the
// next refresh with it reads as token theft and revokes the whole session
// family (the "randomly logged out" bug). Runs against the built @hc/sdk
// dist, the exact client the app ships.

import { describe, it, expect } from "vitest";
import { HyCanvasClient } from "@hc/sdk";

function fakeBackend() {
  let refreshCalls = 0;
  let accessValid = false;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/refresh")) {
      refreshCalls += 1;
      // Hold the refresh in flight long enough for every racing caller to
      // observe it and (correctly) join instead of firing its own.
      await new Promise((r) => setTimeout(r, 20));
      accessValid = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (!accessValid) {
      return new Response(JSON.stringify({ title: "Unauthorized" }), { status: 401 });
    }
    return new Response(JSON.stringify({ id: "u1", email: "t@example.com" }), { status: 200 });
  };
  return { fetchImpl, refreshCalls: () => refreshCalls };
}

describe("SDK single-flight session refresh", () => {
  it("concurrent 401s share one refresh POST and both retries succeed", async () => {
    const be = fakeBackend();
    const oc = new HyCanvasClient({ baseUrl: "http://test/api", fetch: be.fetchImpl });
    const [a, b] = await Promise.all([
      oc.me() as Promise<{ id: string }>,
      oc.me() as Promise<{ id: string }>,
    ]);
    expect(a.id).toBe("u1");
    expect(b.id).toBe("u1");
    expect(be.refreshCalls()).toBe(1);
  });

  it("an explicit refresh() joins the in-flight automatic refresh", async () => {
    const be = fakeBackend();
    const oc = new HyCanvasClient({ baseUrl: "http://test/api", fetch: be.fetchImpl });
    const [user, r1, r2] = await Promise.all([
      oc.me() as Promise<{ id: string }>,
      oc.refresh(),
      oc.refresh(),
    ]);
    expect(user.id).toBe("u1");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(be.refreshCalls()).toBe(1);
  });

  it("a failed refresh surfaces the original 401 and refresh() reports ok:false", async () => {
    let refreshCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/v1/auth/refresh")) {
        refreshCalls += 1;
        return new Response(JSON.stringify({ title: "Unauthorized" }), { status: 401 });
      }
      return new Response(JSON.stringify({ title: "Unauthorized" }), { status: 401 });
    };
    const oc = new HyCanvasClient({ baseUrl: "http://test/api", fetch: fetchImpl });
    const [me, r] = await Promise.allSettled([oc.me(), oc.refresh()]);
    expect(me.status).toBe("rejected");
    // The dead-session path must NOT throw from refresh(): the auth store
    // treats it as "no session" and falls to anon without a second attempt.
    expect(r.status).toBe("fulfilled");
    if (r.status === "fulfilled") expect(r.value.ok).toBe(false);
    expect(refreshCalls).toBe(1);
  });
});
