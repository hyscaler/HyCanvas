import { describe, it, expect } from "vitest";
import {
  canEdit,
  canCancel,
  nextTransition,
  dueAt,
  isDue,
  backoffDelayMs,
  groupByDay,
  filterPosts,
  calendarMatrix,
  weekDays,
  extractHashtags,
  normalizeHashtags,
  composeCaption,
  validateCaption,
  platformLimits,
  variantKey,
  planVariants,
  proposeResizes,
  platformFormats,
  encodeQr,
  qrToSvg,
  aggregateInsights,
  engagementRate,
  signPayload,
  verifySignature,
  webhookEvents,
  type PostStatus,
  type PostInsights,
} from "../index";

describe("schedule: state machine", () => {
  it("allows the canonical happy path", () => {
    expect(nextTransition("draft", "schedule")).toBe("scheduled");
    expect(nextTransition("scheduled", "publishStart")).toBe("publishing");
    expect(nextTransition("publishing", "publishOk")).toBe("published");
  });

  it("handles failure and requeue", () => {
    expect(nextTransition("publishing", "publishFail")).toBe("failed");
    expect(nextTransition("failed", "requeue")).toBe("scheduled");
  });

  it("allows cancel from draft and scheduled", () => {
    expect(nextTransition("draft", "cancel")).toBe("canceled");
    expect(nextTransition("scheduled", "cancel")).toBe("canceled");
  });

  it("throws on illegal transitions", () => {
    expect(() => nextTransition("published", "schedule")).toThrow(/illegal/);
    expect(() => nextTransition("publishing", "cancel")).toThrow(/illegal/);
    expect(() => nextTransition("canceled", "requeue")).toThrow(/illegal/);
    expect(() => nextTransition("draft", "publishOk")).toThrow(/illegal/);
  });
});

describe("schedule: canEdit / canCancel", () => {
  const statuses: PostStatus[] = [
    "draft",
    "scheduled",
    "publishing",
    "published",
    "failed",
    "canceled",
  ];
  it("permits edit/cancel only before publishing starts", () => {
    for (const s of statuses) {
      const editable = s === "draft" || s === "scheduled";
      expect(canEdit(s)).toBe(editable);
      expect(canCancel(s)).toBe(editable);
    }
  });
});

describe("schedule: dueAt", () => {
  it("treats the ISO time as wall-clock at UTC offset 0", () => {
    const ms = dueAt("2026-06-05T09:00:00", 0);
    expect(ms).toBe(Date.UTC(2026, 5, 5, 9, 0, 0));
  });

  it("subtracts a positive offset (ahead of UTC)", () => {
    // 09:00 at UTC+5:30 is 03:30 UTC.
    const ms = dueAt("2026-06-05T09:00:00", 330);
    expect(ms).toBe(Date.UTC(2026, 5, 5, 3, 30, 0));
  });

  it("handles a negative offset (behind UTC)", () => {
    // 09:00 at UTC-8:00 is 17:00 UTC.
    const ms = dueAt("2026-06-05T09:00:00", -480);
    expect(ms).toBe(Date.UTC(2026, 5, 5, 17, 0, 0));
  });

  it("ignores a trailing Z in favor of the supplied offset", () => {
    const a = dueAt("2026-06-05T09:00:00Z", 60);
    const b = dueAt("2026-06-05T09:00:00", 60);
    expect(a).toBe(b);
  });

  it("throws on unparseable input", () => {
    expect(() => dueAt("not-a-date", 0)).toThrow();
  });
});

describe("schedule: isDue", () => {
  it("is due only for scheduled posts at/after their due time", () => {
    expect(isDue({ status: "scheduled", dueMs: 1000 }, 1000)).toBe(true);
    expect(isDue({ status: "scheduled", dueMs: 1000 }, 999)).toBe(false);
    expect(isDue({ status: "draft", dueMs: 1000 }, 5000)).toBe(false);
    expect(isDue({ status: "scheduled" }, 5000)).toBe(false);
  });
});

describe("schedule: backoffDelayMs", () => {
  it("grows exponentially", () => {
    expect(backoffDelayMs(0, { baseMs: 1000, factor: 2 })).toBe(1000);
    expect(backoffDelayMs(1, { baseMs: 1000, factor: 2 })).toBe(2000);
    expect(backoffDelayMs(2, { baseMs: 1000, factor: 2 })).toBe(4000);
    expect(backoffDelayMs(3, { baseMs: 1000, factor: 2 })).toBe(8000);
  });

  it("caps at maxMs", () => {
    expect(backoffDelayMs(20, { baseMs: 1000, factor: 2, maxMs: 5000 })).toBe(5000);
  });

  it("applies deterministic jitter as a downward fraction within the cap", () => {
    const full = backoffDelayMs(3, { baseMs: 1000, factor: 2 });
    expect(backoffDelayMs(3, { baseMs: 1000, factor: 2, jitter: 0 })).toBe(full);
    expect(backoffDelayMs(3, { baseMs: 1000, factor: 2, jitter: 1 })).toBe(0);
    const half = backoffDelayMs(3, { baseMs: 1000, factor: 2, jitter: 0.5 });
    expect(half).toBe(Math.round(full * 0.5));
    expect(half).toBeLessThanOrEqual(full);
  });

  it("uses sane defaults", () => {
    expect(backoffDelayMs(0)).toBe(1000);
    expect(backoffDelayMs(100)).toBe(5 * 60_000);
  });
});

describe("planner: groupByDay", () => {
  it("buckets posts into yyyy-mm-dd keys", () => {
    const posts = [
      { id: "a", due: Date.UTC(2026, 5, 5, 9, 0) },
      { id: "b", due: Date.UTC(2026, 5, 5, 23, 0) },
      { id: "c", due: Date.UTC(2026, 5, 6, 1, 0) },
    ];
    const grouped = groupByDay(posts, (p) => p.due);
    expect(Object.keys(grouped).sort()).toEqual(["2026-06-05", "2026-06-06"]);
    expect(grouped["2026-06-05"].map((p) => p.id)).toEqual(["a", "b"]);
    expect(grouped["2026-06-06"].map((p) => p.id)).toEqual(["c"]);
  });
});

describe("planner: filterPosts", () => {
  const posts = [
    { id: "1", platform: "x" as const, accountId: "acc1", status: "scheduled" as const },
    { id: "2", platform: "instagram" as const, accountId: "acc2", status: "draft" as const },
    { id: "3", platform: "x" as const, accountId: "acc1", status: "published" as const },
  ];
  it("filters by platform", () => {
    expect(filterPosts(posts, { platform: "x" }).map((p) => p.id)).toEqual(["1", "3"]);
  });
  it("filters by accountId and status combined", () => {
    expect(
      filterPosts(posts, { accountId: "acc1", status: "scheduled" }).map((p) => p.id),
    ).toEqual(["1"]);
  });
  it("returns all with no filter", () => {
    expect(filterPosts(posts, {})).toHaveLength(3);
  });
});

describe("planner: calendarMatrix", () => {
  it("returns a 6x7 grid", () => {
    const m = calendarMatrix(2026, 6);
    expect(m).toHaveLength(6);
    for (const week of m) expect(week).toHaveLength(7);
  });

  it("starts on the Monday on/before the first of the month", () => {
    // June 2026: June 1 is a Monday, so the first cell is exactly 2026-06-01.
    const m = calendarMatrix(2026, 6);
    expect(m[0][0].dateIso).toBe("2026-06-01");
    expect(m[0][0].inMonth).toBe(true);
  });

  it("marks leading days from the previous month as not inMonth", () => {
    // July 2026: July 1 is a Wednesday; Monday-start means the grid begins
    // on June 29 (Mon) with two leading out-of-month days.
    const m = calendarMatrix(2026, 7);
    expect(m[0][0].dateIso).toBe("2026-06-29");
    expect(m[0][0].inMonth).toBe(false);
    expect(m[0][1].dateIso).toBe("2026-06-30");
    expect(m[0][1].inMonth).toBe(false);
    expect(m[0][2].dateIso).toBe("2026-07-01");
    expect(m[0][2].inMonth).toBe(true);
  });

  it("covers 42 consecutive days with trailing out-of-month cells", () => {
    const m = calendarMatrix(2026, 7);
    const flat = m.flat();
    expect(flat).toHaveLength(42);
    expect(flat[41].inMonth).toBe(false); // trailing days belong to August
    // Days are consecutive.
    for (let i = 1; i < flat.length; i++) {
      const prev = Date.parse(flat[i - 1].dateIso + "T00:00:00Z");
      const cur = Date.parse(flat[i].dateIso + "T00:00:00Z");
      expect(cur - prev).toBe(86_400_000);
    }
  });
});

describe("planner: weekDays", () => {
  it("returns Monday-started 7 days containing the date", () => {
    // 2026-06-05 is a Friday; its Monday is 2026-06-01.
    expect(weekDays("2026-06-05")).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
      "2026-06-06",
      "2026-06-07",
    ]);
  });
});

describe("caption: hashtags", () => {
  it("extracts hashtags in order, without #", () => {
    expect(extractHashtags("hello #World and #design #World")).toEqual([
      "World",
      "design",
      "World",
    ]);
  });

  it("normalizes: strips #, dedupes case-insensitively, preserves first casing", () => {
    expect(normalizeHashtags(["#Design", "design", "#WORLD", "#world", " "])).toEqual([
      "Design",
      "WORLD",
    ]);
  });

  it("composes a caption with body and hashtags", () => {
    const c = composeCaption("Check this out", ["#Fun", "fun", "art"]);
    expect(c).toBe("Check this out\n\n#Fun #art");
  });

  it("composes with a first comment appended", () => {
    const c = composeCaption("Body", ["tag"], "First comment");
    expect(c).toContain("Body");
    expect(c).toContain("#tag");
    expect(c).toContain("First comment");
  });
});

describe("caption: validateCaption", () => {
  it("passes within limit", () => {
    const r = validateCaption("x", "short tweet");
    expect(r.ok).toBe(true);
    expect(r.limit).toBe(platformLimits.x);
    expect(r.errors).toHaveLength(0);
  });

  it("fails when over the character limit", () => {
    const r = validateCaption("x", "a".repeat(281));
    expect(r.ok).toBe(false);
    expect(r.length).toBe(281);
    expect(r.errors[0]).toMatch(/limit is 280/);
  });

  it("fails when over the hashtag cap (instagram 30)", () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
    const r = validateCaption("instagram", `caption ${tags}`);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /at most 30/.test(e))).toBe(true);
  });

  it("does not enforce a hashtag cap where none is defined (x)", () => {
    const tags = Array.from({ length: 50 }, (_, i) => `#t${i}`).join(" ");
    // keep under x char limit
    const r = validateCaption("x", tags.slice(0, 200));
    expect(r.errors.some((e) => /hashtags/.test(e))).toBe(false);
  });

  it("counts unicode code points, not UTF-16 units", () => {
    const r = validateCaption("x", "😀".repeat(280));
    expect(r.length).toBe(280);
    expect(r.ok).toBe(true);
  });
});

describe("variants: dedup and keys", () => {
  it("variantKey is stable and dimension-sensitive", () => {
    const k1 = variantKey("d1", "p1", 1080, 1080, "png");
    const k2 = variantKey("d1", "p1", 1080, 1080, "png");
    const k3 = variantKey("d1", "p1", 1080, 1920, "png");
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it("collapses same-size targets to one variant", () => {
    const planned = planVariants("d1", "p1", [
      { targetId: "ig", width: 1080, height: 1080, format: "png" },
      { targetId: "fb", width: 1080, height: 1080, format: "png" }, // same size
      { targetId: "story", width: 1080, height: 1920, format: "png" },
    ]);
    expect(planned).toHaveLength(2);
    const square = planned.find((p) => p.height === 1080)!;
    expect(square.targetIds.sort()).toEqual(["fb", "ig"]);
    const story = planned.find((p) => p.height === 1920)!;
    expect(story.targetIds).toEqual(["story"]);
  });

  it("preserves first-seen spec order", () => {
    const planned = planVariants("d", "p", [
      { targetId: "a", width: 100, height: 200, format: "png" },
      { targetId: "b", width: 300, height: 400, format: "png" },
      { targetId: "c", width: 100, height: 200, format: "png" },
    ]);
    expect(planned.map((p) => p.width)).toEqual([100, 300]);
  });
});

describe("variants: proposeResizes", () => {
  it("proposes a sized variant per platform from primary formats", () => {
    const out = proposeResizes(1080, 1080, ["instagram", "x", "pinterest"]);
    expect(out).toHaveLength(3);
    const ig = out.find((r) => r.platform === "instagram")!;
    expect(ig.width).toBe(platformFormats.instagram[0].width);
    expect(ig.height).toBe(platformFormats.instagram[0].height);
    // square source into a square IG primary => close aspect => fill.
    expect(ig.mode).toBe("fill");
  });

  it("chooses fit when aspect ratios diverge significantly", () => {
    // wide source into a tall pinterest pin (1000x1500) => big divergence => fit.
    const out = proposeResizes(1920, 1080, ["pinterest"]);
    expect(out[0].mode).toBe("fit");
  });
});

describe("qr: encode + svg", () => {
  it("encodes a known string to a deterministic, valid matrix size", () => {
    const m1 = encodeQr("https://hycanvas.example/p/abc123", "M");
    const m2 = encodeQr("https://hycanvas.example/p/abc123", "M");
    // Deterministic.
    expect(m1.size).toBe(m2.size);
    expect(m1.modules).toEqual(m2.modules);
    // Valid QR size: 4*version+17.
    expect((m1.size - 17) % 4).toBe(0);
    expect(m1.modules).toHaveLength(m1.size);
    expect(m1.modules[0]).toHaveLength(m1.size);
  });

  it("places the three finder patterns (dark corners)", () => {
    const m = encodeQr("HELLO", "M");
    // Top-left finder center module is dark.
    expect(m.modules[3][3]).toBe(true);
    // Finder rings: corner module dark.
    expect(m.modules[0][0]).toBe(true);
    expect(m.modules[0][m.size - 1]).toBe(true);
    expect(m.modules[m.size - 1][0]).toBe(true);
  });

  it("grows version with payload size", () => {
    const small = encodeQr("hi", "M");
    const big = encodeQr("x".repeat(300), "M");
    expect(big.version).toBeGreaterThan(small.version);
  });

  it("supports all EC levels", () => {
    for (const ec of ["L", "M", "Q", "H"] as const) {
      const m = encodeQr("test", ec);
      expect(m.ecLevel).toBe(ec);
      expect(m.size).toBeGreaterThan(0);
    }
  });

  it("renders SVG with rects and honors colors", () => {
    const m = encodeQr("SVG-TEST", "M");
    const svg = qrToSvg(m, { fg: "#112233", bg: "#ffeedd", moduleSize: 5, quietZone: 2 });
    expect(svg).toContain("<svg");
    expect(svg).toContain("<rect");
    expect(svg).toContain('fill="#112233"'); // module color
    expect(svg).toContain('fill="#ffeedd"'); // background color
    const expectedDim = (m.size + 2 * 2) * 5;
    expect(svg).toContain(`width="${expectedDim}"`);
  });

  it("embeds a center logo image when provided", () => {
    const m = encodeQr("LOGO", "H");
    const svg = qrToSvg(m, { logo: { href: "https://x/logo.png", sizeRatio: 0.2 } });
    expect(svg).toContain("<image");
    expect(svg).toContain("logo.png");
  });
});

describe("insights: aggregation", () => {
  const rows: (PostInsights & { designId?: string })[] = [
    {
      postId: "p1",
      targetId: "t1",
      platform: "instagram",
      designId: "dA",
      impressions: 100,
      reach: 80,
      likes: 10,
      comments: 2,
      shares: 1,
      saves: 3,
      clicks: 5,
      fetchedAt: "2026-06-05T00:00:00Z",
    },
    {
      postId: "p2",
      targetId: "t2",
      platform: "instagram",
      designId: "dA",
      impressions: 50,
      likes: 4,
      fetchedAt: "2026-06-05T00:00:00Z",
    },
    {
      postId: "p3",
      targetId: "t3",
      platform: "x",
      designId: "dB",
      impressions: 200,
      reach: 150,
      likes: 20,
      fetchedAt: "2026-06-05T00:00:00Z",
    },
  ];

  it("sums totals across all rows treating missing metrics as zero", () => {
    const agg = aggregateInsights(rows);
    expect(agg.totals.impressions).toBe(350);
    expect(agg.totals.likes).toBe(34);
    expect(agg.totals.comments).toBe(2);
    expect(agg.totals.clicks).toBe(5);
  });

  it("rolls up per platform", () => {
    const agg = aggregateInsights(rows);
    expect(agg.perPlatform.instagram.impressions).toBe(150);
    expect(agg.perPlatform.x.impressions).toBe(200);
  });

  it("rolls up per design", () => {
    const agg = aggregateInsights(rows);
    expect(agg.perDesign.dA.likes).toBe(14);
    expect(agg.perDesign.dB.likes).toBe(20);
  });

  it("computes engagement rate over reach (fallback impressions)", () => {
    expect(engagementRate(rows[0])).toBeCloseTo((10 + 2 + 1 + 3) / 80);
    // row p2 has no reach; falls back to impressions=50.
    expect(engagementRate(rows[1])).toBeCloseTo(4 / 50);
    // zero denominator => 0
    expect(engagementRate({ postId: "z", targetId: "z", platform: "x", fetchedAt: "" })).toBe(0);
  });
});

describe("webhook: sign/verify", () => {
  it("round-trips a signature", () => {
    const body = JSON.stringify({ postId: "p1", event: webhookEvents.postPublished });
    const sig = signPayload("s3cr3t", body, 1700000000);
    expect(verifySignature("s3cr3t", body, 1700000000, sig)).toBe(true);
  });

  it("detects a tampered body", () => {
    const sig = signPayload("s3cr3t", "{\"a\":1}", 1700000000);
    expect(verifySignature("s3cr3t", "{\"a\":2}", 1700000000, sig)).toBe(false);
  });

  it("detects a tampered timestamp", () => {
    const sig = signPayload("s3cr3t", "body", 1700000000);
    expect(verifySignature("s3cr3t", "body", 1700000001, sig)).toBe(false);
  });

  it("detects a wrong secret", () => {
    const sig = signPayload("s3cr3t", "body", 1);
    expect(verifySignature("other", "body", 1, sig)).toBe(false);
  });

  it("rejects malformed/length-mismatched signatures without throwing", () => {
    expect(verifySignature("s", "body", 1, "deadbeef")).toBe(false);
  });

  it("exposes the four lifecycle event names", () => {
    expect(webhookEvents.postPublished).toBe("post.published");
    expect(webhookEvents.postFailed).toBe("post.failed");
    expect(webhookEvents.postScheduled).toBe("post.scheduled");
    expect(webhookEvents.insightsUpdated).toBe("insights.updated");
  });
});
