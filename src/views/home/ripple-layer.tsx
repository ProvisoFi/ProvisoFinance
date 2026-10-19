"use client";

import { useEffect, useRef } from "react";
import { useSpring } from "@react-spring/web";

import { useMotionOff } from "@/hooks/use-motion-off";
import { subscribeToTicker } from "@/lib/animation/ticker";
import { keepSceneAlive, releaseContext, watchContext } from "@/lib/scene/webgl-context";

/**
 * The cursor ripple from the GetLayers "Forma" template (its hero video —
 * `ripple-video.tsx`), laid over a still picture instead: wherever the pointer
 * moves, rings spread from it and push the picture's pixels along their
 * radius, so the photo ripples like water and a moving pointer leaves a wake.
 * The wave constants (speed, life, width, amplitude, frequency, spawn
 * spacing, the hover-intensity spring) are Forma's, unchanged.
 *
 * Lies over its picture — an `<img>` or a `<canvas>` in the same box, painted
 * `object-cover` — and only shows while a ripple is alive: at rest the canvas
 * is hidden and the picture itself is what you see, so an idle page draws
 * nothing. The pointer is read on the window (the picture usually sits under
 * copy, cards and other layers that would catch the events). Reduced motion,
 * the robot form, touch and a device without WebGL get the plain picture.
 */

/** Concurrent ripples. Must match `MAX_RIPPLES` in the fragment shader. */
const MAX_RIPPLES = 14;
/** Minimum pointer travel (CSS px) between two spawns. */
const SPAWN_DISTANCE = 26;
/** Ripple lifetime (s). Keep in sync with `LIFE` in the fragment shader. */
const RIPPLE_LIFE = 1.5;
/** Far enough in the past that an unused slot is always expired. */
const NEVER = -1000;
/** Device-pixel ceiling for the canvas. */
const MAX_DPR = 2;

const VERTEX_SHADER = /* glsl */ `
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

/**
 * Forma's shader. Each ripple is an expanding ring: inside a gaussian envelope
 * travelling outward at SPEED, texels are pushed along the radius by a sine, so
 * the distortion reads as a wave crossing the surface rather than a bulge.
 * Rings accumulate — that is the wake.
 */
const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  #define MAX_RIPPLES ${MAX_RIPPLES}

  varying vec2 vUv;

  uniform sampler2D uTexture;
  uniform vec2 uResolution;
  uniform vec2 uMedia;
  uniform float uTime;
  uniform float uIntensity;
  uniform vec3 uRipples[MAX_RIPPLES];

  const float SPEED = 340.0;
  const float LIFE = ${RIPPLE_LIFE.toFixed(1)};
  const float WIDTH = 90.0;
  const float AMPLITUDE = 24.0;
  const float FREQ = 0.055;

  /** Maps the box's uv onto the texture the way CSS object-fit: cover does. */
  vec2 coverUv(vec2 uv) {
    float canvasAspect = uResolution.x / uResolution.y;
    float mediaAspect = uMedia.x / uMedia.y;
    vec2 scale = canvasAspect > mediaAspect
      ? vec2(1.0, mediaAspect / canvasAspect)
      : vec2(canvasAspect / mediaAspect, 1.0);
    return (uv - 0.5) * scale + 0.5;
  }

  /** Keeps lookups off the outermost texels, so a push past the border never smears the edge. */
  vec2 safeUv(vec2 uv) {
    vec2 guard = 1.5 / uMedia;
    return clamp(uv, guard, 1.0 - guard);
  }

  void main() {
    vec2 fragment = vUv * uResolution;
    vec2 offset = vec2(0.0);

    for (int i = 0; i < MAX_RIPPLES; i++) {
      vec3 ripple = uRipples[i];
      float age = uTime - ripple.z;
      if (age < 0.0 || age > LIFE) continue;

      vec2 delta = fragment - ripple.xy;
      float dist = length(delta);
      if (dist < 0.001) continue;

      float radius = age * SPEED;
      float envelope = exp(-pow((dist - radius) / WIDTH, 2.0));
      float decay = 1.0 - age / LIFE;
      float wave = sin((dist - radius) * FREQ);

      offset += (delta / dist) * wave * envelope * decay * decay * AMPLITUDE;
    }

    vec2 uv = coverUv(vUv + (offset * uIntensity) / uResolution);
    gl_FragColor = texture2D(uTexture, safeUv(uv));
  }
`;

type Picture = HTMLImageElement | HTMLCanvasElement;

interface Scene {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  texture: WebGLTexture;
  uniforms: Record<"texture" | "resolution" | "media" | "time" | "intensity" | "ripples", WebGLUniformLocation | null>;
}

const compile = (gl: WebGLRenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("ripple-layer: no shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "ripple-layer: shader");
  return shader;
};

const createScene = (canvas: HTMLCanvasElement): Scene => {
  // Alpha, so a picture that is not painted yet (a blank scrub canvas) shows
  // through to whatever lies under it rather than as black.
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) throw new Error("ripple-layer: no WebGL");
  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  if (!program || !buffer || !texture) throw new Error("ripple-layer: no resources");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "ripple-layer: link");
  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "aPosition");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  gl.bindTexture(gl.TEXTURE_2D, texture);
  // One transparent texel, so the texture is complete from the first draw.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

  const u = (name: string) => gl.getUniformLocation(program, name);
  return {
    canvas,
    gl,
    texture,
    uniforms: {
      texture: u("uTexture"),
      resolution: u("uResolution"),
      media: u("uMedia"),
      time: u("uTime"),
      intensity: u("uIntensity"),
      ripples: u("uRipples"),
    },
  };
};

const mediaSize = (picture: Picture): [number, number] =>
  picture instanceof HTMLImageElement ? [picture.naturalWidth, picture.naturalHeight] : [picture.width, picture.height];

export interface RippleLayerProps {
  /**
   * The picture to ripple, looked up inside this layer's parent: the first
   * match that is laid out (a responsive variant hidden by CSS is skipped).
   */
  source?: string;
  /** The picture repaints (a scroll-scrubbed canvas): upload it every frame while rippling. */
  live?: boolean;
}

export function RippleLayer({ source = "img", live = false }: RippleLayerProps) {
  const motionOff = useMotionOff();
  const hostRef = useRef<HTMLDivElement>(null);
  const over = useRef(false);
  // Forma's hover spring: the distortion eases in and out with the pointer.
  const [{ intensity }, intensityApi] = useSpring(() => ({ intensity: 0, config: { tension: 120, friction: 26 } }));

  useEffect(() => {
    const host = hostRef.current;
    const box = host?.parentElement;
    if (motionOff || !host || !box || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    // The canvas the current context draws on: a fresh one per (re)build — a
    // released context cannot be had again from the same canvas.
    let canvas = document.createElement("canvas");

    const ripples = new Float32Array(MAX_RIPPLES * 3);
    for (let i = 0; i < MAX_RIPPLES; i++) ripples[i * 3 + 2] = NEVER;
    const cursor = { x: 0, y: 0, index: 0 };
    const start = performance.now();
    const now = () => (performance.now() - start) / 1000;
    let lastSpawn = NEVER;
    let scene: Scene | null = null;
    let uploaded: Picture | null = null;
    let shown = false;
    let inView = false;

    const picture = (): Picture | null => {
      for (const el of box.querySelectorAll<HTMLElement>(source)) {
        if (host.contains(el) || !el.offsetWidth) continue;
        if (el instanceof HTMLImageElement && el.complete && el.naturalWidth) return el;
        if (el instanceof HTMLCanvasElement && el.width) return el;
      }
      return null;
    };

    // At rest the host is hidden and the picture itself shows. While the
    // ripple shows, the picture under it is hidden: a picture with alpha (the
    // footer flower) drawn twice — itself and its copy over it — reads denser
    // and lighter than it is.
    let covered: HTMLElement | null = null;
    const show = (on: boolean) => {
      if (on === shown) return;
      shown = on;
      host.style.opacity = on ? "1" : "0";
      if (covered) covered.style.opacity = "";
      covered = on ? uploaded : null;
      if (covered) covered.style.opacity = "0";
    };

    const stopAlive = keepSceneAlive({
      container: box,
      watchMs: 0,
      build: ({ onContextChange }) => {
        const next = document.createElement("canvas");
        next.className = "absolute inset-0 size-full";
        const s = createScene(next);
        const stopWatch = watchContext(next, onContextChange);
        host.replaceChildren(next);
        canvas = next;
        scene = s;
        uploaded = null;
        return {
          isBroken: () => s.gl.isContextLost(),
          dispose: () => {
            stopWatch();
            if (scene === s) scene = null;
            show(false);
            releaseContext(s.gl);
            next.remove();
          },
        };
      },
    });

    // In the box's own (unscaled) pixels, y up — the shader's space. The
    // picture often sits under scaled or zoomed layers, so the screen rect is
    // mapped back by the ratio of its layout size to its drawn size.
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch" || !inView) return;
      const rect = box.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (inside !== over.current) {
        over.current = inside;
        intensityApi.start({ intensity: inside ? 1 : 0 });
      }
      if (!inside || !rect.width || !rect.height) return;
      const x = ((event.clientX - rect.left) * box.offsetWidth) / rect.width;
      const y = box.offsetHeight - ((event.clientY - rect.top) * box.offsetHeight) / rect.height;
      if (Math.hypot(x - cursor.x, y - cursor.y) < SPAWN_DISTANCE) return;
      cursor.x = x;
      cursor.y = y;
      const slot = cursor.index % MAX_RIPPLES;
      cursor.index += 1;
      ripples[slot * 3] = x;
      ripples[slot * 3 + 1] = y;
      ripples[slot * 3 + 2] = lastSpawn = now();
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    const io = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
    });
    io.observe(box);

    const stop = subscribeToTicker(() => {
      const t = now();
      // Idle: the picture itself shows, nothing is drawn.
      if (!scene || t - lastSpawn > RIPPLE_LIFE || intensity.get() < 0.001) {
        show(false);
        return;
      }
      const pic = picture();
      if (!pic) return;
      const { gl, texture, uniforms } = scene;
      const width = box.offsetWidth;
      const height = box.offsetHeight;
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      const w = Math.round(width * dpr);
      const h = Math.round(height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (live || pic !== uploaded) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pic);
        uploaded = pic;
      }
      const [mw, mh] = mediaSize(pic);
      gl.uniform1i(uniforms.texture, 0);
      gl.uniform2f(uniforms.media, mw, mh);
      gl.uniform2f(uniforms.resolution, width, height);
      gl.uniform1f(uniforms.time, t);
      gl.uniform1f(uniforms.intensity, intensity.get());
      gl.uniform3fv(uniforms.ripples, ripples);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      show(true);
    }, () => 0);

    return () => {
      show(false);
      stop();
      io.disconnect();
      window.removeEventListener("pointermove", onMove);
      stopAlive();
    };
  }, [motionOff, source, live, intensity, intensityApi]);

  if (motionOff) return null;
  return <div ref={hostRef} aria-hidden className="pointer-events-none absolute inset-0 opacity-0" />;
}
