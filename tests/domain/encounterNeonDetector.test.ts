import { describe, expect, it } from 'vitest';
import {
  CANONICAL_ROOM_MARKERS,
  circularHueDistance,
  detectNeonMarkers,
  entranceMarkerConfig,
  rgbToHsv,
  type RgbImageLike,
} from '@/domain/encounterMap/neonDetector';

describe('neonDetector', () => {
  describe('entranceMarkerConfig', () => {
    it('returns the palette entry one past the room count — never a room hue', () => {
      expect(entranceMarkerConfig(1)).toEqual(CANONICAL_ROOM_MARKERS[1]);
      expect(entranceMarkerConfig(1)?.hue).toBe(180);
      expect(entranceMarkerConfig(9)).toEqual(CANONICAL_ROOM_MARKERS[9]);
      expect(entranceMarkerConfig(9)?.hue).toBe(205);
    });

    it('returns null when all ten hues are taken (10-room layouts)', () => {
      expect(entranceMarkerConfig(10)).toBeNull();
      expect(entranceMarkerConfig(11)).toBeNull();
    });
  });

  describe('rgbToHsv', () => {
    it('computes accurate HSV for pure colors', () => {
      expect(rgbToHsv(255, 0, 0)).toEqual({ h: 0, s: 1, v: 1 });
      expect(rgbToHsv(0, 255, 0)).toEqual({ h: 120, s: 1, v: 1 });
      expect(rgbToHsv(0, 0, 255)).toEqual({ h: 240, s: 1, v: 1 });
      expect(rgbToHsv(255, 0, 255)).toEqual({ h: 300, s: 1, v: 1 });
      expect(rgbToHsv(0, 255, 255)).toEqual({ h: 180, s: 1, v: 1 });
      expect(rgbToHsv(255, 255, 0)).toEqual({ h: 60, s: 1, v: 1 });
    });

    it('identifies stone as low saturation and dark water as low value', () => {
      const stone = rgbToHsv(110, 115, 120);
      expect(stone.s).toBeLessThan(0.15);

      const navyWater = rgbToHsv(10, 20, 50);
      expect(navyWater.v).toBeLessThan(0.3);
    });
  });

  describe('circularHueDistance', () => {
    it('handles angular distances and boundary wrapping across 0/360', () => {
      expect(circularHueDistance(10, 350)).toBe(20);
      expect(circularHueDistance(350, 10)).toBe(20);
      expect(circularHueDistance(300, 298)).toBe(2);
      expect(circularHueDistance(96, 118)).toBe(22);
      expect(circularHueDistance(0, 180)).toBe(180);
    });
  });

  function createTestCanvas(width: number, height: number): {
    image: RgbImageLike;
    drawDisc: (cx: number, cy: number, radius: number, r: number, g: number, b: number) => void;
    drawStreak: (x1: number, y: number, length: number, r: number, g: number, b: number) => void;
  } {
    const data = new Uint8ClampedArray(width * height * 4);
    // Fill with desaturated stone background (R=100, G=100, B=100)
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4] = 100;
      data[i * 4 + 1] = 100;
      data[i * 4 + 2] = 100;
      data[i * 4 + 3] = 255;
    }

    const drawDisc = (cx: number, cy: number, radius: number, r: number, g: number, b: number) => {
      for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y += 1) {
        for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x += 1) {
          const dx = x - cx;
          const dy = y - cy;
          if (dx * dx + dy * dy <= radius * radius) {
            const idx = (y * width + x) * 4;
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = 255;
          }
        }
      }
    };

    const drawStreak = (x1: number, y: number, length: number, r: number, g: number, b: number) => {
      for (let x = x1; x < x1 + length && x < width; x += 1) {
        const idx = (y * width + x) * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    };

    return {
      image: { width, height, data },
      drawDisc,
      drawStreak,
    };
  }

  describe('detectNeonMarkers', () => {
    it('detects 5-room canonical markers with high accuracy', () => {
      const { image, drawDisc } = createTestCanvas(200, 200);

      // Room A: Magenta (hue 300) -> RGB (255, 0, 255) at (50, 50)
      drawDisc(50, 50, 8, 255, 0, 255);
      // Room B: Cyan (hue 180) -> RGB (0, 255, 255) at (150, 50)
      drawDisc(150, 50, 8, 0, 255, 255);
      // Room C: Yellow (hue 60) -> RGB (255, 255, 0) at (50, 150)
      drawDisc(50, 150, 8, 255, 255, 0);
      // Room D: Green (hue 120) -> RGB (0, 255, 0) at (150, 150)
      drawDisc(150, 150, 8, 0, 255, 0);
      // Room E: Electric Blue (hue ~225) -> RGB (0, 128, 255) at (100, 100)
      drawDisc(100, 100, 8, 0, 128, 255);

      const targets = CANONICAL_ROOM_MARKERS.slice(0, 5).map((m) => ({
        id: `room-${m.letter}`,
        letter: m.letter,
        hue: m.hue,
      }));

      const result = detectNeonMarkers(image, targets);

      expect(result.missingRoomIds).toEqual([]);
      expect(result.detected.length).toBe(5);

      const roomA = result.detected.find((d) => d.letter === 'A');
      expect(roomA).toBeDefined();
      if (roomA === undefined) throw new Error('roomA missing');
      expect(Math.abs(roomA.x - 0.25)).toBeLessThan(0.02);
      expect(Math.abs(roomA.y - 0.25)).toBeLessThan(0.02);
      expect(roomA.observedHue).toBeCloseTo(300, 0);
      expect(roomA.circularity).toBeGreaterThan(0.6);

      const roomB = result.detected.find((d) => d.letter === 'B');
      expect(roomB).toBeDefined();
      if (roomB === undefined) throw new Error('roomB missing');
      expect(Math.abs(roomB.x - 0.75)).toBeLessThan(0.02);
      expect(Math.abs(roomB.y - 0.25)).toBeLessThan(0.02);
    });

    it('recovers drifted hues (e.g. lime drifted 22° toward green) via greedy assignment', () => {
      const { image, drawDisc } = createTestCanvas(200, 200);

      // Room D: Target is Lime 96° (or 90°), but rendered at hue 118° (RGB approx 100, 255, 0)
      drawDisc(80, 80, 8, 100, 255, 0);

      const targets = [{ id: 'room-d', letter: 'D', hue: 96 }];
      const result = detectNeonMarkers(image, targets);

      expect(result.missingRoomIds).toEqual([]);
      expect(result.detected.length).toBe(1);
      const marker = result.detected[0];
      expect(marker).toBeDefined();
      if (marker === undefined) throw new Error('marker missing');
      expect(marker.letter).toBe('D');
      expect(marker.hueDistance).toBeLessThan(25);
    });

    it('ignores noise: streaks, tiny specks, and dark water', () => {
      const { image, drawDisc, drawStreak } = createTestCanvas(200, 200);

      // True disc: Room A at (100, 100)
      drawDisc(100, 100, 8, 255, 0, 255);

      // Noise 1: Tiny speck (< 30px) in yellow at (20, 20)
      drawDisc(20, 20, 2, 255, 255, 0);

      // Noise 2: Long streak (low circularity) in cyan at y=40, length=40
      drawStreak(10, 40, 40, 0, 255, 255);

      const targets = [{ id: 'room-a', letter: 'A', hue: 300 }];
      const result = detectNeonMarkers(image, targets);

      expect(result.detected.length).toBe(1);
      expect(result.detected[0]?.letter).toBe('A');
      expect(result.missingRoomIds).toEqual([]);
    });

    it('reports missing room ids when a marker is not present', () => {
      const { image, drawDisc } = createTestCanvas(200, 200);

      // Only Room A is drawn
      drawDisc(100, 100, 8, 255, 0, 255);

      const targets = [
        { id: 'room-a', letter: 'A', hue: 300 },
        { id: 'room-b', letter: 'B', hue: 180 },
      ];
      const result = detectNeonMarkers(image, targets);

      expect(result.detected.length).toBe(1);
      expect(result.detected[0]?.id).toBe('room-a');
      expect(result.missingRoomIds).toEqual(['room-b']);
    });
  });
});
