/**
 * @file Stage 1b asked of the real thing: two pages written into one atlas, and read back through
 * the same hash the shader walks.
 *
 * If a page lands where the table says it did, a card can be drawn in one pass however many chunks
 * it touches — which is the whole reason for the atlas. Throwaway, like the rest of the spike.
 */
import * as THREE from "three/webgpu";
import { Fn, float, uint, uv, vec3, vec4 } from "three/tsl";
import { Atlas, PAGE } from "../../../viewer/src/gpu/atlas";
import { Device } from "../../../viewer/src/gpu/device";
import { scanOf } from "../../../viewer/src/gpu/sample";

type Say = (name: string, ok: boolean, detail: string) => void;

const SIDE = 64;

export async function checkAtlas(say: Say, card: (label: string) => HTMLCanvasElement) {
  const device = await Device.start();
  if (device === undefined) {
    say("10 · the atlas, end to end", false, "Device.start() answered undefined");
    return;
  }
  try {
    // Two pages across, so a page's own corner in the atlas is not always the origin.
    const atlas = new Atlas(device, PAGE * 2);
    const scan = scanOf(atlas);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const material = new THREE.MeshBasicNodeMaterial();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

    /*
     * Across two pages of the first scale: the left half is the page at (0,0,0) and the right half
     * the page at (1,0,0).  Green says the lookup found a page at all, which is the half of the
     * answer that a grey of zero cannot tell apart from black papyrus.
     */
    material.colorNode = Fn(() => {
      const voxel = vec3(uv().x.mul(PAGE * 2), float(PAGE / 2), float(PAGE / 2));
      const got = scan.at(uint(0), uint(0), float(1), voxel);
      return vec4(got.x, got.y, float(0), float(1));
    })();

    device.renderer.setSize(SIDE, SIDE, false);
    device.surface.width = device.surface.height = SIDE;

    const shot = (label: string) => {
      const canvas = card(label);
      device.renderer.render(scene, camera);
      const context = canvas.getContext("2d")!;
      context.clearRect(0, 0, SIDE, SIDE);
      context.drawImage(device.surface, 0, 0);
      return context.getImageData(0, 0, SIDE, SIDE).data;
    };
    const at = (px: Uint8ClampedArray, x: number) => {
      const o = ((SIDE >> 1) * SIDE + x) * 4;
      return { grey: px[o], found: px[o + 1] };
    };

    // One frame first: three.js makes the texture on the GPU when it is first used, and nothing can
    // be written into it before that.
    const before = shot("10 · atlas, empty");
    const emptyFound = at(before, 32).found;

    // A ramp along x in the first page, and a flat grey in the one beside it.
    const ramp = new Uint8Array(PAGE ** 3);
    for (let z = 0; z < PAGE; z++)
      for (let y = 0; y < PAGE; y++)
        for (let x = 0; x < PAGE; x++) ramp[(z * PAGE + y) * PAGE + x] = x * 4;
    const flat = new Uint8Array(PAGE ** 3).fill(200);

    const wrote =
      atlas.put({ source: 0, level: 0, at: [0, 0, 0] }, ramp) &&
      atlas.put({ source: 0, level: 0, at: [1, 0, 0] }, flat);
    scan.update();

    const after = shot("10 · atlas, two pages");
    const left = at(after, 8), middle = at(after, 40), right = at(after, 56);
    // A third page nobody wrote, to prove a miss is a miss rather than whatever was next door.
    material.colorNode = Fn(() => {
      const voxel = vec3(float(PAGE / 2), float(PAGE / 2), float(PAGE * 1.5));
      const got = scan.at(uint(0), uint(0), float(1), voxel);
      return vec4(got.x, got.y, float(0), float(1));
    })();
    material.needsUpdate = true;
    const miss = at(shot("10 · a page nobody wrote"), 32);

    const ok =
      wrote &&
      emptyFound === 0 &&
      left.found === 255 &&
      right.found === 255 &&
      left.grey < middle.grey &&
      Math.abs(right.grey - 200) < 6 &&
      miss.found === 0;
    say(
      "10 · the atlas: pages written, found by the hash, and misses answered as misses",
      ok,
      `put ${wrote} · empty found ${emptyFound} · ramp ${left.grey}→${middle.grey} ` +
        `· flat ${right.grey} (wanted 200) · unwritten page found ${miss.found} (wanted 0)`,
    );
    say(
      "10b · the atlas's room",
      true,
      `${atlas.room.used} of ${atlas.room.pages} pages used, table generation ${atlas.generation}`,
    );
  } catch (error) {
    say("10 · the atlas, end to end", false, String(error));
  } finally {
    device.dispose();
  }
}
