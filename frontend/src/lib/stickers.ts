// Bundled, free graphics/stickers (Canva-style "Elements"). Each is a small,
// fill-only SVG (viewBox 0 0 100 100) so the SVG-to-vector parser (addIconSvg)
// turns it into fully editable vector nodes on insert. Kept fill-only (no
// stroke-dependent strokes) so every sticker round-trips cleanly.

export interface Sticker {
  id: string;
  label: string;
  category: string;
  svg: string;
}

const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;

export const STICKERS: Sticker[] = [
  // --- Shapes ---
  { id: "star", label: "Star", category: "Shapes", svg: svg('<path d="M50 6 61 38 95 38 67 58 78 92 50 72 22 92 33 58 5 38 39 38Z" fill="#f59e0b"/>') },
  { id: "heart", label: "Heart", category: "Shapes", svg: svg('<path d="M50 86C20 64 8 44 8 28 8 16 18 8 30 8 40 8 47 14 50 22 53 14 60 8 70 8 82 8 92 16 92 28 92 44 80 64 50 86Z" fill="#ef4444"/>') },
  { id: "diamond", label: "Diamond", category: "Shapes", svg: svg('<path d="M50 6 94 50 50 94 6 50Z" fill="#06b6d4"/>') },
  { id: "hexagon", label: "Hexagon", category: "Shapes", svg: svg('<path d="M50 6 88 28 88 72 50 94 12 72 12 28Z" fill="#8b5cf6"/>') },
  { id: "sparkle", label: "Sparkle", category: "Shapes", svg: svg('<path d="M50 8C54 30 70 46 92 50 70 54 54 70 50 92 46 70 30 54 8 50 30 46 46 30 50 8Z" fill="#a855f7"/>') },
  { id: "lightning", label: "Lightning", category: "Shapes", svg: svg('<path d="M56 4 26 54h20l-4 42 34-56H58l6-36Z" fill="#facc15"/>') },
  { id: "cross", label: "Plus", category: "Shapes", svg: svg('<path d="M40 8h20v32h32v20H60v32H40V60H8V40h32Z" fill="#22c55e"/>') },
  { id: "arrow", label: "Arrow", category: "Shapes", svg: svg('<path d="M6 38h44V18l44 32-44 32V62H6Z" fill="#3b82f6"/>') },

  // --- Badges & decor ---
  { id: "bubble", label: "Speech bubble", category: "Badges", svg: svg('<path d="M18 12h64a10 10 0 0 1 10 10v36a10 10 0 0 1-10 10H46L26 92l3-24H18a10 10 0 0 1-10-10V22a10 10 0 0 1 10-10Z" fill="#3b82f6"/>') },
  { id: "banner", label: "Banner", category: "Badges", svg: svg('<path d="M14 26h72v40H66l-16 14-16-14H14Z" fill="#f43f5e"/>') },
  { id: "seal", label: "Seal badge", category: "Badges", svg: svg('<path d="M50 4 62 14 77 11 80 26 94 32 86 45 92 59 77 62 72 77 57 73 50 87 43 73 28 77 23 62 8 59 14 45 6 32 20 26 23 11 38 14Z" fill="#10b981"/>') },
  { id: "pin", label: "Location pin", category: "Badges", svg: svg('<path d="M50 94C30 64 24 50 24 38a26 26 0 0 1 52 0c0 12-6 26-26 56Z" fill="#ef4444"/><circle cx="50" cy="38" r="10" fill="#ffffff"/>') },

  // --- Nature & fun ---
  { id: "leaf", label: "Leaf", category: "Nature", svg: svg('<path d="M18 82C18 42 48 14 84 14 84 54 54 82 18 82Z" fill="#16a34a"/>') },
  { id: "cloud", label: "Cloud", category: "Nature", svg: svg('<path d="M28 74a20 20 0 0 1 3-39 24 24 0 0 1 45 7 16 16 0 0 1-3 32Z" fill="#93c5fd"/>') },
  { id: "flower", label: "Flower", category: "Nature", svg: svg('<circle cx="50" cy="24" r="15" fill="#f472b6"/><circle cx="76" cy="42" r="15" fill="#f472b6"/><circle cx="66" cy="72" r="15" fill="#f472b6"/><circle cx="34" cy="72" r="15" fill="#f472b6"/><circle cx="24" cy="42" r="15" fill="#f472b6"/><circle cx="50" cy="50" r="13" fill="#fde047"/>') },
  { id: "crown", label: "Crown", category: "Nature", svg: svg('<path d="M14 74 8 30l24 18L50 18l18 30 24-18-6 44Z" fill="#f59e0b"/>') },
  { id: "tree", label: "Tree", category: "Nature", svg: svg('<path d="M50 8 78 46H58v14h12L50 92 30 60h12V46H22Z" fill="#16a34a"/><rect x="44" y="78" width="12" height="16" fill="#92400e"/>') },
  { id: "mountain", label: "Mountain", category: "Nature", svg: svg('<path d="M6 84 38 28 58 60 70 40 94 84Z" fill="#475569"/><path d="M30 42 38 28 47 44 42 50 38 44 34 50Z" fill="#ffffff"/>') },
  { id: "raindrop", label: "Raindrop", category: "Nature", svg: svg('<path d="M50 8C30 40 24 54 24 66a26 26 0 0 0 52 0c0-12-6-26-26-58Z" fill="#38bdf8"/>') },
  { id: "moon", label: "Moon", category: "Nature", svg: svg('<path d="M64 10a40 40 0 1 0 0 80 32 32 0 0 1 0-80Z" fill="#fbbf24"/>') },
  { id: "burst", label: "Starburst", category: "Nature", svg: svg('<path d="M50 4 58 28 80 16 70 40 96 44 74 56 88 78 62 70 56 96 44 74 22 88 30 62 6 56 28 44 18 18 42 28Z" fill="#fb7185"/>') },

  // --- Symbols ---
  { id: "check", label: "Check", category: "Symbols", svg: svg('<circle cx="50" cy="50" r="44" fill="#22c55e"/><path d="M42 76 18 52 28 42 42 56 74 24 84 34Z" fill="#ffffff"/>') },
  { id: "xmark", label: "Cross out", category: "Symbols", svg: svg('<circle cx="50" cy="50" r="44" fill="#ef4444"/><path d="M32 26 50 44 68 26 74 32 56 50 74 68 68 74 50 56 32 74 26 68 44 50 26 32Z" fill="#ffffff"/>') },
  { id: "info", label: "Info", category: "Symbols", svg: svg('<circle cx="50" cy="50" r="44" fill="#3b82f6"/><circle cx="50" cy="30" r="6" fill="#ffffff"/><rect x="44" y="42" width="12" height="32" rx="3" fill="#ffffff"/>') },
  { id: "shield", label: "Shield", category: "Symbols", svg: svg('<path d="M50 8 84 20v26c0 24-16 38-34 46C32 84 16 70 16 46V20Z" fill="#6366f1"/>') },
  { id: "bookmark", label: "Bookmark", category: "Symbols", svg: svg('<path d="M28 10h44v80L50 72 28 90Z" fill="#a855f7"/>') },
  { id: "tag", label: "Tag", category: "Symbols", svg: svg('<path d="M52 10H88v36L46 88 12 54Z" fill="#f59e0b"/><circle cx="70" cy="28" r="6" fill="#ffffff"/>') },
  { id: "bell", label: "Bell", category: "Symbols", svg: svg('<path d="M50 12a8 8 0 0 1 8 8c14 5 14 20 14 32 0 12 6 16 6 16H22s6-4 6-16c0-12 0-27 14-32a8 8 0 0 1 8-8Z" fill="#f59e0b"/><circle cx="50" cy="84" r="8" fill="#f59e0b"/>') },
  { id: "quote", label: "Quote", category: "Symbols", svg: svg('<path d="M14 60c0-18 10-30 26-32v12c-8 2-12 8-12 14h12v22H14Zm44 0c0-18 10-30 26-32v12c-8 2-12 8-12 14h12v22H58Z" fill="#64748b"/>') },

  // --- Fun ---
  { id: "smiley", label: "Smiley", category: "Fun", svg: svg('<circle cx="50" cy="50" r="44" fill="#fbbf24"/><circle cx="36" cy="42" r="6" fill="#1f2937"/><circle cx="64" cy="42" r="6" fill="#1f2937"/><path d="M30 60a22 16 0 0 0 40 0Z" fill="#1f2937"/>') },
  { id: "flame", label: "Flame", category: "Fun", svg: svg('<path d="M52 6c4 18 22 24 22 46a24 24 0 0 1-48 0c0-10 5-15 9-20 2 7 7 9 7 9-3-14 4-26 10-35Z" fill="#f97316"/>') },
  { id: "gift", label: "Gift", category: "Fun", svg: svg('<rect x="16" y="40" width="68" height="48" rx="4" fill="#ec4899"/><rect x="44" y="40" width="12" height="48" fill="#be185d"/><rect x="12" y="30" width="76" height="14" rx="4" fill="#f472b6"/><path d="M50 30C40 30 30 24 30 16c0-5 6-7 10-4 5 4 10 14 10 18Zm0 0c10 0 20-6 20-14 0-5-6-7-10-4-5 4-10 14-10 18Z" fill="#be185d"/>') },
  { id: "balloon", label: "Balloon", category: "Fun", svg: svg('<ellipse cx="50" cy="40" rx="28" ry="34" fill="#ef4444"/><path d="M44 72h12l-2 8h-8Z" fill="#b91c1c"/>') },
  { id: "bulb", label: "Idea", category: "Fun", svg: svg('<circle cx="50" cy="40" r="28" fill="#facc15"/><rect x="38" y="62" width="24" height="14" rx="3" fill="#9ca3af"/><rect x="42" y="78" width="16" height="8" rx="3" fill="#6b7280"/>') },
  { id: "plane", label: "Paper plane", category: "Fun", svg: svg('<path d="M8 48 92 10 64 92 48 62Z" fill="#3b82f6"/><path d="M48 62 92 10 48 54Z" fill="#1d4ed8"/>') },
  { id: "music", label: "Music note", category: "Fun", svg: svg('<path d="M40 16h36v12H52v44a16 14 0 1 1-12-13V16Z" fill="#8b5cf6"/>') },
];

export const STICKER_CATEGORIES = Array.from(new Set(STICKERS.map((s) => s.category)));
