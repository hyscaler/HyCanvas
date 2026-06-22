// Deep-copy a DesignFile with fresh ids. The
// produced design is fully decoupled from the source template: a new design id,
// new page ids, and new node ids (with internal references rewritten). Editing
// or deleting the source never affects a design created from this copy.

import { childrenOf, type DesignFile, type Node } from "@hc/schema";

type AnyRec = Record<string, unknown>;

function visitTree(node: Node, fn: (n: Node) => void): void {
  fn(node);
  for (const c of childrenOf(node)) visitTree(c, fn);
  const rec = node as unknown as AnyRec;
  if (node.type === "mask" && rec.child) visitTree(rec.child as Node, fn);
  if (node.type === "boolean" && Array.isArray(rec.operands)) {
    for (const op of rec.operands as Node[]) visitTree(op, fn);
  }
}

let counter = 0;
function defaultIdGen(): string {
  return `n-${++counter}`;
}

export interface DeepCopyResult {
  file: DesignFile;
  /** old node/page id -> new id, so external references (fillable fields) remap. */
  idMap: Map<string, string>;
}

export interface DeepCopyOptions {
  designId?: string;
  idGen?: () => string;
}

/** Deep-copy a design, regenerating the design id, page ids, and all node ids. */
export function deepCopyDesign(file: DesignFile, opts: DeepCopyOptions = {}): DeepCopyResult {
  const idGen = opts.idGen ?? defaultIdGen;
  const clone: DesignFile = JSON.parse(JSON.stringify(file));
  const idMap = new Map<string, string>();

  clone.id = opts.designId ?? idGen();

  for (const page of clone.pages) {
    const newPageId = idGen();
    idMap.set(page.id, newPageId);
    page.id = newPageId;
    for (const root of page.children) {
      visitTree(root, (n) => {
        const fresh = idGen();
        idMap.set(n.id, fresh);
        n.id = fresh;
      });
    }
  }

  // Rewrite connector endpoint attachments that point within the copied design.
  for (const page of clone.pages) {
    for (const root of page.children) {
      visitTree(root, (n) => {
        if (n.type !== "connector") return;
        const rec = n as unknown as AnyRec;
        for (const key of ["start", "end"] as const) {
          const ep = rec[key] as AnyRec | undefined;
          const attach = ep?.attach as AnyRec | undefined;
          const old = attach?.nodeId as string | undefined;
          if (old && idMap.has(old)) attach!.nodeId = idMap.get(old);
        }
      });
    }
  }

  return { file: clone, idMap };
}
