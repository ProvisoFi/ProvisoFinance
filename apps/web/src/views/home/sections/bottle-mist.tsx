"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import type { SpringValue } from "@react-spring/web";

import { useMotionOff } from "@/hooks/use-motion-off";
import { subscribeToTicker } from "@/lib/animation/ticker";
import { createFrameClock } from "@/lib/scene/per-frame";
import { keepSceneAlive, releaseContext, watchContext } from "@/lib/scene/webgl-context";

/**
 * The bottle condenses out of an aerosol mist: its own pixels — more than one
 * droplet per CSS pixel, drawn one device pixel fine, lit as they fly — are
 * drawn in as one vortex fed from two opposite sides. Nothing fades in: the
 * mist flies in from off screen as two braids of fine threads — one from
 * beyond the top-left corner, one from beyond the bottom-right — tapering at
 * both ends, the threads winding round one another as they flow, along curves
 * that bend the same way round the bottle and coil into it like the arms of a
 * spiral; they meet in a two-armed whirl and wind into the bottle; mid-flight each
 * droplet curls on its own and eddies shear the ribbons, and they land
 * nearest-first, the ribbons draining in. The blur is depth: a few droplets pass close to the lens as soft
 * bokeh discs that focus down as they land, and the photo itself pulls into
 * focus through the settled droplets. The fine droplets themselves stay
 * sharp — a blur over one-pixel droplets would wipe them out. No glow layer:
 * a blurred copy of the mist read as a halo round the bottle. The mist thins
 * out towards the canvas edges, so the layer's box never shows.
 * `progress` (0 → 1) drives it — the stage's arrival, scrubbed by the scroll.
 *
 * The droplets are WebGL points: every position is worked out in the vertex
 * shader from the progress, so a frame costs a few uniforms and one draw call
 * however many droplets there are. Reduced motion, the robot form and a
 * device without WebGL get a plain fade.
 */

export interface BottleMistProps {
  src: string;
  alt: string;
  width: number;
  height: number;
  /** The bottle's box (position and size per breakpoint). */
  className: string;
  progress: SpringValue<number>;
  /** Server HTML starts it hidden under the hero (no flash before hydration). */
  startHidden: boolean;
}

/** The canvas reaches this far past the bottle box on each side (share of the box): room for the streams. */
const BLEED_X = 1.5;
const BLEED_Y = 0.7;
/** Sampling grid, CSS px: finer than a pixel, coarser only on a very big box. */
const MIN_STEP = 0.7;
const MAX_DROPLETS = 260000;
/** Share of droplets that pass close to the lens, and their disc size (CSS px). */
const BOKEH_SHARE = 0.02;
const BOKEH_MIN = 5;
const BOKEH_MAX = 16;
/** Cells more transparent than this are left out (the glass edge stays soft). */
const MIN_ALPHA = 24;
/** Every droplet has landed by this progress; the rest is the photo sharpening. */
const LAND = 0.88;
/** Share of the progress each droplet spends in flight; the rest of LAND staggers the starts. */
const FLIGHT = 0.55;
/** Barely a fade at the very start — the ribbons are off screen then anyway. */
const MIST_IN = 0.01;
/**
 * The ribbons fly in from off screen over this share of the progress, sliding
 * along their own curve, ENTRY_SPAN stream-lengths out at the start.
 */
const ENTRY_END = 0.38;
const ENTRY_SPAN = 0.9;
/**
 * Each stream is a braid of this many fine threads, each arriving LAG
 * stream-lengths after the one before. The threads wind round one another
 * (BRAID_TURNS crossings along the stream, BRAID_SPREAD stream-widths apart at
 * the widest), and the braid turns as it flows (BRAID_FLOW rad over the run).
 */
const STRANDS = 3;
const STRAND_LAG = 0.35;
const BRAID_TURNS = 2.5;
const BRAID_SPREAD = 2;
const BRAID_FLOW = 7;
/** The braid's width at the bottle and at the corner, as a share of the stream's own width there. */
const FLARE_NEAR = 0.3;
const FLARE_FAR = 1.5;
/**
 * Disorder, so the two streams are not mirror images and the braids are not
 * machine-made: each stream draws its own curve, coil, flare and braid pace
 * within ±ASYMMETRY of the design (and its corner angle within ±ANGLE_JITTER
 * rad); its line meanders (MEANDER rad, two waves); the braid's pace and width
 * drift along it; STRAY of the droplets fly loose of their thread, up to
 * STRAY_SPREAD times further; the second stream sets off STREAM_STAGGER later.
 */
const ASYMMETRY = 0.3;
const ANGLE_JITTER = 0.18;
const MEANDER = 0.35;
const STRAY = 0.2;
const STRAY_SPREAD = 5;
const STREAM_STAGGER = 0.18;
/** How loose a thread is about its line in the braid (stream-widths). */
const THREAD = 0.4;
/** The photo shows through from here on, as the settled droplets fade out. */
const SHARPEN = 0.86;
const MIST_OUT = 0.9;
/**
 * The vortex is fed by two streams from opposite corners of the screen (top
 * left, bottom right — measured, since the stage is scaled to cover the
 * window). Each droplet comes down the stream on its own side of the bottle's
 * diagonal (CROSS of them from the other one, so the two mix in the middle).
 */
const CROSS = 0.1;
/** Where a stream starts: this share of the way from the bottle to its corner. */
const STREAM_REACH = 0.98;
/** How far a stream bends round the bottle from its corner to the middle (rad). */
const STREAM_CURVE = 1.3;
/**
 * Extra bend that grows towards the bottle (rad, cubic in the way still to
 * go), with the inner part drawn in — so each stream coils into it like the
 * arm of a spiral rather than meeting it head on.
 */
const STREAM_COIL = 1.5;
/** Width of a stream: a share of its distance out, plus a share of the bottle width. */
const STREAM_WIDTH = 0.065;
const STREAM_CORE = 0.055;
/** How far the whole vortex turns as the droplets come in (rad); the streams curve the same way. */
const TWIST = 2.4;
/** Eddies wandering along the streams, two to each and one at the bottle. */
const EDDIES = 5;
/** Blur (px) of the photo as it first shows. */
const FOCUS_BLUR = 10;
/** Width of the fade at the canvas edges, as a share of its shorter side. */
const EDGE_FADE = 0.12;
/** Device-pixel ceiling for the canvas. */
const MAX_DPR = 2;
/** A droplet in flight: its size (device px), how far it is lit towards white, and the light it adds. */
const FLIGHT_SIZE = 1.7;
const FLIGHT_LIGHT = 0.6;
const FLIGHT_GLOW = 0.8;
/** Opacity of a droplet in flight (1 once landed): the braids read airy rather than solid. */
const FLIGHT_ALPHA = 0.55;

const VERTEX = `
attribute vec2 a_target;
attribute vec4 a_stream;
attribute vec4 a_motion;
attribute vec3 a_extra;
attribute vec4 a_color;
uniform vec2 u_size;
uniform vec2 u_center;
uniform vec2 u_stream0;
uniform vec2 u_stream1;
uniform vec4 u_shape0;
uniform vec4 u_shape1;
uniform float u_core;
uniform float u_p;
uniform float u_time;
uniform float u_mist;
uniform float u_cell;
uniform float u_dpr;
uniform vec4 u_eddy[${EDDIES}];
varying vec4 v_color;
varying float v_soft;

vec2 turn(vec2 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

void main() {
  // Its spot in its ribbon, which slides in along the stream's curve from
  // off screen: u (0 at the bottle, 1 at the corner) further out until the
  // ribbon has come in. Past the corner the curve carries on, off screen.
  vec2 stream = a_stream.w < 0.5 ? u_stream0 : u_stream1;
  // Its own curve, coil, flare and braid pace (each stream draws its own).
  vec4 shape = a_stream.w < 0.5 ? u_shape0 : u_shape1;
  // Smootherstep: the ribbons start and finish their entry with no jolt.
  float entry = clamp(u_p / ${ENTRY_END.toFixed(2)}, 0.0, 1.0);
  entry = entry * entry * entry * (entry * (entry * 6.0 - 15.0) + 10.0);
  float u = a_stream.x + (1.0 - entry) * (${ENTRY_SPAN.toFixed(2)} + a_stream.z);
  // The stream's line: bending round the bottle, coiling in near it.
  float inward = 1.0 - u;
  float r = stream.y * u * (0.82 + 0.18 * clamp(u, 0.0, 1.0));
  // …and a meander: two uneven waves along it, growing outwards.
  float meander = ${MEANDER.toFixed(2)} * u * (sin(u * 5.3 + stream.x * 3.0) + 0.6 * sin(u * 12.7 + stream.x * 7.0));
  float phi = stream.x - ${STREAM_CURVE.toFixed(2)} * shape.x * inward - ${STREAM_COIL.toFixed(2)} * shape.y * max(inward, 0.0) * inward * inward + meander;
  vec2 radial = vec2(cos(phi), sin(phi));
  vec2 across = vec2(-radial.y, radial.x);
  // Flared: fine at the bottle, widening out to the corner of the screen,
  // where it is widest (and wider still past it, off screen).
  float taper = ${FLARE_NEAR.toFixed(2)} + (${FLARE_FAR.toFixed(2)} * shape.z - ${FLARE_NEAR.toFixed(2)}) * pow(clamp(u, 0.0, 1.3), 1.2);
  float width = (r * ${STREAM_WIDTH.toFixed(3)} + u_core) * taper;
  // Its thread in the braid, winding round the others as the stream flows —
  // at a pace and a width that drift along it, so no two crossings match.
  float wave = u * ${(BRAID_TURNS * 2 * Math.PI).toFixed(3)} * shape.w + a_stream.y + u_p * ${BRAID_FLOW.toFixed(1)} + 0.9 * sin(u * 3.7 + a_stream.y * 1.3);
  float spread = ${BRAID_SPREAD.toFixed(2)} * (0.65 + 0.35 * sin(u * 4.3 + a_stream.y * 2.1));
  float braid = sin(wave) * spread;
  // Loose droplets also scatter along the stream, not only across it.
  vec2 spot = u_center + radial * (r + a_extra.z * width * 0.5) + across * (braid + a_extra.z) * width;
  // Un-turned: the vortex below turns it back by TWIST at the start of its flight.
  vec2 start = u_center + turn(spot - u_center, ${(-TWIST).toFixed(2)});

  float t = clamp((u_p - a_motion.x) / ${FLIGHT.toFixed(2)}, 0.0, 1.0);
  // Smootherstep: a droplet leaves its ribbon and settles with zero speed
  // and zero acceleration at both ends — the flow reads as one glide.
  float e = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  float rest = 1.0 - e;
  float rest2 = rest * rest;
  // Mid-flight only (none at the start, so the streams keep their shape,
  // none on landing): the droplet's own curl and the eddies.
  float mid = 4.0 * e * rest;
  // Its own curl: the way still to go, turned about its landing spot.
  vec2 pos = a_target + turn((start - a_target) * rest, a_motion.y * mid);
  // The vortex: everything turns about the bottle, unwinding as it lands.
  pos = u_center + turn(pos - u_center, ${TWIST.toFixed(2)} * rest2);
  // Eddies: a turn that fades with the distance from each centre.
  for (int k = 0; k < ${EDDIES}; k++) {
    vec2 d = pos - u_eddy[k].xy;
    pos = u_eddy[k].xy + turn(d, u_eddy[k].w * mid / (1.0 + dot(d, d) * u_eddy[k].z));
  }
  float a = a_motion.z + u_time * a_motion.w;
  pos += vec2(sin(a), cos(a * 0.8)) * a_extra.x * rest;

  // Thin out towards the canvas edges, so the layer's box never shows.
  vec2 margin = min(pos, u_size - pos) / (min(u_size.x, u_size.y) * ${EDGE_FADE.toFixed(2)});
  float edge = smoothstep(0.0, 1.0, min(margin.x, margin.y));
  vec2 clip = pos / u_size * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  // A fine bright speck in flight; a landed droplet covers its cell, so the
  // settled mist is solid.
  float size = mix(${FLIGHT_SIZE.toFixed(2)}, u_cell, smoothstep(0.6, 1.0, e));
  // Close to the lens: a soft disc that focuses down to a droplet as it lands.
  float bokeh = step(0.5, a_extra.y) * rest;
  size = mix(size, a_extra.y * u_dpr, bokeh);
  gl_PointSize = size;
  v_soft = bokeh;
  // Droplets in flight catch the light — lit towards white, and adding light
  // (premultiplied colour above its alpha) so the braids glow over the photo.
  vec3 rgb = mix(a_color.rgb, vec3(1.0), ${FLIGHT_LIGHT.toFixed(2)} * rest);
  float alpha = a_color.a * u_mist * edge * (${FLIGHT_ALPHA.toFixed(2)} + ${(1 - FLIGHT_ALPHA).toFixed(2)} * e) * mix(1.0, 0.35, bokeh);
  v_color = vec4(rgb * alpha * (1.0 + ${FLIGHT_GLOW.toFixed(2)} * rest), alpha);
}
`;

const FRAGMENT = `
precision mediump float;
varying vec4 v_color;
varying float v_soft;
void main() {
  float disc = 1.0 - smoothstep(0.15, 1.0, length(gl_PointCoord - 0.5) * 2.0);
  gl_FragColor = v_color * mix(1.0, disc, v_soft);
}
`;

interface Eddy {
  /** Resting centre and wander (canvas px), wander rate (rad/s) and phase. */
  x: number;
  y: number;
  ax: number;
  ay: number;
  rate: number;
  phase: number;
  /** 1 / radius², and the turn (rad) it gives a droplet at its centre. */
  inv: number;
  turn: number;
}

interface Layout {
  count: number;
  /** Canvas size and bottle centre, CSS px; droplet cell, device px. */
  width: number;
  height: number;
  /** The bottle's centre — the vortex's — canvas px. */
  cx: number;
  cy: number;
  /** Each stream's angle out from the bottle (rad) and its length (canvas px). */
  streams: [number, number][];
  /** Each stream's own curve, coil, flare and braid pace (multipliers). */
  shapes: [number, number, number, number][];
  /** Width every ribbon has even at the bottle, canvas px. */
  core: number;
  cell: number;
  dpr: number;
  eddies: Eddy[];
}

interface MistScene {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  /** Re-sample the bottle for the box's current size; false if it has none yet. */
  layout(): boolean;
  draw(p: number, mist: number, time: number): void;
  dispose(): void;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Standard normal from two uniforms (Box–Muller). */
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const between = (a: number, b: number) => a + Math.random() * (b - a);

const compile = (gl: WebGLRenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("bottle-mist: no shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "bottle-mist: shader");
  return shader;
};

/**
 * Main-thread time per slice of the layout job (ms). Sampling the bottle and
 * filling up to MAX_DROPLETS droplets was 150 ms in one task on a 4× phone,
 * inside the page's hydration (the phone's TBT). Sliced, one per frame, it
 * finishes under the preloader curtain, long before the first scroll draws
 * the mist.
 */
const FILL_SLICE_MS = 6;

/**
 * Floats per droplet: target (2), stream (4: place along it, its thread's
 * phase in the braid, entry lag, which stream), motion (4: delay, curl, phase,
 * rate), extra (3: reach, bokeh size, looseness about its thread).
 */
const STRIDE = 13;

const createMistScene = (box: HTMLElement, img: HTMLImageElement): MistScene => {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.className = "pointer-events-none absolute -top-[70%] -left-[150%] h-[240%] w-[400%]";
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false });
  if (!gl) throw new Error("bottle-mist: no WebGL");

  const program = gl.createProgram();
  if (!program) throw new Error("bottle-mist: no program");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "bottle-mist: link");
  gl.useProgram(program);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  const at = (name: string) => gl.getAttribLocation(program, name);
  const u = (name: string) => gl.getUniformLocation(program, name);
  const uniforms = {
    size: u("u_size"),
    center: u("u_center"),
    stream0: u("u_stream0"),
    stream1: u("u_stream1"),
    shape0: u("u_shape0"),
    shape1: u("u_shape1"),
    core: u("u_core"),
    p: u("u_p"),
    time: u("u_time"),
    mist: u("u_mist"),
    cell: u("u_cell"),
    dpr: u("u_dpr"),
    eddy: u("u_eddy"),
  };
  const data = gl.createBuffer();
  const colours = gl.createBuffer();
  const eddyValues = new Float32Array(EDDIES * 4);
  let layout: Layout | null = null;
  /** The fill in flight: a newer layout() supersedes it. */
  let generation = 0;
  let pending = 0;

  const bind = () => {
    const F = Float32Array.BYTES_PER_ELEMENT;
    gl.bindBuffer(gl.ARRAY_BUFFER, data);
    const fields: [string, number, number][] = [["a_target", 2, 0], ["a_stream", 4, 2], ["a_motion", 4, 6], ["a_extra", 3, 10]];
    for (const [name, size, offset] of fields) {
      const loc = at(name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * F, offset * F);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, colours);
    const colour = at("a_color");
    gl.enableVertexAttribArray(colour);
    gl.vertexAttribPointer(colour, 4, gl.UNSIGNED_BYTE, true, 0, 0);
  };

  const scene: MistScene = {
    canvas,
    gl,
    // Sizes the canvas now; sampling and the droplet fill run in slices
    // (FILL_SLICE_MS a frame) and the mist stays undrawn until they land.
    layout() {
      const bw = Math.round(img.clientWidth);
      const bh = Math.round(img.clientHeight);
      if (!bw || !bh || !img.naturalWidth) return false;
      const ox = Math.round(bw * BLEED_X);
      const oy = Math.round(bh * BLEED_Y);
      const W = bw + ox * 2;
      const H = bh + oy * 2;
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      // The window in canvas px: the stage is scaled to cover it, so the
      // streams start from the corners actually on screen. Read now — the
      // rest runs over the next frames.
      const rect = canvas.getBoundingClientRect();

      // Everything below is one resumable job: it yields every few hundred
      // pixels or droplets and the driver runs it FILL_SLICE_MS per frame.
      const work = function* (): Generator<void, Layout | null> {
        const sample = document.createElement("canvas");
        sample.width = bw;
        sample.height = bh;
        const sctx = sample.getContext("2d", { willReadFrequently: true });
        if (!sctx) return null;
        sctx.drawImage(img, 0, 0, bw, bh);
        const src = sctx.getImageData(0, 0, bw, bh).data;
        yield;

        let opaque = 0;
        for (let k = 3; k < src.length; k += 4) {
          if (src[k] >= MIN_ALPHA) opaque++;
          if ((k & 4095) === 3) yield;
        }
        const step = Math.max(MIN_STEP, Math.sqrt(opaque / MAX_DROPLETS));
        const cells: number[] = [];
        for (let y = 0; y < bh; y += step) {
          for (let x = 0; x < bw; x += step) {
            if (src[(Math.floor(y) * bw + Math.floor(x)) * 4 + 3] >= MIN_ALPHA) cells.push(x, y);
          }
          yield;
        }
        const count = cells.length / 2;
        const cx = ox + bw / 2;
        const cy = oy + bh / 2;
        const k2 = rect.width / W || 1;
        const clampX = (v: number) => Math.min(W, Math.max(0, v));
        const clampY = (v: number) => Math.min(H, Math.max(0, v));
        const vx0 = clampX(-rect.left / k2);
        const vx1 = clampX((window.innerWidth - rect.left) / k2);
        const vy0 = clampY(-rect.top / k2);
        const vy1 = clampY((window.innerHeight - rect.top) / k2);
        // The two streams: from the top-left and the bottom-right corner.
        const streams = [
          [vx0, vy0],
          [vx1, vy1],
        ].map(([x, y]) => ({
          angle: Math.atan2(y - cy, x - cx) + between(-ANGLE_JITTER, ANGLE_JITTER),
          reach: Math.hypot(x - cx, y - cy) * STREAM_REACH,
          // Curve, coil, flare, braid pace — each its own.
          shape: Array.from({ length: 4 }, () => between(1 - ASYMMETRY, 1 + ASYMMETRY)) as [number, number, number, number],
        }));
        // Which side of the bottle's diagonal (perpendicular to the streams) a droplet is on.
        const dx = Math.cos(streams[0].angle);
        const dy = Math.sin(streams[0].angle);
        const values = new Float32Array(count * STRIDE);
        const rgba = new Uint8Array(count * 4);
        // Flights start once the ribbons are on their way in.
        const delayFrom = ENTRY_END * 0.5;
        const fillOne = (i: number) => {
          const x = cells[i * 2];
          const y = cells[i * 2 + 1];
          const k = (Math.floor(y) * bw + Math.floor(x)) * 4;
          const o = i * STRIDE;
          // Anywhere in its cell, so the grid never shows.
          const tx = ox + x + Math.random() * step;
          const ty = oy + y + Math.random() * step;
          values[o] = tx;
          values[o + 1] = ty;
          const own = (tx - cx) * dx + (ty - cy) * dy > 0 ? 0 : 1;
          // Where on the stream: u = 1 at its corner, 0 at the bottle (the
          // shader bends it round the bottle the way the vortex turns, so the
          // droplets coming in carry on along it). Which of its ribbons: set
          // apart across the stream, each coming in after the one before.
          const u = Math.pow(Math.random(), 0.8);
          const strand = Math.floor(Math.random() * STRANDS);
          values[o + 2] = u;
          values[o + 3] = (strand * 2 * Math.PI) / STRANDS;
          const which = Math.random() < CROSS ? 1 - own : own;
          values[o + 4] = strand * STRAND_LAG + which * STREAM_STAGGER + Math.random() * 0.12;
          values[o + 5] = which;
          // Nearest the bottle first: the ribbons drain into it.
          values[o + 6] = delayFrom + (LAND - FLIGHT - delayFrom) * (0.2 * Math.random() + 0.8 * u);
          // Its own curl mid-flight, mostly with the vortex.
          values[o + 7] = (Math.random() < 0.75 ? 1 : -1) * between(0.2, 0.6);
          values[o + 8] = Math.random() * Math.PI * 2;
          values[o + 9] = between(0.3, 0.8);
          values[o + 10] = between(4, 12);
          values[o + 11] = Math.random() < BOKEH_SHARE ? between(BOKEH_MIN, BOKEH_MAX) : 0;
          values[o + 12] = gauss() * THREAD * (Math.random() < STRAY ? between(2, STRAY_SPREAD) : 1);
          rgba[i * 4] = src[k];
          rgba[i * 4 + 1] = src[k + 1];
          rgba[i * 4 + 2] = src[k + 2];
          rgba[i * 4 + 3] = src[k + 3];
        };

        const next: Layout = {
          count,
          width: W,
          height: H,
          cx,
          cy,
          streams: streams.map((st) => [st.angle, st.reach] as [number, number]),
          shapes: streams.map((st) => st.shape),
          core: bw * STREAM_CORE,
          cell: Math.max(1, Math.ceil(step * dpr)),
          dpr,
          eddies: Array.from({ length: EDDIES }, (_, k) => {
            // Two along each stream (a third and two thirds of the way out),
            // the last at the bottle; all turning with the vortex.
            const stream = streams[k % 2];
            const u = k === EDDIES - 1 ? 0 : k < 2 ? 0.35 : 0.65;
            const phi = stream.angle - STREAM_CURVE * (1 - u) - STREAM_COIL * (1 - u) ** 3;
            const size = Math.max(bw * 0.3, stream.reach * 0.18);
            const r = size * between(0.8, 1.2);
            return {
              x: cx + Math.cos(phi) * stream.reach * u,
              y: cy + Math.sin(phi) * stream.reach * u,
              ax: size * between(0.2, 0.4),
              ay: size * between(0.2, 0.4),
              rate: between(0.5, 1.1),
              phase: Math.random() * Math.PI * 2,
              inv: 1 / (r * r),
              turn: between(0.9, 1.6),
            };
          }),
        };

        for (let i = 0; i < count; i++) {
          fillOne(i);
          if ((i & 255) === 255) yield;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, data);
        gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, colours);
        gl.bufferData(gl.ARRAY_BUFFER, rgba, gl.STATIC_DRAW);
        bind();
        return next;
      };

      // The canvas was resized (cleared): nothing is drawn until this job lands.
      layout = null;
      const own = ++generation;
      cancelAnimationFrame(pending);
      const job = work();
      const slice = () => {
        if (own !== generation) return;
        const end = performance.now() + FILL_SLICE_MS;
        for (;;) {
          const r = job.next();
          if (r.done) {
            layout = r.value;
            return;
          }
          if (performance.now() > end) break;
        }
        pending = requestAnimationFrame(slice);
      };
      pending = requestAnimationFrame(slice);
      return true;
    },
    draw(p, mist, time) {
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!layout || mist <= 0) return;
      const { eddies } = layout;
      eddies.forEach((e, k) => {
        // Where the eddies have wandered to this frame.
        eddyValues[k * 4] = e.x + Math.sin(time * e.rate + e.phase) * e.ax;
        eddyValues[k * 4 + 1] = e.y + Math.cos(time * e.rate * 0.7 + e.phase) * e.ay;
        eddyValues[k * 4 + 2] = e.inv;
        eddyValues[k * 4 + 3] = e.turn;
      });
      gl.uniform2f(uniforms.size, layout.width, layout.height);
      gl.uniform2f(uniforms.center, layout.cx, layout.cy);
      gl.uniform2f(uniforms.stream0, ...layout.streams[0]);
      gl.uniform2f(uniforms.stream1, ...layout.streams[1]);
      gl.uniform4f(uniforms.shape0, ...layout.shapes[0]);
      gl.uniform4f(uniforms.shape1, ...layout.shapes[1]);
      gl.uniform1f(uniforms.core, layout.core);
      gl.uniform1f(uniforms.p, p);
      gl.uniform1f(uniforms.time, time);
      gl.uniform1f(uniforms.mist, mist);
      gl.uniform1f(uniforms.cell, layout.cell);
      gl.uniform1f(uniforms.dpr, layout.dpr);
      gl.uniform4fv(uniforms.eddy, eddyValues);
      gl.drawArrays(gl.POINTS, 0, layout.count);
    },
    dispose() {
      generation++;
      cancelAnimationFrame(pending);
      releaseContext(gl);
      canvas.remove();
    },
  };
  // Behind the photo.
  box.insertBefore(canvas, img);
  return scene;
};

/** Writes a style value only when it changed. */
const styled = new WeakMap<HTMLElement, Record<string, string>>();
const put = (el: HTMLElement, prop: "opacity" | "filter", value: string) => {
  const seen = styled.get(el) ?? {};
  if (seen[prop] === value) return;
  seen[prop] = value;
  styled.set(el, seen);
  el.style[prop] = value;
};
const blur = (px: number) => (px < 0.25 ? "none" : `blur(${(Math.round(px * 4) / 4).toFixed(2)}px)`);

/**
 * Loaded and decoded: `decode()` runs off the main thread, so the layout's
 * `drawImage` of the photo does not decode it in a task of its own (45 ms on a
 * 4× phone).
 */
const loaded = async (img: HTMLImageElement) => {
  if (!img.complete || !img.naturalWidth) {
    await new Promise<void>((resolve) => img.addEventListener("load", () => resolve(), { once: true }));
  }
  await img.decode().catch(() => {});
};

export function BottleMist({ src, alt, width, height, className, progress, startHidden }: BottleMistProps) {
  const motionOff = useMotionOff();
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    const img = imgRef.current;
    if (!box || !img) return;
    // A plain fade, written only on change.
    const fade = () => put(img, "opacity", clamp01(progress.get()).toFixed(3));
    if (motionOff) return subscribeToTicker(fade, () => 0);

    let scene: MistScene | null = null;
    let failed = false;
    let lastP = -1;
    let size = "";
    const clock = createFrameClock();

    const relayout = () => {
      const next = `${img.clientWidth}x${img.clientHeight}@${window.devicePixelRatio}`;
      if (!scene || next === size) return;
      if (!scene.layout()) return;
      size = next;
      lastP = -1;
    };

    const stopAlive = keepSceneAlive({
      container: box,
      // The mist rests undrawn at either end: no "still drawing?" self-check.
      watchMs: 0,
      build: async ({ onContextChange }) => {
        await loaded(img);
        const s = createMistScene(box, img);
        const stopWatch = watchContext(s.canvas, onContextChange);
        scene = s;
        size = "";
        relayout();
        return {
          isBroken: () => s.gl.isContextLost(),
          dispose: () => {
            stopWatch();
            if (scene === s) scene = null;
            s.dispose();
          },
        };
      },
      // No WebGL here: the photo just fades in.
      onFail: () => {
        failed = true;
      },
    });

    const resize = new ResizeObserver(() => relayout());
    resize.observe(img);

    const stop = subscribeToTicker((now) => {
      const { t } = clock.tick(now);
      if (failed) return fade();
      const p = clamp01(progress.get());
      // At rest at either end there is nothing to animate.
      if (p === lastP && (p === 0 || p === 1)) return;
      lastP = p;
      // The photo pulls into focus as it shows through.
      const shown = smooth(SHARPEN, 0.98, p);
      put(img, "opacity", shown.toFixed(3));
      put(img, "filter", blur(FOCUS_BLUR * (1 - shown)));
      const mist = smooth(0, MIST_IN, p) * (1 - smooth(MIST_OUT, 1, p));
      scene?.draw(p, mist, t);
    }, () => 0);

    return () => {
      stop();
      resize.disconnect();
      stopAlive();
    };
  }, [motionOff, progress]);

  return (
    <div ref={boxRef} className={className}>
      <Image
        ref={imgRef}
        src={src}
        alt={alt}
        width={width}
        height={height}
        priority
        className={`relative size-full ${startHidden ? "opacity-0" : ""}`}
      />
    </div>
  );
}
