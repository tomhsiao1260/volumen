/**
 * @file A cell: eight corners in the scroll, and the scan seen through them.
 *
 * A cell is the smallest march there is.  The march a flattened card draws from is a table of scan
 * positions — nodes across and down a grid, and layers through the stack — and the shader reads it
 * with the texture unit's own trilinear interpolation, so that a pixel between four nodes is a
 * position between their four positions.  A table of two by two by two is therefore a hexahedron:
 * its eight entries are the corners, and every point inside is the trilinear blend of them.  That
 * is what a cell is, and why it costs no shader of its own: the card that lays a sheet flat
 * (`surface.ts`) lays a cell flat the same way, and the pages it needs come through the same pager.
 *
 * What a cell adds is the other way of seeing it — as a box in a three-dimensional scene, its faces
 * showing the scan where they cut it (`mesh`).  A board of such cells, their corners dragged until a
 * sheet of papyrus lies flat inside them, merged into one another by sharing corners, is a
 * flattening made by hand; the table of a merged board is simply a larger table.
 *
 * Corners are numbered by their place in the unit cube: bit 0 is u (x of the table), bit 1 is v,
 * bit 2 is w — `corners[u + 2v + 4w]` — so corner 0 is (0, 0, 0) and corner 7 is (1, 1, 1).  Each is a
 * position in full-resolution voxels, (x, y, z).
 */
import * as THREE from "three/webgpu";
import { Fn, If, float, mix, positionLocal, positionWorld, uint, uniform, vec3, vec4 } from "three/tsl";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { CardView } from "#src/gpu/card.js";
import type { Device } from "#src/gpu/device.js";
import { Field } from "#src/gpu/field.js";
import type { Said } from "#src/gpu/field.js";
import { pagesUnder } from "#src/gpu/pages.js";
import type { Order } from "#src/gpu/pages.js";
import type { scanOf } from "#src/gpu/sample.js";
import type { Scan } from "#src/gpu/scan.js";
import { surfaceOf } from "#src/gpu/surface.js";
import { Wanting } from "#src/gpu/wanting.js";
import type { Wanted } from "#src/gpu/wanting.js";
import type { RenderLayer } from "#src/render/layer.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { WatchableValue } from "#src/state/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

/*
 * What a TSL node looks like to TypeScript.  `@types/three` does not describe node arguments in a
 * way that survives being passed between `Fn`s, so it is named once here rather than cast about.
 */
type Num = any;

export interface Point {
  x: number;
  y: number;
  z: number;
}

/** The eight corners of a cell, numbered `u + 2v + 4w`. */
export type Corners = [Point, Point, Point, Point, Point, Point, Point, Point];

/*
 * How many scales a cell asks chunks for: the finest and the next two.  Which is drawn is the
 * finest resident, so the coarser ones are what a cell shows while the finest is on its way — and
 * for a cell far from the camera, all it needs.
 */
const SCALES_WANTED = 3;
// How finely the box is divided for its faces to follow the trilinear map, segments along each edge.
const SEGMENTS = 6;

export class Cell extends RefCounted {
  /** The table: two by two by two, the corners themselves. */
  private readonly field: Field;
  private readonly wanting: Wanting;
  private corners: Corners;
  // The corner positions as the box's shader has them, (x, y, z).
  private readonly cornerUniforms = Array.from({ length: 8 }, () => uniform(new THREE.Vector3()));
  /**
   * A material that draws the scan on a unit box's surface, the box being pulled into this cell's
   * shape in its vertex program.  Put it on `mesh`, or on a box of your own with its positions in
   * [-0.5, 0.5]³.
   */
  readonly material: THREE.MeshBasicNodeMaterial;
  /** The cell as a mesh for a scene whose coordinates are the scan's voxels: add it to one. */
  readonly mesh: THREE.Mesh;

  constructor(
    private readonly device: Device,
    private readonly chunkManager: ChunkManager,
    private readonly layer: WatchableValueInterface<RenderLayer | undefined>,
    private readonly shader: ReturnType<typeof scanOf>,
    private readonly scan: Scan,
    corners: Corners,
  ) {
    super();
    this.corners = corners;
    this.field = this.registerDisposer(new Field(device));
    // Visible for the asking: a cell is wherever its mesh or its cards are; it asks as if on screen.
    this.wanting = this.registerDisposer(
      new Wanting(chunkManager, layer, new WatchableValue(Number.POSITIVE_INFINITY)),
    );
    this.registerDisposer(() => scan.forget(this));

    this.material = this.makeMaterial();
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, SEGMENTS, SEGMENTS, SEGMENTS), this.material);
    // The box is sized in its shader; three.js's own culling would judge the unit box instead.
    this.mesh.frustumCulled = false;
    this.registerDisposer(() => {
      this.mesh.geometry.dispose();
      this.material.dispose();
    });
    this.setCorners(corners);
  }

  /** Where the cell's corners are. */
  get where(): Corners {
    return this.corners;
  }

  /**
   * Moves the corners.  The table is written anew, the box's shader is told, and the pages and
   * chunks the new shape covers are asked for — all at once, so that a corner being dragged is drawn
   * where the hand is on the next frame.
   */
  setCorners(corners: Corners) {
    this.corners = corners;
    corners.forEach((c, i) => this.cornerUniforms[i].value.set(c.x, c.y, c.z));
    this.field.take(this.said(), { now: true });
    this.ask();
    this.device.redraw();
  }

  /** The table a cell is: its corners in (z, y, x), one layer per w, every one reached. */
  private said(): Said {
    const data = new Float32Array(8 * 4);
    this.corners.forEach((c, i) => {
      data[i * 4] = c.z;
      data[i * 4 + 1] = c.y;
      data[i * 4 + 2] = c.x;
      data[i * 4 + 3] = 1;
    });
    // Through the cell, w runs -0.5 to 0.5, and a distance through it is w times its thickness.
    const thick = this.thickness();
    return {
      nu: 2,
      nv: 2,
      layers: 2,
      per: 1,
      K: 0.5,
      lattice: [0, 0],
      data,
      walk: new Float32Array([-0.5, 0.5]),
      lo: -thick / 2,
      hi: thick / 2,
    };
  }

  // The mean length of the four edges along w, in voxels.
  private thickness() {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const a = this.corners[i], b = this.corners[i + 4];
      sum += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    return Math.max(1e-6, sum / 4);
  }

  /** The box of the scroll the corners bound, in full-resolution voxels. */
  bounds(): { lower: [number, number, number]; upper: [number, number, number] } {
    const lower: [number, number, number] = [Infinity, Infinity, Infinity];
    const upper: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const c of this.corners) {
      lower[0] = Math.min(lower[0], c.x);
      lower[1] = Math.min(lower[1], c.y);
      lower[2] = Math.min(lower[2], c.z);
      upper[0] = Math.max(upper[0], c.x);
      upper[1] = Math.max(upper[1], c.y);
      upper[2] = Math.max(upper[2], c.z);
    }
    return { lower, upper };
  }

  /**
   * Asks for everything under the cell's box: the chunks, from the queue, at the finest scales; and
   * the pages, from the pager, so that they go up as the chunks arrive rather than a frame after the
   * shader finds them missing.
   */
  private ask() {
    const { lower, upper } = this.bounds();
    const levels = this.scan.scales.slice(0, SCALES_WANTED);
    const wanted: Wanted[] = [];
    const orders = new Map<number, Order>();
    for (const scale of levels) {
      const size = this.scan.chunkSizeOf(scale.level);
      const chunks: number[] = [];
      const lo = [0, 1, 2].map((i) => Math.max(0, Math.floor(((lower[i] + 0.5) / scale.factor - 0.5) / size[i])));
      const hi = [0, 1, 2].map((i) =>
        Math.min(
          Math.ceil(scale.upper[i] / size[i]) - 1,
          Math.floor(((upper[i] + 0.5) / scale.factor - 0.5) / size[i]),
        ),
      );
      for (let z = lo[2]; z <= hi[2]; z++)
        for (let y = lo[1]; y <= hi[1]; y++)
          for (let x = lo[0]; x <= hi[0]; x++) chunks.push(x, y, z);
      wanted.push({ level: scale.level, factor: scale.factor, chunks: new Float32Array(chunks) });
      orders.set(scale.level, { cut: pagesUnder(lower, upper, scale), near: [] });
    }
    this.wanting.want(wanted);
    this.scan.order(this, orders);
  }

  /** Whether every chunk of the finest scale under the cell has arrived. */
  isReady() {
    return this.wanting.settled();
  }

  /**
   * A card showing the cell laid flat: the layer `w` through it, -0.5 at the first four corners,
   * 0.5 at the last four, 0 midway — u across the card, v down it.  Change `w` with `show`.
   */
  flat(element: HTMLElement, w = 0) {
    const view = surfaceOf(this.device, this.shader, this.scan.source, this.scan.scales, this.field);
    const card = new CardView(element, this.device, {
      material: view.material,
      asks: true,
      before: (width, height) => view.before?.(width, height),
      dispose: () => view.dispose?.(),
    });
    const show = (w: number) => {
      view.show({ at: [0, 0, w], right: [1, 0, 0], down: [0, 1, 0] });
      card.changed();
    };
    show(w);
    // The card is the caller's to dispose; one still there when the cell goes, goes with it.
    this.cards.add(card);
    card.registerDisposer(() => this.cards.delete(card));
    return Object.assign(card, { show });
  }

  // The flat cards made of this cell that are still there.
  private readonly cards = new Set<CardView>();

  disposed() {
    for (const card of this.cards) card.dispose();
    this.cards.clear();
    super.disposed();
  }

  /**
   * The box's material: a unit box pulled into the cell's shape, its surface showing the scan.
   *
   * The vertex program blends the eight corners by the vertex's place in the unit box — the same
   * trilinear the texture unit does for the table, written out — so the box's faces are the cell's
   * faces, bowed as the corners make them.  The fragment then reads the scan at the position it
   * landed on, finest resident scale first, as every card does.
   */
  private makeMaterial() {
    const material = new THREE.MeshBasicNodeMaterial();
    material.side = THREE.DoubleSide;
    const c = this.cornerUniforms;
    material.positionNode = Fn(() => {
      const t = positionLocal.add(0.5);
      const u = t.x, v = t.y, w = t.z;
      const lerp = (a: Num, b: Num, s: Num) => mix(a, b, s);
      const back = lerp(lerp(c[0], c[1], u), lerp(c[2], c[3], u), v);
      const front = lerp(lerp(c[4], c[5], u), lerp(c[6], c[7], u), v);
      return lerp(back, front, w);
    })();
    const { shader, scan } = this;
    material.colorNode = Fn(() => {
      const voxel = positionWorld.toVar();
      const grey = float(0.5).toVar();
      const found = float(0).toVar();
      for (const scale of scan.scales) {
        If(found.equal(0), () => {
          const got = shader.at(
            uint(scan.source),
            uint(scale.level),
            float(scale.factor),
            vec3(...scale.upper),
            voxel,
          );
          If(got.y.greaterThan(0), () => {
            grey.assign(got.x);
            found.assign(1);
          });
        });
      }
      return vec4(grey, grey, grey, float(1));
    })();
    return material;
  }
}
