import { describe, it, expect } from 'vitest';
import { computeVideoStats, resolutionBucket } from '../src/engine/index.js';
import type { Video } from '../src/engine/index.js';

const v = (over: Partial<Video>): Video => ({
  path: 'p', dir: 'd', name: 'n.mkv', ext: 'mkv', sizeBytes: 1_000_000, mtime: '2024-01-01',
  mediaType: 'video', title: 'n', ...over,
});

describe('resolutionBucket', () => {
  it('buckets by height/width', () => {
    expect(resolutionBucket({ width: 3840, height: 2160 })).toBe('4K');
    expect(resolutionBucket({ width: 1920, height: 1080 })).toBe('1080p');
    expect(resolutionBucket({ width: 1280, height: 720 })).toBe('720p');
    expect(resolutionBucket({ width: 854, height: 480 })).toBe('480p');
    expect(resolutionBucket({ width: 640, height: 360 })).toBe('SD');
    expect(resolutionBucket({})).toBe('unknown');
  });
});

describe('computeVideoStats', () => {
  const videos = [
    v({ title: 'Movie A', path: 'A.mkv', width: 3840, height: 2160, container: 'matroska,webm', sizeBytes: 8_000_000_000, durationMs: 7_200_000 }),
    v({ title: 'Movie B', path: 'B.mp4', width: 1920, height: 1080, container: 'mov,mp4,m4a', sizeBytes: 2_000_000_000, durationMs: 5_400_000 }),
    v({ title: 'Clip C', path: 'C.mp4', width: 1920, height: 1080, container: 'mov,mp4,m4a', sizeBytes: 500_000_000, durationMs: 600_000 }),
    v({ title: 'Old D', path: 'D.avi', width: 640, height: 480, container: 'avi', sizeBytes: 700_000_000, durationMs: 3_000_000 }),
    v({ title: 'Broken E', path: 'E.mkv', sizeBytes: 12_345 }), // unprobeable: no dims/duration/container
  ];
  const s = computeVideoStats(videos);

  it('counts and sums bytes + duration', () => {
    expect(s.count).toBe(5);
    expect(s.bytes).toBe(8_000_000_000 + 2_000_000_000 + 500_000_000 + 700_000_000 + 12_345);
    expect(s.totalDurationMs).toBe(7_200_000 + 5_400_000 + 600_000 + 3_000_000);
  });

  it('buckets resolutions including unknown', () => {
    expect(s.resolutions['4K']).toBe(1);
    expect(s.resolutions['1080p']).toBe(2);
    expect(s.resolutions['480p']).toBe(1);
    expect(s.resolutions['unknown']).toBe(1);
    expect(s.resolutions['720p']).toBeUndefined();
  });

  it('tallies containers', () => {
    expect(s.containers['matroska,webm']).toBe(1);
    expect(s.containers['mov,mp4,m4a']).toBe(2);
    expect(s.containers['avi']).toBe(1);
  });

  it('lists longest videos descending, excluding durationless', () => {
    expect(s.longest.map((l) => l.title)).toEqual(['Movie A', 'Movie B', 'Old D', 'Clip C']);
    expect(s.longest[0]!.durationMs).toBe(7_200_000);
    expect(s.longest.find((l) => l.title === 'Broken E')).toBeUndefined();
  });
});
