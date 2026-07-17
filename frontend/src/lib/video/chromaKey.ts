// WebGL chroma keyer: turns a key color transparent on video frames, with
// tolerance/spill/feather from the timeline's ChromaKey model. One instance
// per player; apply() renders the keyed frame into an internal canvas that the
// compositor draws like any other source. Falls back to null (caller draws
// the unkeyed frame) when WebGL is unavailable.

import type { ChromaKey } from "@hc/timeline";

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Key distance in CbCr (chroma) space: robust against lighting variation on
// the backdrop. Spill suppression clamps the key-dominant channel toward the
// other two so leftover green/blue fringes desaturate.
const FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec3 uKey;      // key color, linear 0..1 rgb
uniform float uTol;     // chroma distance fully transparent below
uniform float uFeather; // transition width above uTol
uniform float uSpill;   // 0..1 spill suppression strength
vec2 cbcr(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return vec2((c.b - y) * 0.565, (c.r - y) * 0.713);
}
void main() {
  vec4 px = texture2D(uTex, vUv);
  float d = distance(cbcr(px.rgb), cbcr(uKey));
  float alpha = smoothstep(uTol, uTol + max(uFeather, 0.001), d);
  vec3 rgb = px.rgb;
  // Suppress spill near the key: pull the dominant key channel down toward
  // the max of the other two, scaled by proximity to the key color.
  float near = 1.0 - smoothstep(uTol, uTol + max(uFeather, 0.001) + 0.15, d);
  float s = near * uSpill;
  if (uKey.g >= uKey.r && uKey.g >= uKey.b) {
    rgb.g = mix(rgb.g, min(rgb.g, max(rgb.r, rgb.b)), s);
  } else if (uKey.b >= uKey.r) {
    rgb.b = mix(rgb.b, min(rgb.b, max(rgb.r, rgb.g)), s);
  } else {
    rgb.r = mix(rgb.r, min(rgb.r, max(rgb.g, rgb.b)), s);
  }
  gl_FragColor = vec4(rgb * (px.a * alpha), px.a * alpha); // premultiplied
}`;

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 1, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class ChromaKeyer {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null;
  private tex: WebGLTexture | null = null;
  private uKey: WebGLUniformLocation | null = null;
  private uTol: WebGLUniformLocation | null = null;
  private uFeather: WebGLUniformLocation | null = null;
  private uSpill: WebGLUniformLocation | null = null;

  constructor() {
    this.canvas = document.createElement("canvas");
    // Premultiplied output composites correctly through ctx.drawImage.
    this.gl = this.canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true });
    const gl = this.gl;
    if (!gl) return;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = vs && fs ? gl.createProgram() : null;
    if (!prog || !vs || !fs) {
      this.gl = null;
      return;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      this.gl = null;
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.uKey = gl.getUniformLocation(prog, "uKey");
    this.uTol = gl.getUniformLocation(prog, "uTol");
    this.uFeather = gl.getUniformLocation(prog, "uFeather");
    this.uSpill = gl.getUniformLocation(prog, "uSpill");
  }

  /** Keyed frame as a drawable canvas, or null when WebGL is unavailable. */
  apply(src: TexImageSource, width: number, height: number, key: ChromaKey): HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl || width < 1 || height < 1) return null;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
    const [r, g, b] = hexToRgb(key.keyColor);
    gl.uniform3f(this.uKey, r, g, b);
    // Model knobs: tolerance 0..1 maps to a chroma radius; edgeFeather is
    // spec'd in px, mapped to a softness band (px/100, clamped).
    gl.uniform1f(this.uTol, Math.max(0.01, Math.min(0.6, key.tolerance * 0.4)));
    gl.uniform1f(this.uFeather, Math.max(0.005, Math.min(0.5, key.edgeFeather / 100)));
    gl.uniform1f(this.uSpill, Math.max(0, Math.min(1, key.spill)));
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch {
      return null; // tainted/unready source
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }
}
