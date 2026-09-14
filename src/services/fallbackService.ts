import { execFile } from 'node:child_process';
import { cacheService } from './cacheService.js';

export class FallbackService {
  public async getDirectStream(query: string): Promise<string | null> {
    const cacheKey = `stream:url:${query.toLowerCase().trim()}`;
    const cached = cacheService.get<string>(cacheKey);
    if (cached) return cached;

    return new Promise((resolve) => {
      execFile(
        'yt-dlp',
        [
          '-g',
          '--no-warnings',
          '--no-playlist',
          '-f',
          'http_mp3/bestaudio[protocol^=http]/bestaudio/best',
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

          // Prefer full audio track, fallback to first available stream
          const url = urls.find((u) => !u.includes('preview')) || urls[0] || null;

          if (url && url.startsWith('http')) {
            cacheService.set(cacheKey, url, 7200);
            return resolve(url);
          }
          resolve(null);
        }
      );
    });
  }

  public async getDirectUrlFromLink(
    url: string
  ): Promise<{ url: string; title: string; duration: number; artist: string; thumbnail: string } | null> {
    const cacheKey = `sc:link:${url.trim()}`;
    const cached = cacheService.get<any>(cacheKey);
    if (cached) return cached;

    return new Promise((resolve) => {
      execFile(
        'yt-dlp',
        ['--dump-json', '--no-warnings', url.trim()],
        { timeout: 12000 },
        (error, stdout) => {
          if (error || !stdout) {
            console.warn(`[FallbackService] Direct link extraction failed for "${url}":`, error?.message);
            return resolve(null);
          }
          try {
            const data = JSON.parse(stdout);
            let streamUrl = data.url;
            if (!streamUrl && data.formats && data.formats.length > 0) {
              const mp3Format = data.formats.find((f: any) => f.ext === 'mp3' || f.protocol === 'http');
              streamUrl = mp3Format?.url || data.formats[0].url;
            }

            if (!streamUrl) return resolve(null);

            const result = {
              url: streamUrl,
              title: data.title || 'SoundCloud Track',
              duration: Math.round(data.duration || 0),
              artist: data.uploader || data.artist || 'SoundCloud Artist',
              thumbnail: data.thumbnail || '',
            };

            cacheService.set(cacheKey, result, 7200);
            return resolve(result);
          } catch {
            return resolve(null);
          }
        }
      );
    });
  }

  public async searchAll(query: string, limit: number = 5): Promise<any[]> {
    return new Promise((resolve) => {
      execFile(
        'yt-dlp',
        [
          '--dump-json',
          '--no-warnings',
          '--no-playlist',
          `scsearch${limit}:${query}`,
        ],
        { timeout: 8000 },
        (error, stdout) => {
          if (error || !stdout) {
            return resolve([]);
          }

          const results: any[] = [];
          const lines = stdout.trim().split('\n');

          for (const line of lines) {
            try {
              if (!line.trim()) continue;
              const data = JSON.parse(line);
              results.push({
                id: data.id,
                title: data.title,
                duration: data.duration || 0,
                artist: data.uploader || 'SoundCloud Artist',
                thumbnail: data.thumbnail || '',
                streamUrl: data.url || `https://soundcloud.com/${data.uploader_id}/${data.display_id}`,
              });
            } catch {}
          }

          resolve(results.slice(0, limit));
        }
      );
    });
  }
}

export const fallbackService = new FallbackService();
