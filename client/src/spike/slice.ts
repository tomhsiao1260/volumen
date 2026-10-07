/**
 * @file Stage 1c asked of the real thing: a cross-section drawn through a card, pixel by pixel
 * against the answer worked out here.
 *
 * The volume is `(x + y) · 0.8`, which is linear — so trilinear interpolation of it is exact, and
 * every pixel has one right answer rather than an approximately right one.  That is the only way to
 * tell "the geometry is right" from "the geometry is nearly right", and nearly right is how a view
 * draws the wrong part of a scroll.
 */
import { Atlas, PAGE } from "../../../viewer/src/gpu/atlas";
import { CardView } from "../../../viewer/src/gpu/card";
import { Device } from "../../../viewer/src/gpu/device";
import { scanOf } from "../../../viewer/src/gpu/sample";
import { sliceOf } from "../../../viewer/src/gpu/slice";

type Say = (name: string, ok: boolean, detail: string) => void;

const SIDE = 64;
// Two pages each way, so the card crosses page boundaries in both directions it is drawn along.
const PAGES = 2;
const SPAN = PAGE * PAGES;
const shade = (x: number, y: number) => Math.round((x + y) * 0.8);

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** The stored volume read the way a texture unit reads it: bilinear, since it is flat in z. */
function between(x: number, y: number) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const of = (a: number, b: number) =>
    shade(Math.min(SPAN - 1, Math.max(0, a)), Math.min(SPAN - 1, Math.max(0, b)));
  return (
    of(x0, y0) * (1 - tx) * (1 - ty) +
    of(x0 + 1, y0) * tx * (1 - ty) +
    of(x0, y0 + 1) * (1 - tx) * ty +
    of(x0 + 1, y0 + 1) * tx * ty
  );
}

export async function checkSlice(say: Say) {
  const device = await Device.start();
  if (device === undefined) {
    say("11 · a cross-section through a card", false, "Device.start() answered undefined");
    return;
  }
  const where = document.createElement("div");
  // No border: a card is measured by `offsetWidth`, so a border would make it cover more scroll
  // than this check thinks it does — which is how the page-key wrap in `sample.ts` was found.
  where.style.cssText = `position:relative;width:${SIDE}px;height:${SIDE}px;display:inline-block;outline:1px solid #333;margin-right:6px`;
  document.getElementById("shots")!.append(where);

  try {
    const atlas = new Atlas(device, PAGE * PAGES);
    const scan = scanOf(atlas);
    const view = sliceOf(scan, 0, [{ level: 0, factor: 1 }]);
    const card = new CardView(where, device, view);
    // Looking down z, the card's own axes along x and y, two voxels to a pixel.
    view.show({ at: [SPAN / 2, SPAN / 2, SPAN / 2], right: [1, 0, 0], down: [0, 1, 0], zoom: PAGES });

    // One frame first, so three.js has made the atlas texture; nothing can be written before that.
    device.resized();
    await frame();
    await frame();

    let wrote = true;
    const page = new Uint8Array(PAGE ** 3);
    for (let pz = 0; pz < PAGES; pz++)
      for (let py = 0; py < PAGES; py++)
        for (let px = 0; px < PAGES; px++) {
          for (let z = 0; z < PAGE; z++)
            for (let y = 0; y < PAGE; y++)
              for (let x = 0; x < PAGE; x++)
                page[(z * PAGE + y) * PAGE + x] = shade(px * PAGE + x, py * PAGE + y);
          wrote = atlas.put({ source: 0, level: 0, at: [px, py, pz] }, page) && wrote;
        }
    card.changed();
    await frame();
    await frame();

    const canvas = where.querySelector("canvas") as HTMLCanvasElement;
    const got = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    const wide = canvas.width, tall = canvas.height;

    /*
     * Every pixel against what the volume says at the place that pixel is — worked out from the
     * size the card was actually drawn at, since a card is drawn with more pixels than it is laid
     * out with.  A pixel outside the volume is the renderer's "nothing here" grey.
     */
    const zoom = PAGES;
    // Told apart, because a pixel on the papyrus and a pixel past the end of it are two different
    // claims: one is "the scan says this", the other is "there is nothing here".
    let worst = 0, off = 0, where0 = "", seen = 0;
    let edge = 0, outside = 0;
    for (let py = 0; py < tall; py++)
      for (let px = 0; px < wide; px++) {
        const x = SPAN / 2 + (px + 0.5 - wide / 2) * zoom;
        const y = SPAN / 2 + (py + 0.5 - tall / 2) * zoom;
        const had = got[(py * wide + px) * 4];
        if (x < 0 || y < 0 || x > SPAN - 1 || y > SPAN - 1) {
          outside = Math.max(outside, Math.abs(had - 127.5));
          continue;
        }
        seen++;
        /*
         * Against the array that was actually stored, interpolated the way the texture unit does —
         * not against the continuous function it came from.  The volume really is eight-bit, so
         * comparing with the function would charge the renderer for a rounding it did not do.
         */
        const want = between(x, y);
        const apart = Math.abs(had - want);
        // A page's own edge is where the filter is held inside it, worth half a voxel.
        const atEdge = [x, y].some((v) => v % PAGE < 1 || v % PAGE > PAGE - 1);
        if (atEdge) edge = Math.max(edge, apart);
        else if (apart > worst) {
          worst = apart;
          where0 = `at ${px},${py} (voxel ${x.toFixed(1)},${y.toFixed(1)}): ${had} against ${want.toFixed(1)}`;
        }
        if (!atEdge && apart > 1) off++;
      }
    say(
      "11 · a cross-section drawn through a card, pixel by pixel against the volume",
      wrote && off === 0,
      `${seen} pixels on the volume · worst ${worst.toFixed(1)} of 255, ${off} over 1 · ` +
        `at a page's edge ${edge.toFixed(1)} · past the volume ${outside.toFixed(1)} · ${where0}`,
    );
    card.dispose();
  } catch (error) {
    say("11 · a cross-section through a card", false, String(error));
  } finally {
    device.dispose();
  }
}
