// Geometry types. VectorPath/SubPath/VectorAnchor live in @hc/schema (they are
// part of the file format); ParametricShape is a geometry input, not a node.

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ParametricShape =
  | { kind: "rect"; width: number; height: number; radius: [number, number, number, number] }
  | { kind: "ellipse"; width: number; height: number }
  | { kind: "polygon"; width: number; height: number; sides: number }
  | { kind: "star"; width: number; height: number; points: number; innerRatio: number }
  | { kind: "line"; length: number; angle: number };

/** Cubic bezier circle-approximation constant. */
export const kappa = 0.5522847498307936;
