/**
 * @file The Lasagna prediction of a scan, which a surface card is built from (see
 * `server/src/utils/lasagna.ts`): a source for each of its channels, and the scroll's axis.
 */

import { SERVER_API_ENDPOINT } from "../config";

export type LasagnaChannel = "cos" | "grad_mag" | "nx" | "ny";

export interface Lasagna {
  // The source serving each channel's array, and the scan level the array is on.
  channels: Record<LasagnaChannel, { sourceId: string; level: number }>;
  // The scroll's axis in full-resolution voxels, or null where the bucket has none.
  umbilicus: { x: number; y: number; z: number }[] | null;
}

// Asked once per source and page: the answer only changes when the bucket does.
const asked = new Map<string, Promise<Lasagna | null>>();

export function getLasagna(sourceId: string): Promise<Lasagna | null> {
  let answer = asked.get(sourceId);
  if (answer === undefined) {
    answer = fetch(`${SERVER_API_ENDPOINT}/api/sources/${sourceId}/lasagna`).then(
      async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return ((await response.json()) as { lasagna: Lasagna | null }).lasagna;
      },
    );
    // A failure is not remembered, so that asking again tries again.
    answer.catch(() => asked.delete(sourceId));
    asked.set(sourceId, answer);
  }
  return answer;
}
