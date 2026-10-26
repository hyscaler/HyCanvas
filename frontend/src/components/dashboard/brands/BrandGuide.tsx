// Read-only brand guide (#53): a kit's logos on light and dark grounds with
// their sizing rules, its colors with HEX and RGB, its type pairing, its
// voice, and the controls that apply to designs, laid out as a
// page people can read or print. Renders a BrandDraft so the wizard's review
// step and a saved kit look the same.

import { useEffect } from "react";
import { contrastPairs, isHex, type BrandDraft } from "@/lib/brandDraft";
import { fonts } from "@/lib/fontProvider";
import { tr } from "@/lib/i18n";
import { logoSrc, roleLabel, type AssetUrls } from "./BrandForms";

function rgbOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** Black or white, whichever reads better on the swatch. */
function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 150 ? "#111111" : "#ffffff";
}

function GuideHeading({ children }: { children: string }) {
  return <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-neutral-400">{children}</h3>;
}

export function BrandGuide({ draft, urls }: { draft: BrandDraft; urls: AssetUrls }) {
  const heading = draft.headingFont.trim();
  const body = draft.bodyFont.trim();
  const accent = draft.accentFont.trim();
  useEffect(() => {
    for (const f of [heading, body, accent]) if (f) fonts.ensure(f);
  }, [heading, body, accent]);
  const colors = draft.colors.filter((c) => isHex(c.hex));
  const pairs = contrastPairs(colors);
  const v = draft.voice;
  const hasVoice = v.tone.length + v.doSay.length + v.dontSay.length > 0 || !!v.sampleCopy.trim();
  const c = draft.controls;
  const rules = [
    c.lockColors ? tr("brands.lock_colors") : "",
    c.lockFonts ? tr("brands.lock_fonts") : "",
    c.restrictTemplates ? tr("brands.restrict_templates") : "",
    c.lintPolicy === "warn" ? tr("brands.export_check_warn_rule") : c.lintPolicy === "block" ? tr("brands.export_check_block_rule") : "",
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-8" data-testid="brand-guide">
      <section>
        <GuideHeading>{tr("brands.logos")}</GuideHeading>
        {draft.logos.length === 0 ? (
          <p className="text-sm text-neutral-400">{tr("brands.no_logos_yet")}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {draft.logos.map((l) => {
              const src = logoSrc(l.assetId, urls);
              const dark = l.variants?.dark ? logoSrc(l.variants.dark, urls) : null;
              return (
                <figure key={l.id} className="overflow-hidden rounded-2xl border border-neutral-200">
                  <div className="grid grid-cols-2">
                    <div className="light flex h-36 items-center justify-center bg-white p-6">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {src && <img src={src} alt={l.label} className="h-full w-full object-contain" />}
                    </div>
                    <div className="flex h-36 items-center justify-center bg-neutral-900 p-6">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {dark ? <img src={dark} alt={`${l.label} ${tr("brands.on_dark")}`} className="h-full w-full object-contain" /> : <span className="text-xs text-neutral-500">{tr("brands.no_dark_version")}</span>}
                    </div>
                  </div>
                  <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t border-neutral-200 px-3 py-2 text-xs text-neutral-600">
                    <span>{l.label}</span>
                    {(l.clearSpaceRatio || l.minSizePx) && (
                      <span className="text-neutral-400">
                        {[
                          l.clearSpaceRatio ? tr("brands.clear_space_value", { n: String(Math.round(l.clearSpaceRatio * 100)) }) : "",
                          l.minSizePx ? tr("brands.min_width_value", { n: String(l.minSizePx) }) : "",
                        ].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <GuideHeading>{tr("brands.colors")}</GuideHeading>
        {colors.length === 0 ? (
          <p className="text-sm text-neutral-400">{tr("brands.no_colors_yet")}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {colors.map((c) => (
              <div key={c.id} className="overflow-hidden rounded-2xl border border-neutral-200">
                <div className="flex h-24 items-end p-3 text-xs font-semibold" style={{ background: c.hex, color: inkOn(c.hex) }}>
                  {roleLabel(c.role)}
                </div>
                <div className="px-3 py-2 font-mono text-[11px] text-neutral-600">
                  <div className="uppercase">{c.hex}</div>
                  <div>{tr("brands.rgb_value", { rgb: rgbOf(c.hex) })}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        {colors.length > 1 && (
          <div className="mt-5">
            <div className="mb-2 text-xs font-semibold text-neutral-700">{tr("brands.text_pairs")}</div>
            {pairs.length === 0 ? (
              <p className="text-sm text-neutral-400">{tr("brands.no_text_pairs")}</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="brand-contrast-pairs">
                {pairs.map((p) => (
                  <div key={`${p.fg.id}-${p.bg.id}`} className="overflow-hidden rounded-2xl border border-neutral-200">
                    <div className="flex h-16 items-center gap-2 px-3" style={{ background: p.bg.hex, color: p.fg.hex }}>
                      <span className="text-2xl font-bold" style={heading ? { fontFamily: `'${heading}', sans-serif` } : undefined}>{tr("brands.type_sample")}</span>
                      <span className="text-xs" style={body ? { fontFamily: `'${body}', sans-serif` } : undefined}>{roleLabel(p.fg.role)} / {roleLabel(p.bg.role)}</span>
                    </div>
                    <div className="flex items-center justify-between px-3 py-1.5 font-mono text-[11px] text-neutral-600">
                      <span>{tr("brands.contrast_value", { ratio: p.ratio.toFixed(1) })}</span>
                      <span className="rounded bg-neutral-100 px-1.5 font-sans font-semibold text-neutral-700">{p.ratio >= 7 ? "AAA" : "AA"}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <section>
        <GuideHeading>{tr("brands.fonts")}</GuideHeading>
        {!heading && !body && !accent ? (
          <p className="text-sm text-neutral-400">{tr("brands.no_fonts_yet")}</p>
        ) : (
          <div className="flex flex-col gap-4 rounded-2xl border border-neutral-200 p-5">
            {heading && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-neutral-400">{tr("brands.heading_font")} · {heading}</div>
                <div className="mt-1 text-3xl font-bold text-neutral-900" style={{ fontFamily: `'${heading}', sans-serif` }}>{tr("brands.font_sample")}</div>
              </div>
            )}
            {body && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-neutral-400">{tr("brands.body_font")} · {body}</div>
                <p className="mt-1 text-sm leading-relaxed text-neutral-700" style={{ fontFamily: `'${body}', sans-serif` }}>{tr("brands.body_sample")}</p>
              </div>
            )}
            {accent && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-neutral-400">{tr("brands.accent_font")} · {accent}</div>
                <div className="mt-1 text-xl text-neutral-800" style={{ fontFamily: `'${accent}', sans-serif` }}>{tr("brands.font_sample")}</div>
              </div>
            )}
          </div>
        )}
      </section>

      <section>
        <GuideHeading>{tr("brands.voice")}</GuideHeading>
        {!hasVoice ? (
          <p className="text-sm text-neutral-400">{tr("brands.no_voice_yet")}</p>
        ) : (
          <div className="flex flex-col gap-4 rounded-2xl border border-neutral-200 p-5">
            {v.tone.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {v.tone.map((t) => <span key={t} className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-ink">{t}</span>)}
              </div>
            )}
            {(v.doSay.length > 0 || v.dontSay.length > 0) && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs font-semibold text-green-700">{tr("brands.we_say")}</div>
                  <ul className="list-disc ps-5 text-sm text-neutral-700">{v.doSay.map((s) => <li key={s}>{s}</li>)}</ul>
                </div>
                <div>
                  <div className="mb-1 text-xs font-semibold text-red-700">{tr("brands.we_avoid")}</div>
                  <ul className="list-disc ps-5 text-sm text-neutral-700">{v.dontSay.map((s) => <li key={s}>{s}</li>)}</ul>
                </div>
              </div>
            )}
            {v.sampleCopy.trim() && (
              <blockquote className="border-s-4 border-brand-300 ps-3 text-sm italic text-neutral-700" style={body ? { fontFamily: `'${body}', sans-serif` } : undefined}>
                {v.sampleCopy}
              </blockquote>
            )}
          </div>
        )}
      </section>

      <section>
        <GuideHeading>{tr("brands.controls")}</GuideHeading>
        <ul className="flex flex-col gap-1.5 rounded-2xl border border-neutral-200 p-5 text-sm text-neutral-700">
          {rules.length === 0 ? <li className="text-neutral-400">{tr("brands.no_controls_on")}</li> : rules.map((r) => <li key={r}>{r}</li>)}
        </ul>
      </section>
    </div>
  );
}
