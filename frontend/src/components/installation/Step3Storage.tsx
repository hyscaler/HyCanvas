// Step 3: where uploaded assets and exports live. Local disk works out of
// the box; S3-compatible storage (AWS, MinIO, R2) must pass a connectivity
// test before continuing.

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import { HardDrive, Cloud } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { WizardShell, ErrorBanner, SuccessBanner } from "./WizardShell";
import { loadAnswers, saveAnswers, setupPost, setupStatus, type SetupAnswers } from "./wizard";

export function Step3Storage() {
  const router = useRouter();
  // Lazy init: sessionStorage exists client-side only; the static prerender
  // falls back to empty answers inside loadAnswers.
  const [answers, setAnswers] = useState(loadAnswers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void setupStatus().then((st) => {
      if (st) {
        setAnswers((prev) =>
          prev.storage.localPath
            ? prev
            : { ...prev, storage: { ...prev.storage, localPath: st.defaults.storagePath } },
        );
      }
    });
  }, []);

  const storage = answers.storage;

  function setStorage(patch: Partial<SetupAnswers["storage"]>) {
    setAnswers((prev) => ({ ...prev, storage: { ...prev.storage, ...patch, tested: false } }));
    setError(null);
  }
  function setS3(patch: Partial<SetupAnswers["storage"]["s3"]>) {
    setStorage({ s3: { ...storage.s3, ...patch } });
  }

  async function test() {
    setBusy(true);
    setError(null);
    try {
      await setupPost("s3/test", storage.s3, answers.secret);
      setAnswers((prev) => ({ ...prev, storage: { ...prev.storage, tested: true } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "S3 check failed.");
    } finally {
      setBusy(false);
    }
  }

  const canContinue = storage.driver === "local" || storage.tested;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    saveAnswers(answers);
    await router.push("/installation/step-4");
  }

  return (
    <WizardShell
      step={3}
      title="Asset storage"
      subtitle="Uploads, stock caches, and exports are stored here."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Storage driver">
          {(
            [
              { id: "local", label: "Local disk", desc: "Simplest; a folder next to the server", icon: HardDrive },
              { id: "s3", label: "S3-compatible", desc: "AWS S3, MinIO, R2, …", icon: Cloud },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={storage.driver === opt.id}
              onClick={() => setStorage({ driver: opt.id })}
              className={cn(
                "flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition",
                storage.driver === opt.id
                  ? "border-brand-400 bg-brand-50/60 ring-2 ring-brand-100"
                  : "border-neutral-200 bg-white hover:border-neutral-300",
              )}
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
                <opt.icon size={15} className="text-brand-600" /> {opt.label}
              </span>
              <span className="text-xs text-neutral-500">{opt.desc}</span>
            </button>
          ))}
        </div>

        {storage.driver === "local" ? (
          <Input
            label="Storage directory"
            required
            placeholder="/srv/hycanvas/storage"
            value={storage.localPath}
            onChange={(e) => setStorage({ localPath: e.target.value })}
          />
        ) : (
          <>
            <Input label="Endpoint" required placeholder="https://s3.amazonaws.com or minio:9000" value={storage.s3.endpoint} onChange={(e) => setS3({ endpoint: e.target.value })} />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Region" placeholder="us-east-1" value={storage.s3.region} onChange={(e) => setS3({ region: e.target.value })} />
              <Input label="Bucket" required placeholder="hycanvas" value={storage.s3.bucket} onChange={(e) => setS3({ bucket: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Access key ID" required value={storage.s3.accessKey} onChange={(e) => setS3({ accessKey: e.target.value })} autoComplete="off" />
              <Input label="Secret access key" required type="password" value={storage.s3.secretKey} onChange={(e) => setS3({ secretKey: e.target.value })} autoComplete="off" />
            </div>
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={storage.s3.forcePathStyle}
                onChange={(e) => setS3({ forcePathStyle: e.target.checked })}
                className="h-4 w-4 rounded border-neutral-300 accent-[var(--color-brand-600)]"
              />
              Path-style addressing (required by most MinIO setups)
            </label>
          </>
        )}

        {error && <ErrorBanner>{error}</ErrorBanner>}
        {storage.driver === "s3" && storage.tested && <SuccessBanner>Bucket reachable.</SuccessBanner>}

        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={() => void router.push("/installation/step-2")}>
            Back
          </Button>
          <div className="flex gap-2">
            {storage.driver === "s3" && (
              <Button type="button" variant="secondary" onClick={() => void test()} disabled={busy}>
                {busy ? "Testing…" : "Test bucket"}
              </Button>
            )}
            <Button type="submit" disabled={!canContinue}>
              Continue
            </Button>
          </div>
        </div>
      </form>
    </WizardShell>
  );
}
