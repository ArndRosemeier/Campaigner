export interface RoomMarkerConfig {
  letter: string;
  hue: number;
  colorName: string;
  label: string;
}

/** Canonical 10-hue palette optimized for AI image models and procedural detection. */
export const CANONICAL_ROOM_MARKERS: readonly RoomMarkerConfig[] = [
  { letter: 'A', hue: 300, colorName: 'magenta', label: 'Room A (Magenta disc, plaque A)' },
  { letter: 'B', hue: 180, colorName: 'cyan', label: 'Room B (Cyan disc, plaque B)' },
  { letter: 'C', hue: 60, colorName: 'yellow', label: 'Room C (Yellow disc, plaque C)' },
  { letter: 'D', hue: 120, colorName: 'green', label: 'Room D (Green disc, plaque D)' },
  { letter: 'E', hue: 225, colorName: 'blue', label: 'Room E (Electric-blue disc, plaque E)' },
  { letter: 'F', hue: 30, colorName: 'orange', label: 'Room F (Neon-orange disc, plaque F)' },
  { letter: 'G', hue: 270, colorName: 'purple', label: 'Room G (Neon-purple disc, plaque G)' },
  { letter: 'H', hue: 350, colorName: 'rose', label: 'Room H (Neon-rose disc, plaque H)' },
  { letter: 'I', hue: 90, colorName: 'lime', label: 'Room I (Neon-lime disc, plaque I)' },
  { letter: 'J', hue: 205, colorName: 'teal', label: 'Room J (Neon-teal disc, plaque J)' },
];

export interface RgbImageLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface MarkerTarget {
  id: string;
  letter: string;
  hue: number;
  name?: string;
}

export interface DetectedMarker {
  id: string;
  letter: string;
  expectedHue: number;
  observedHue: number;
  hueDistance: number;
  circularity: number;
  areaPixels: number;
  /** Normalized coordinate [0, 1] across map width. */
  x: number;
  /** Normalized coordinate [0, 1] across map height. */
  y: number;
}

export interface DetectedCandidateBlob {
  x: number;
  y: number;
  hue: number;
  circularity: number;
  area: number;
}

export interface NeonDetectionResult {
  detected: DetectedMarker[];
  missingRoomIds: string[];
  allBlobs: DetectedCandidateBlob[];
}

export async function extractImageData(
  blob: Blob,
  canvasFactory: () => HTMLCanvasElement = () => document.createElement('canvas'),
): Promise<RgbImageLike | null> {
  try {
    if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') return null;
    const bitmap = await createImageBitmap(blob);
    const canvas = canvasFactory();
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return {
      width: canvas.width,
      height: canvas.height,
      data: imgData.data,
    };
  } catch {
    return null;
  }
}

export interface NeonDetectorOptions {
  /** Saturation threshold [0, 1]. Default 0.70. */
  minSaturation?: number;
  /** Value/brightness threshold [0, 1]. Default 0.70. */
  minValue?: number;
  /** Minimum pixel count for a marker blob. Default 30. */
  minAreaPixels?: number;
  /** Maximum fraction of total image area. Default 0.08 (8%). */
  maxAreaFraction?: number;
  /** Minimum circularity 4*pi*A / P^2. Default 0.40. */
  minCircularity?: number;
  /** Maximum circular hue distance in degrees. Default 40. */
  maxHueDistance?: number;
}

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const delta = max - min;

  let h = 0;
  if (delta > 0) {
    if (max === rNorm) {
      h = 60 * (((gNorm - bNorm) / delta) % 6);
    } else if (max === gNorm) {
      h = 60 * ((bNorm - rNorm) / delta + 2);
    } else {
      h = 60 * ((rNorm - gNorm) / delta + 4);
    }
  }
  if (h < 0) h += 360;

  const s = max === 0 ? 0 : delta / max;
  const v = max;

  return { h, s, v };
}

export function circularHueDistance(h1: number, h2: number): number {
  const diff = Math.abs(h1 - h2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

interface RawBlob {
  area: number;
  cx: number;
  cy: number;
  meanHue: number;
  circularity: number;
}

/**
 * Procedural neon-assign detector from the research paper.
 * 1. Filter HSV pixels (saturation and brightness).
 * 2. Connected-component labeling on candidate pixels.
 * 3. Filter blobs by size and circularity.
 * 4. Greedily assign surviving blobs to expected sidecar hues.
 */
export function detectNeonMarkers(
  image: RgbImageLike,
  targets: readonly MarkerTarget[],
  options: NeonDetectorOptions = {},
): NeonDetectionResult {
  const {
    minSaturation = 0.70,
    minValue = 0.70,
    minAreaPixels = 30,
    maxAreaFraction = 0.08,
    minCircularity = 0.40,
    maxHueDistance = 40,
  } = options;

  const { width, height, data } = image;
  const totalPixels = width * height;
  const maxAreaPixels = totalPixels * maxAreaFraction;

  // 1. Create binary mask of neon candidate pixels and record their hues
  const mask = new Uint8Array(totalPixels);
  const hues = new Float32Array(totalPixels);

  for (let index = 0; index < totalPixels; index += 1) {
    const offset = index * 4;
    const r = data[offset] ?? 0;
    const g = data[offset + 1] ?? 0;
    const b = data[offset + 2] ?? 0;

    const { h, s, v } = rgbToHsv(r, g, b);
    if (s >= minSaturation && v >= minValue) {
      mask[index] = 1;
      hues[index] = h;
    }
  }

  // 2. Connected-component extraction using BFS queue
  const visited = new Uint8Array(totalPixels);
  const rawBlobs: RawBlob[] = [];
  const queueX = new Int32Array(totalPixels);
  const queueY = new Int32Array(totalPixels);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const startIndex = y * width + x;
      if (mask[startIndex] === 0 || visited[startIndex] === 1) {
        continue;
      }

      visited[startIndex] = 1;
      let head = 0;
      let tail = 0;
      queueX[tail] = x;
      queueY[tail] = y;
      tail += 1;

      let sumX = 0;
      let sumY = 0;
      let sumSin = 0;
      let sumCos = 0;
      let boundaryCount = 0;

      while (head < tail) {
        const curX = queueX[head] ?? 0;
        const curY = queueY[head] ?? 0;
        head += 1;

        const curIndex = curY * width + curX;
        sumX += curX;
        sumY += curY;

        const hDeg = hues[curIndex] ?? 0;
        const hRad = (hDeg * Math.PI) / 180;
        sumSin += Math.sin(hRad);
        sumCos += Math.cos(hRad);

        // Check 4-connected neighbors for boundary
        let isBoundary = false;
        const neighbors = [
          [curX + 1, curY],
          [curX - 1, curY],
          [curX, curY + 1],
          [curX, curY - 1],
        ] as const;

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            isBoundary = true;
            continue;
          }
          const nIndex = ny * width + nx;
          if (mask[nIndex] === 0) {
            isBoundary = true;
          } else if (visited[nIndex] === 0) {
            visited[nIndex] = 1;
            queueX[tail] = nx;
            queueY[tail] = ny;
            tail += 1;
          }
        }

        if (isBoundary) {
          boundaryCount += 1;
        }
      }

      const area = tail;
      if (area < minAreaPixels || area > maxAreaPixels) {
        continue;
      }

      // Circularity: 4 * PI * Area / (Perimeter^2)
      const perimeter = Math.max(boundaryCount, 1);
      const circularity = (4 * Math.PI * area) / (perimeter * perimeter);

      let meanHue = (Math.atan2(sumSin, sumCos) * 180) / Math.PI;
      if (meanHue < 0) meanHue += 360;

      rawBlobs.push({
        area,
        cx: sumX / area,
        cy: sumY / area,
        meanHue,
        circularity,
      });
    }
  }

  // 3. Filter candidate blobs by circularity
  const candidateBlobs = rawBlobs.filter((blob) => blob.circularity >= minCircularity);

  const allBlobs: DetectedCandidateBlob[] = candidateBlobs.map((blob) => ({
    x: (blob.cx + 0.5) / width,
    y: (blob.cy + 0.5) / height,
    hue: blob.meanHue,
    circularity: blob.circularity,
    area: blob.area,
  }));

  // 4. Greedy circular hue assignment to unused sidecar targets
  interface PairDistance {
    blobIndex: number;
    targetIndex: number;
    distance: number;
  }

  const pairs: PairDistance[] = [];
  for (let bIndex = 0; bIndex < candidateBlobs.length; bIndex += 1) {
    const blob = candidateBlobs[bIndex];
    if (blob === undefined) continue;
    for (let tIndex = 0; tIndex < targets.length; tIndex += 1) {
      const target = targets[tIndex];
      if (target === undefined) continue;
      const distance = circularHueDistance(blob.meanHue, target.hue);
      if (distance <= maxHueDistance) {
        pairs.push({ blobIndex: bIndex, targetIndex: tIndex, distance });
      }
    }
  }

  // Sort ascending by distance
  pairs.sort((a, b) => a.distance - b.distance);

  const assignedBlobs = new Set<number>();
  const assignedTargets = new Set<number>();
  const detected: DetectedMarker[] = [];

  for (const pair of pairs) {
    if (assignedBlobs.has(pair.blobIndex) || assignedTargets.has(pair.targetIndex)) {
      continue;
    }
    const blob = candidateBlobs[pair.blobIndex];
    const target = targets[pair.targetIndex];
    if (blob === undefined || target === undefined) continue;

    assignedBlobs.add(pair.blobIndex);
    assignedTargets.add(pair.targetIndex);

    detected.push({
      id: target.id,
      letter: target.letter,
      expectedHue: target.hue,
      observedHue: blob.meanHue,
      hueDistance: pair.distance,
      circularity: blob.circularity,
      areaPixels: blob.area,
      x: (blob.cx + 0.5) / width,
      y: (blob.cy + 0.5) / height,
    });
  }

  const missingRoomIds = targets
    .filter((_, index) => !assignedTargets.has(index))
    .map((target) => target.id);

  return {
    detected,
    missingRoomIds,
    allBlobs,
  };
}
