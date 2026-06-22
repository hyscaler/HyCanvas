// End-to-end smoke test against a LIVE backend + Postgres. Exercises the real
// integrated flow the web app uses: cookie auth, designs CRUD + snapshots,
// home/search, templates apply, stock, uploads + content delivery, workspace
// isolation, and refresh. Exits non-zero on any failure.
//
// Usage: node scripts/smoke-e2e.mjs   (expects the API at $SMOKE_BASE or :8005)

const BASE = process.env.SMOKE_BASE || "http://localhost:8005/api";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function newJar() {
  return {};
}
function absorb(jar, res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const pair = c.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}
async function req(method, path, { jar, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (jar && Object.keys(jar).length) headers["cookie"] = cookieHeader(jar);
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (jar) absorb(jar, res);
  return res;
}
async function json(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");

async function main() {
  console.log(`\nHyCanvas e2e smoke → ${BASE}\n`);

  // 1. health
  const health = await req("GET", "/healthz");
  check("GET /healthz is 200", health.status === 200, `status ${health.status}`);

  // 2. signup (unique email) -> sets cookies
  const email = `smoke+${Date.now()}@example.com`;
  const jar = newJar();
  const signupRes = await req("POST", "/v1/auth/signup", { jar, body: { email, password: "password123", name: "Smoke" } });
  const signup = await json(signupRes);
  check("signup is 201", signupRes.status === 201, `status ${signupRes.status}`);
  check("signup returns user + personal workspace", !!signup?.user?.id && signup?.workspace?.kind === "personal");
  check("signup set auth cookies", !!jar.oc_access && !!jar.oc_refresh);
  const userId = signup?.user?.id;
  const wsId = signup?.workspace?.id;

  // 3. /me with cookie
  const meRes = await req("GET", "/v1/me", { jar });
  const me = await json(meRes);
  check("GET /me returns the signed-in user", meRes.status === 200 && me?.id === userId);

  // 4. /me without cookie -> 401
  const meAnon = await req("GET", "/v1/me");
  check("GET /me without cookie is 401", meAnon.status === 401, `status ${meAnon.status}`);

  // 5. workspaces
  const wsRes = await req("GET", "/v1/workspaces", { jar });
  const wss = await json(wsRes);
  check("GET /workspaces includes the personal workspace", Array.isArray(wss) && wss.some((w) => w.id === wsId));

  // 6. create design
  const createRes = await req("POST", "/v1/designs", { jar, body: { workspaceId: wsId, title: "Smoke Design" } });
  const design = await json(createRes);
  check("create design is 201", createRes.status === 201, `status ${createRes.status}`);
  check("create design returns an id", !!design?.id);
  const designId = design?.id;

  // 7. load file (validates + migrates the stored snapshot)
  const fileRes = await req("GET", `/v1/designs/${designId}/file`, { jar });
  const file = await json(fileRes);
  check("GET design file returns a DesignFile", fileRes.status === 200 && file?.format === "hycanvas.design");

  // 8. save a snapshot (mutate the title in the file)
  const snapRes = await req("POST", `/v1/designs/${designId}/snapshots`, { jar, body: { file: { ...file, title: "Smoke v2" }, kind: "checkpoint" } });
  check("save snapshot is 201", snapRes.status === 201, `status ${snapRes.status}`);

  // 9. home shows the design
  const homeRes = await req("GET", `/v1/workspaces/${wsId}/home?section=recent`, { jar });
  const home = await json(homeRes);
  check("home recent includes the new design", Array.isArray(home) && home.some((h) => h.id === designId));

  // 10. search finds it
  const searchRes = await req("GET", `/v1/search?workspaceId=${wsId}&q=smoke`, { jar });
  const results = await json(searchRes);
  check("search finds the design", Array.isArray(results) && results.some((h) => h.id === designId));

  // 11. templates: list + apply -> new design
  const tplRes = await req("GET", "/v1/templates", { jar });
  const tpls = await json(tplRes);
  check("templates list is non-empty", Array.isArray(tpls) && tpls.length > 0);
  if (tpls?.[0]) {
    const applyRes = await req("POST", `/v1/templates/${tpls[0].id}/apply`, { jar, body: { workspaceId: wsId } });
    const applied = await json(applyRes);
    check("apply template creates a design", applyRes.status === 201 && !!applied?.designId);
  }

  // 12. stock search
  const stockRes = await req("GET", "/v1/stock/search?q=mountain", { jar });
  const stock = await json(stockRes);
  check("stock search returns results", Array.isArray(stock) && stock.length > 0);

  // 13. uploads: upload PNG -> asset, then fetch content (public)
  const upRes = await req("POST", `/v1/workspaces/${wsId}/assets`, { jar, body: { filename: "smoke.png", dataBase64: PNG_B64 } });
  const asset = await json(upRes);
  check("upload returns an image asset", upRes.status === 201 && asset?.kind === "image" && !!asset?.id);
  if (asset?.id) {
    const contentRes = await fetch(`${BASE}/v1/assets/${asset.id}/content`);
    const ct = contentRes.headers.get("content-type") || "";
    const bytes = await contentRes.arrayBuffer();
    check("asset content is served (image bytes)", contentRes.status === 200 && ct.includes("image/png") && bytes.byteLength > 0);
  }
  const listRes = await req("GET", `/v1/workspaces/${wsId}/assets`, { jar });
  const assets = await json(listRes);
  check("asset appears in the workspace list", Array.isArray(assets) && assets.some((a) => a.id === asset?.id));

  // 14. workspace isolation: a second user cannot read the first user's design
  const jar2 = newJar();
  await req("POST", "/v1/auth/signup", { jar: jar2, body: { email: `smoke2+${Date.now()}@example.com`, password: "password123" } });
  const crossRes = await req("GET", `/v1/designs/${designId}/file`, { jar: jar2 });
  check("cross-workspace read is denied (403/404)", crossRes.status === 403 || crossRes.status === 404, `status ${crossRes.status}`);
  const crossHome = await req("GET", `/v1/workspaces/${wsId}/home`, { jar: jar2 });
  check("cross-workspace home is denied (403)", crossHome.status === 403, `status ${crossHome.status}`);

  // 15. refresh rotates and keeps the session valid
  const refreshRes = await req("POST", "/v1/auth/refresh", { jar });
  check("refresh is 200 and re-sets cookies", refreshRes.status === 200 && !!jar.oc_access);
  const meAfter = await req("GET", "/v1/me", { jar });
  check("session still valid after refresh", meAfter.status === 200);

  // 16. logout clears the session
  const logoutRes = await req("POST", "/v1/auth/logout", { jar });
  check("logout is 204", logoutRes.status === 204, `status ${logoutRes.status}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke run crashed:", e);
  process.exit(1);
});
