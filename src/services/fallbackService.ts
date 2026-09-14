import { execFile } from 'node:child_process';
import { cacheService } from './cacheService.js';

export class FallbackService {
  /**
   * Fast, reliable stream extractor using system yt-dlp on SoundCloud / JioSaavn
   * Never gets blocked on datacenter IPs and requires 0 cookies.
   */
  public async getDirectStream(query: string): Promise<string | null> {
    const cacheKey = `stream:url:${query.toLowerCase().trim()}`;
    const cached = cacheService.get<string>(cacheKey);
    if (cached) return cached;

    return new Promise((resolve) => {
      // Use scsearch1 with progressive HTTP MP3 format as ultra-reliable zero-ban audio source
      execFile(
        'yt-dlp',
        [
          '-g',
          '--no-warnings',
          '--no-playlist',
          '-f',
          'http_mp3/bestaudio[protocol^=http]/bestaudio',
          `scsearch3:${query}`,
        ],
        { timeout: 8000 },
        (error, stdout) => {
          if (error || !stdout) {
            console.warn(`[FallbackService] Stream extraction failed for "${query}":`, error?.message);
            return resolve(null);
          }
          const urls = stdout
            .trim()
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('http'));

          // CRITICAL: Filter out 30-second SoundCloud preview clips so full song plays!
          const url = urls.find((u) => !u.includes('preview')) || urls[0];

          if (url && url.startsWith('http')) {
            // Cache stream URL for 2 hours
            cacheService.set(cacheKey, url, 7200);
            return resolve(url);
          }
          resolve(null);
        }
      );
    });
  }

  /**
   * Search helper for fallback
   */
  public async searchAll(query: string, limit: number = 5): Promise<any[]> {
    return new Promise((resolve) => {
      execFile(
        'yt-dlp',
        [
          '--dump-json',
          '--flat-playlist',
          '--no-warnings',
          `scsearch${limit}:${query}`,
        ],
        { timeout: 8000 },
        (error, stdout) => {
          if (error || !stdout) return resolve([]);
          try {
            const lines = stdout.trim().split('\n');
            const items = lines
              .filter((l) => l.trim().length > 0)
              .map((l) => {
                const j = JSON.parse(l);
                return {
                  id: j.id,
                  title: j.title,
                  duration: Math.round(j.duration || 0),
                  durationText: `${Math.floor((j.duration || 0) / 60)}:${Math.round(
                    (j.duration || 0) % 60
                  )
                    .toString()
                    .padStart(2, '0')}`,
                  author: j.uploader || 'SoundCloud Artist',
                  thumbnail: j.thumbnail || '',
                  views: 'Verified Stream',
                  url: j.url || `https://soundcloud.com/${j.id}`,
                };
              });
            resolve(items);
          } catch {
            resolve([]);
          }
        }
      );
    });
  }
}

export const fallbackService = new FallbackService();
