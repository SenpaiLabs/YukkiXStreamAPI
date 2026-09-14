import { config } from '../config.js';

export interface FallbackTrack {
  id: string;
  title: string;
  artist: string;
  duration: number; // in seconds
  streamUrl: string;
  thumbnail?: string;
  source: 'jiosaavn' | 'soundcloud';
}

export class FallbackService {
  private readonly mirrors = [
    'https://saavn.dev/api',
    'https://saavn.me',
    'https://jiosavan-api-sigma.vercel.app/api',
  ];

  /**
   * Search for songs on JioSaavn with multi-mirror support & timeouts
   */
  public async searchJioSaavn(query: string, limit: number = 5): Promise<FallbackTrack[]> {
    for (const mirror of this.mirrors) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const searchUrl = `${mirror}/search/songs?query=${encodeURIComponent(query)}&page=1&limit=${limit}`;
        const res = await fetch(searchUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });

        clearTimeout(timeoutId);

        if (!res.ok) continue;

        const json = (await res.json()) as any;
        const songs = json?.data?.results || json?.data || [];

        if (Array.isArray(songs) && songs.length > 0) {
          const parsedTracks: FallbackTrack[] = [];

          for (const song of songs) {
            const downloadUrls = song.downloadUrl || [];
            const bestAudio =
              downloadUrls.find((u: any) => u.quality === '320kbps')?.url ||
              downloadUrls.find((u: any) => u.quality === '160kbps')?.url ||
              downloadUrls[downloadUrls.length - 1]?.url ||
              song.media_url;

            if (bestAudio) {
              parsedTracks.push({
                id: song.id,
                title: song.name?.replace(/&quot;/g, '"')?.replace(/&#039;/g, "'") || query,
                artist:
                  song.artists?.primary?.map((a: any) => a.name).join(', ') ||
                  song.primaryArtists ||
                  'Unknown Artist',
                duration: parseInt(song.duration || '0', 10),
                streamUrl: bestAudio,
                thumbnail: song.image?.[song.image.length - 1]?.url || song.image?.[0]?.url,
                source: 'jiosaavn',
              });
            }
          }

          if (parsedTracks.length > 0) {
            return parsedTracks;
          }
        }
      } catch (err: any) {
        // Try next mirror
        continue;
      }
    }

    return [];
  }

  /**
   * Get single fallback track
   */
  public async getFallbackTrack(query: string): Promise<FallbackTrack | null> {
    if (!config.enableFallback) return null;

    const tracks = await this.searchJioSaavn(query, 1);
    if (tracks.length > 0) {
      return tracks[0];
    }

    return null;
  }

  /**
   * Universal search when YouTube search is throttled or empty
   */
  public async searchAll(query: string, limit: number = 10) {
    if (!config.enableFallback) return [];
    return this.searchJioSaavn(query, limit);
  }
}

export const fallbackService = new FallbackService();
