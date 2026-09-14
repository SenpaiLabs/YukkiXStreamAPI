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
  /**
   * Search for songs on JioSaavn as a primary fallback
   */
  public async searchJioSaavn(query: string): Promise<FallbackTrack | null> {
    try {
      // Free public JioSaavn endpoints
      const searchUrl = `https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}&page=1&limit=1`;
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (!res.ok) return null;

      const data = (await res.json()) as any;
      const song = data?.data?.results?.[0];
      if (!song) return null;

      // Select highest quality download URL (320kbps or 160kbps)
      const downloadUrls = song.downloadUrl || [];
      const bestAudio =
        downloadUrls.find((u: any) => u.quality === '320kbps')?.url ||
        downloadUrls.find((u: any) => u.quality === '160kbps')?.url ||
        downloadUrls[downloadUrls.length - 1]?.url;

      if (!bestAudio) return null;

      return {
        id: song.id,
        title: song.name?.replace(/&quot;/g, '"')?.replace(/&#039;/g, "'") || query,
        artist: song.artists?.primary?.map((a: any) => a.name).join(', ') || 'Unknown Artist',
        duration: parseInt(song.duration || '0', 10),
        streamUrl: bestAudio,
        thumbnail: song.image?.[song.image.length - 1]?.url,
        source: 'jiosaavn',
      };
    } catch (err) {
      console.warn('[FallbackService] JioSaavn search failed:', (err as Error).message);
      return null;
    }
  }

  /**
   * Universal search when YouTube is throttled or 429'd
   */
  public async getFallbackTrack(query: string): Promise<FallbackTrack | null> {
    if (!config.enableFallback) return null;

    console.log(`[FallbackService] Attempting fallback search for: "${query}"`);
    const track = await this.searchJioSaavn(query);
    if (track) {
      console.log(`[FallbackService] Found fallback on ${track.source}: "${track.title}" - "${track.artist}"`);
      return track;
    }

    return null;
  }
}

export const fallbackService = new FallbackService();
