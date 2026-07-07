// Shared state and API helpers for the first-run installation wizard. The
// wizard talks to the Go setup server's /api/setup surface (available only
// while the binary is unconfigured); answers accumulate in sessionStorage
// until the final install call.

const API_BASE = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8005/api";
const STORE_KEY = "hycanvas-setup";

export type SetupAnswers = {
  secret: string;
  appUrl: string;
  port: string;
  db: {
    mode: "fields" | "url";
    url: string;
    host: string;
    port: string;
    user: string;
    password: string;
    name: string;
    tested: boolean;
  };
  storage: {
    driver: "local" | "s3";
    localPath: string;
    s3: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKey: string;
      secretKey: string;
      forcePathStyle: boolean;
    };
    tested: boolean;
  };
  smtp: {
    enabled: boolean;
    host: string;
    port: string;
    username: string;
    password: string;
    from: string;
    fromName: string;
    tested: boolean;
  };
};

export function emptyAnswers(): SetupAnswers {
  return {
    secret: "",
    appUrl: "",
    port: "",
    db: { mode: "fields", url: "", host: "localhost", port: "5432", user: "", password: "", name: "hycanvas", tested: false },
    storage: {
      driver: "local",
      localPath: "",
      s3: { endpoint: "", region: "", bucket: "", accessKey: "", secretKey: "", forcePathStyle: true },
      tested: false,
    },
    smtp: { enabled: false, host: "", port: "587", username: "", password: "", from: "", fromName: "HyCanvas", tested: false },
  };
}

export function loadAnswers(): SetupAnswers {
  if (typeof window === "undefined") return emptyAnswers();
  try {
    const raw = window.sessionStorage.getItem(STORE_KEY);
    if (!raw) return emptyAnswers();
    return { ...emptyAnswers(), ...(JSON.parse(raw) as Partial<SetupAnswers>) };
  } catch {
    return emptyAnswers();
  }
}

export function saveAnswers(a: SetupAnswers) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(STORE_KEY, JSON.stringify(a));
}

export type SetupStatus = {
  state: string;
  phase: string;
  version: string;
  error?: string;
  defaults: { port: string; storagePath: string };
};

// setupStatus returns the setup server's state, or null when the server is
// already configured (the /api/setup surface is gone), so wizard pages can
// bounce visitors to the app.
export async function setupStatus(): Promise<SetupStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/setup/status`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as SetupStatus;
    return body.state === "setup" ? body : null;
  } catch {
    return null;
  }
}

// problemDetail extracts a human message from a problem+json error response.
async function problemDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: string; title?: string };
    return body.detail || body.title || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

// setupPost calls a mutating setup endpoint; resolves on success, throws an
// Error with a readable message otherwise.
export async function setupPost(path: string, body: unknown, secret: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/setup/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Setup-Secret": secret },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Couldn't reach the server. Is it still running?");
  }
  if (!res.ok) throw new Error(await problemDetail(res));
}

// verifySecret checks the wizard access secret; throws with the API's message
// (wrong secret, rate limited) on failure.
export async function verifySecret(secret: string): Promise<void> {
  await setupPost("verify", { secret }, secret);
}

// completePayload converts the collected answers into the backend's
// completeRequest shape.
export function completePayload(a: SetupAnswers) {
  return {
    appUrl: a.appUrl,
    port: a.port,
    db:
      a.db.mode === "url"
        ? { url: a.db.url }
        : { host: a.db.host, port: a.db.port, user: a.db.user, password: a.db.password, name: a.db.name },
    storage: {
      driver: a.storage.driver,
      localPath: a.storage.localPath,
      s3: a.storage.s3,
    },
    smtp: {
      enabled: a.smtp.enabled,
      host: a.smtp.host,
      port: a.smtp.port,
      username: a.smtp.username,
      password: a.smtp.password,
      from: a.smtp.from,
      fromName: a.smtp.fromName,
    },
  };
}

// healthOk polls the normal server's health endpoint after the handover.
export async function healthOk(): Promise<boolean> {
  try {
    const base = API_BASE.replace(/\/api$/, "");
    const res = await fetch(`${base}/healthz`, { cache: "no-store" });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}
