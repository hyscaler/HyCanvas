// API helpers for the first-run installation wizard. All wizard state lives
// on the setup server (/api/setup/answers), never in browser storage; the
// only client-held state is the verified access secret below, kept in module
// memory so a refresh or direct deep-link always restarts at step 1.

const API_BASE = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8005/api";

// The verified wizard access secret. Module memory survives client-side
// navigation between steps but not a page load, by design.
let wizardSecret: string | null = null;

export function getSecret(): string | null {
  return wizardSecret;
}

export type DBAnswers = {
  url: string;
  host: string;
  port: string;
  user: string;
  password: string;
  name: string;
};

export type StorageAnswers = {
  driver: "local" | "s3" | "";
  localPath: string;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    forcePathStyle: boolean;
  };
};

export type SMTPAnswers = {
  enabled: boolean;
  host: string;
  port: string;
  username: string;
  password: string;
  from: string;
  fromName: string;
};

// SetupAnswers mirrors the server's completeRequest shape.
export type SetupAnswers = {
  appUrl: string;
  port: string;
  db: DBAnswers;
  storage: StorageAnswers;
  smtp: SMTPAnswers;
};

export type SetupStatus = {
  state: string;
  phase: string;
  version: string;
  error?: string;
  defaults: { port: string; storagePath: string };
};

// setupStatus returns the setup server's state, or null when the server is
// already configured (the /api/setup surface is gone), so wizard pages can
// bounce visitors appropriately.
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

async function setupFetch(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/setup/${path}`, init);
  } catch {
    throw new Error("Couldn't reach the server. Is it still running?");
  }
  if (!res.ok) throw new Error(await problemDetail(res));
  return res;
}

// setupPost calls a mutating setup endpoint with the held secret; resolves on
// success, throws an Error with a readable message otherwise.
export async function setupPost(path: string, body: unknown): Promise<void> {
  await setupFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Setup-Secret": wizardSecret ?? "" },
    body: JSON.stringify(body),
  });
}

// verifySecret checks the wizard access secret and holds it for this SPA
// session on success; throws with the API's message (wrong secret, rate
// limited) on failure.
export async function verifySecret(secret: string): Promise<void> {
  await setupFetch("verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  wizardSecret = secret;
}

// getAnswers reads the server-held working answers for prefilling a step.
export async function getAnswers(): Promise<SetupAnswers> {
  const res = await setupFetch("answers", {
    headers: { "X-Setup-Secret": wizardSecret ?? "" },
    cache: "no-store",
  });
  return (await res.json()) as SetupAnswers;
}

// updateAnswers submits one step's section to the server-held answers.
export async function updateAnswers(partial: {
  appUrl?: string;
  port?: string;
  db?: DBAnswers;
  storage?: StorageAnswers;
  smtp?: SMTPAnswers;
}): Promise<void> {
  await setupPost("answers", partial);
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
