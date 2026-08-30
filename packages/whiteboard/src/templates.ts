// Whiteboard starter templates (FR-6). Each builder returns a positioned set of
// real schema nodes (sticky/frame/connector/text/shape) with fresh ids. Pure.

import {
  createNode,
  newId,
  type Color,
  type Fill,
  type Node,
} from "@hc/schema";

export interface WhiteboardTemplate {
  id: string;
  name: string;
}

export const whiteboardTemplates: WhiteboardTemplate[] = [
  { id: "brainstorm", name: "Brainstorm" },
  { id: "retro", name: "Retrospective" },
  { id: "flowchart", name: "Flowchart" },
  { id: "mindmap", name: "Mind Map" },
  { id: "kanban", name: "Kanban Board" },
  { id: "userJourney", name: "User Journey" },
  { id: "swot", name: "SWOT Analysis" },
  { id: "orgChart", name: "Org Chart" },
];

const WHITE: Color = { srgb: { r: 1, g: 1, b: 1, a: 1 } };
const DARK: Color = { srgb: { r: 0.1, g: 0.1, b: 0.12, a: 1 } };

function rgb(r: number, g: number, b: number): Color {
  return { srgb: { r, g, b, a: 1 } };
}

function solid(color: Color): Fill {
  return { type: "solid", color };
}

// --- small node helpers -----------------------------------------------------

function place(node: Node, x: number, y: number, w: number, h: number): Node {
  node.transform = { ...node.transform, x, y };
  node.size = { width: w, height: h };
  return node;
}

function sticky(
  text: string,
  x: number,
  y: number,
  fill: Fill,
  w = 160,
  h = 160,
): Node {
  const n = createNode("sticky", { id: newId(), text, fill, textColor: DARK });
  return place(n, x, y, w, h);
}

function frame(title: string, x: number, y: number, w: number, h: number, fill?: Fill): Node {
  const n = createNode("frame", {
    id: newId(),
    name: title,
    clip: false,
    children: [],
    fills: fill ? [fill] : [solid(WHITE)],
  });
  return place(n, x, y, w, h);
}

function label(text: string, x: number, y: number, w = 200, h = 40): Node {
  const n = createNode("text", { id: newId() });
  n.content = [
    {
      runs: [
        {
          text,
          style: { fontFamily: "Inter", fontStyle: "normal", fontSize: 24, fill: solid(DARK) },
        },
      ],
      style: { align: "left", direction: "auto" },
    },
  ];
  return place(n, x, y, w, h);
}

function shapeBox(x: number, y: number, w = 140, h = 80, fill?: Fill): Node {
  const n = createNode("shape", { id: newId(), shape: "rect", fills: [fill ?? solid(rgb(0.86, 0.92, 1))] });
  return place(n, x, y, w, h);
}

function connect(
  fromId: string,
  toId: string,
  route: "straight" | "elbow" | "curved",
): Node {
  return createNode("connector", {
    id: newId(),
    route,
    start: { attach: { nodeId: fromId, anchor: "auto" } },
    end: { attach: { nodeId: toId, anchor: "auto" } },
  });
}

// --- template builders ------------------------------------------------------

function buildBrainstorm(): Node[] {
  const nodes: Node[] = [label("Brainstorm", 0, -60)];
  const colors = [
    solid(rgb(1, 0.898, 0.4)),
    solid(rgb(0.7, 0.9, 1)),
    solid(rgb(0.8, 1, 0.8)),
    solid(rgb(1, 0.8, 0.85)),
  ];
  let i = 0;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      nodes.push(sticky(`Idea ${i + 1}`, col * 200, row * 200, colors[i % colors.length]));
      i++;
    }
  }
  return nodes;
}

function buildRetro(): Node[] {
  const cols = [
    { title: "Went well", fill: solid(rgb(0.82, 0.96, 0.82)) },
    { title: "To improve", fill: solid(rgb(1, 0.92, 0.78)) },
    { title: "Action items", fill: solid(rgb(0.82, 0.9, 1)) },
  ];
  const nodes: Node[] = [];
  cols.forEach((c, idx) => {
    const fx = idx * 320;
    nodes.push(frame(c.title, fx, 0, 280, 640, c.fill));
    nodes.push(sticky("", fx + 60, 80, c.fill));
    nodes.push(sticky("", fx + 60, 280, c.fill));
  });
  return nodes;
}

function buildFlowchart(): Node[] {
  const start = shapeBox(0, 0, 140, 70, solid(rgb(0.8, 0.95, 0.85)));
  const process = shapeBox(0, 160, 160, 80);
  const decision = shapeBox(-20, 320, 200, 100, solid(rgb(1, 0.92, 0.7)));
  const end = shapeBox(0, 500, 140, 70, solid(rgb(1, 0.85, 0.85)));
  return [
    label("Flowchart", 0, -60),
    start,
    process,
    decision,
    end,
    connect(start.id, process.id, "elbow"),
    connect(process.id, decision.id, "elbow"),
    connect(decision.id, end.id, "elbow"),
  ];
}

function buildMindMap(): Node[] {
  const center = sticky("Topic", 0, 0, solid(rgb(0.7, 0.85, 1)), 180, 120);
  const nodes: Node[] = [center];
  const branches = ["Idea A", "Idea B", "Idea C", "Idea D", "Idea E"];
  const r = 320;
  branches.forEach((b, i) => {
    const angle = (i / branches.length) * Math.PI * 2;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    const child = sticky(b, x, y, solid(rgb(1, 0.898, 0.4)), 150, 100);
    nodes.push(child);
    nodes.push(connect(center.id, child.id, "curved"));
  });
  return nodes;
}

function buildKanban(): Node[] {
  const cols = ["Backlog", "In progress", "Review", "Done"];
  const nodes: Node[] = [];
  cols.forEach((title, idx) => {
    const fx = idx * 300;
    nodes.push(frame(title, fx, 0, 260, 700, solid(rgb(0.95, 0.95, 0.97))));
    nodes.push(sticky("Task", fx + 50, 80, solid(rgb(1, 0.898, 0.4))));
  });
  return nodes;
}

function buildUserJourney(): Node[] {
  const stages = ["Awareness", "Consideration", "Decision", "Retention"];
  const nodes: Node[] = [label("User Journey", 0, -60)];
  stages.forEach((s, idx) => {
    const fx = idx * 320;
    nodes.push(frame(s, fx, 0, 280, 360, solid(rgb(0.93, 0.95, 1))));
    nodes.push(sticky("", fx + 60, 80, solid(rgb(1, 0.898, 0.4))));
  });
  return nodes;
}

function buildSwot(): Node[] {
  const cells = [
    { title: "Strengths", fill: solid(rgb(0.82, 0.96, 0.82)) },
    { title: "Weaknesses", fill: solid(rgb(1, 0.86, 0.82)) },
    { title: "Opportunities", fill: solid(rgb(0.82, 0.9, 1)) },
    { title: "Threats", fill: solid(rgb(1, 0.92, 0.72)) },
  ];
  const nodes: Node[] = [];
  cells.forEach((c, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const fx = col * 420;
    const fy = row * 420;
    nodes.push(frame(c.title, fx, fy, 400, 400, c.fill));
    nodes.push(sticky("", fx + 60, fy + 80, c.fill));
  });
  return nodes;
}

function buildOrgChart(): Node[] {
  const ceo = sticky("CEO", 320, 0, solid(rgb(0.7, 0.85, 1)), 160, 90);
  const vp1 = sticky("VP Eng", 120, 200, solid(rgb(0.85, 0.92, 1)), 160, 90);
  const vp2 = sticky("VP Sales", 520, 200, solid(rgb(0.85, 0.92, 1)), 160, 90);
  const ic1 = sticky("Team A", 0, 400, solid(rgb(1, 0.898, 0.4)), 150, 80);
  const ic2 = sticky("Team B", 240, 400, solid(rgb(1, 0.898, 0.4)), 150, 80);
  const ic3 = sticky("Team C", 520, 400, solid(rgb(1, 0.898, 0.4)), 150, 80);
  return [
    ceo,
    vp1,
    vp2,
    ic1,
    ic2,
    ic3,
    connect(ceo.id, vp1.id, "elbow"),
    connect(ceo.id, vp2.id, "elbow"),
    connect(vp1.id, ic1.id, "elbow"),
    connect(vp1.id, ic2.id, "elbow"),
    connect(vp2.id, ic3.id, "elbow"),
  ];
}

const BUILDERS: Record<string, () => Node[]> = {
  brainstorm: buildBrainstorm,
  retro: buildRetro,
  flowchart: buildFlowchart,
  mindmap: buildMindMap,
  kanban: buildKanban,
  userJourney: buildUserJourney,
  swot: buildSwot,
  orgChart: buildOrgChart,
};

/** Build a template's starter scene graph. Throws on an unknown id. */
export function buildTemplate(id: string): { nodes: Node[] } {
  const build = BUILDERS[id];
  if (!build) throw new Error(`buildTemplate: unknown template id "${id}"`);
  return { nodes: build() };
}
