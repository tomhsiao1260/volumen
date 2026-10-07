/**
 * The march, as a compute shader.
 *
 * A line-for-line port of `walk` and `hold` in `patch.ts`, and of `LasagnaField.normal` in
 * `field.ts`.  It is a port rather than a rewrite on purpose: the two are held against each other
 * node by node (`scratchpad/pup/march.cjs`), and a difference in the arithmetic would be a
 * difference in where the papyrus is said to be, which nothing downstream could tell from a real
 * one.  So where the shape below is awkward, it is awkward in the same way the original is.
 *
 * The one thing that is not a port is the precision.  The CPU marches in `Float64Array`; this marches
 * in `f32`, because WGSL has no doubles.  Over the 240 steps of one direction the drift of a
 * two-and-a-half voxel step is a hundredth of a voxel against a sheet spacing of forty, and the
 * march is stored as `Float32Array` either way.
 */
export const MARCH_WGSL = /* wgsl */ `
struct Say {
  // Which way along the normal, and how far one step is.
  dir: f32,
  ds: f32,
  // Which sample out from the middle this is, for the layer the answer is stored in.
  k: i32,
  // The grid.
  nu: i32,
  nv: i32,
  count: i32,
  // Samples each way, so that the middle layer can be found.
  reach: i32,
  // And the normal field: how many full-resolution voxels one of its voxels covers, where its box
  // starts, and how big it is — all counted (z, y, x), as the scan is stored.
  factor: f32,
  origin: vec3<f32>,
  dims: vec3<i32>,
}

// How much of the way each node is moved towards the middle of its neighbours (HOLD in patch.ts).
const HOLD: f32 = 0.25;

@group(0) @binding(0) var<uniform> U: Say;
@group(0) @binding(1) var field: texture_3d<u32>;
// The march's place and the direction it came in on, one per node.  The place ping-pongs with
// \`nxt\` so that the smoothing pass reads a whole grid that nothing is writing to.
@group(0) @binding(2) var<storage, read_write> cur: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> nxt: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> came: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> alive: array<u32>;
// The answer: the place of every node on every sample, and whether it reached.
@group(0) @binding(6) var<storage, read_write> outP: array<f32>;
@group(0) @binding(7) var<storage, read_write> outA: array<f32>;

/*
 * Which way is across the sheets at a place, with its sign turned to agree with \`r\`.
 *
 * Eight corners, each flipped to agree before averaging — which is the same as averaging n·nᵀ while
 * neighbours are within 90° of each other, and much cheaper.  A corner the network had nothing to
 * say at is skipped and does not count towards the weight, so a place with too little around it
 * answers that there is nothing there rather than answering from one corner.
 */
fn normalAt(p: vec3<f32>, r: vec3<f32>, out: ptr<function, vec3<f32>>) -> bool {
  let l = (p + vec3<f32>(0.5)) / U.factor - vec3<f32>(0.5) - U.origin;
  let base = floor(l);
  let z0 = i32(base.x);
  let y0 = i32(base.y);
  let x0 = i32(base.z);
  if (z0 < 0 || y0 < 0 || x0 < 0 ||
      z0 + 1 >= U.dims.x || y0 + 1 >= U.dims.y || x0 + 1 >= U.dims.z) {
    return false;
  }
  let t = l - base;
  var sum = vec3<f32>(0.0);
  var ws = 0.0;
  for (var c: u32 = 0u; c < 8u; c = c + 1u) {
    let cz = i32(c >> 2u);
    let cy = i32((c >> 1u) & 1u);
    let cx = i32(c & 1u);
    let w = select(1.0 - t.x, t.x, cz == 1) *
            select(1.0 - t.y, t.y, cy == 1) *
            select(1.0 - t.z, t.z, cx == 1);
    if (w == 0.0) { continue; }
    let texel = textureLoad(field, vec3<i32>(x0 + cx, y0 + cy, z0 + cz), 0);
    // Zero alpha is zero \`grad_mag\`: the network had nothing to say here.
    if (texel.w == 0u) { continue; }
    let vx = (f32(texel.x) - 128.0) / 127.0;
    let vy = (f32(texel.y) - 128.0) / 127.0;
    let vz = sqrt(max(0.0, 1.0 - vx * vx - vy * vy));
    let v = vec3<f32>(vz, vy, vx);
    let s = select(w, -w, dot(v, r) < 0.0);
    sum = sum + s * v;
    ws = ws + w;
  }
  let len = length(sum);
  if (ws < 0.25 || len < 1e-6) { return false; }
  *out = sum / len;
  return true;
}

// One sample of the march: the midpoint rule along the normal, in place.
@compute @workgroup_size(64)
fn onward(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = i32(gid.x);
  if (k >= U.count || alive[k] == 0u) { return; }
  let here = cur[k].xyz;
  let was = came[k].xyz;
  var n: vec3<f32>;
  if (!normalAt(here, was, &n)) {
    alive[k] = 0u;
    return;
  }
  // Taken at the middle of the step, so that a normal that turns does not walk the march off the
  // sheet — the same reason a curve is integrated by its midpoint and not by its start.
  var mid: vec3<f32>;
  let midway = here + n * (U.dir * U.ds * 0.5);
  if (!normalAt(midway, n, &mid)) { mid = n; }
  cur[k] = vec4<f32>(here + mid * (U.dir * U.ds), 0.0);
  came[k] = vec4<f32>(mid, 0.0);
}

/*
 * Each node a quarter of the way towards the middle of its neighbours, so that the grid stays a
 * sheet as it marches — and the edge of it stays where it is.
 *
 * A node on the edge has a neighbour missing, and dropping it leaves the average of the rest sitting
 * inside the piece, so every pass pulls the edge in a little.  So the missing neighbour is REFLECTED
 * instead: taken as the node's own place carried the same distance the other way.
 */
@compute @workgroup_size(64)
fn hold(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = i32(gid.x);
  if (k >= U.count) { return; }
  let was = cur[k].xyz;
  if (alive[k] == 0u) {
    nxt[k] = vec4<f32>(was, 0.0);
    return;
  }
  let i = k / U.nu;
  let j = k % U.nu;
  var sum = vec3<f32>(0.0);
  var n = 0.0;
  for (var d: i32 = 0; d < 4; d = d + 1) {
    var di = 0;
    var dj = 0;
    if (d == 0) { dj = 1; } else if (d == 1) { dj = -1; } else if (d == 2) { di = 1; } else { di = -1; }
    let y = i + di;
    let x = j + dj;
    var o = -1;
    if (y >= 0 && x >= 0 && y < U.nv && x < U.nu) { o = y * U.nu + x; }
    if (o >= 0 && alive[o] == 0u) { o = -1; }
    if (o >= 0) {
      sum = sum + cur[o].xyz;
      n = n + 1.0;
      continue;
    }
    // Nothing that way: the node's place carried the same distance back the other way, if there is
    // anything there to carry.
    let by = i - di;
    let bx = j - dj;
    if (by < 0 || bx < 0 || by >= U.nv || bx >= U.nu) { continue; }
    let b = by * U.nu + bx;
    if (alive[b] == 0u) { continue; }
    sum = sum + 2.0 * was - cur[b].xyz;
    n = n + 1.0;
  }
  if (n == 0.0) {
    nxt[k] = vec4<f32>(was, 0.0);
    return;
  }
  nxt[k] = vec4<f32>(was + HOLD * (sum / n - was), 0.0);
}

// Where the march has got to after a whole sample, written into the layer for it.
@compute @workgroup_size(64)
fn store(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = i32(gid.x);
  if (k >= U.count) { return; }
  let layer = (U.reach + i32(U.dir) * U.k) * U.count + k;
  if (alive[k] == 0u) {
    // Nowhere.  The march on the other thread says that with NaN, and WGSL will not make one at all
    // — not even by its bits — so the weight alone says it here and the NaN is put in on readback.
    outA[layer] = 0.0;
    return;
  }
  let at = cur[k].xyz;
  outP[layer * 3 + 0] = at.x;
  outP[layer * 3 + 1] = at.y;
  outP[layer * 3 + 2] = at.z;
  outA[layer] = 1.0;
}
`;
