import { Innertube, ClientType, UniversalCache } from 'youtubei.js';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { proxyManager } from './proxyManager.js';
import { cacheService } from './cacheService.js';
import { fallbackService, FallbackTrack } from './fallbackService.js';

export interface SearchResultItem {
  id: string;
  title: string;
  duration?: number;
  durationText?: string;
  author: string;
  authorId?: string;
  thumbnail?: string;
  views?: string;
  url: string;
}

export interface StreamDataResult {
  stream?: Readable;
  directUrl?: string;
  mimeType?: string;
  bitrate?: number;
  contentLength?: number;
  source: 'youtube' | 'jiosaavn' | 'soundcloud';
  title?: string;
  artist?: string;
  thumbnail?: string;
}

export class YouTubeService {
  private innertube: Innertube | null = null;
  private isInitializing: boolean = false;
  private initPromise: Promise<Innertube> | null = null;

  /**
   * Initializes or gets the active InnerTube instance
   */
  public async getInstance(): Promise<Innertube> {
    if (this.innertube) {
      return this.innertube;
    }

    if (this.isInitializing && this.initPromise) {
      return this.initPromise;
    }

    this.isInitializing = true;
    this.initPromise = (async () => {
      try {
        console.log('[YouTubeService] Initializing InnerTube session...');

        const customFetch = async (input: any, init?: RequestInit): Promise<Response> => {
          const proxy = proxyManager.getNextProxy();
          const modifiedInit: RequestInit = { ...init };

          if (proxy) {
            const agent = proxyManager.createNodeAgent(proxy.url);
            if (agent) {
              (modifiedInit as any).agent = agent;
            }
          }

          try {
            const res = await fetch(input as any, modifiedInit);

            if (res.status === 429) {
              console.warn(`[YouTubeService] Received HTTP 429 from YouTube.`);
              if (proxy) {
                proxyManager.reportFailure(proxy.url, true);
              }
            } else if (res.ok && proxy) {
              proxyManager.reportSuccess(proxy.url);
            }

            return res;
          } catch (err) {
            if (proxy) {
              proxyManager.reportFailure(proxy.url, false);
            }
            throw err;
          }
        };

        const yt = await Innertube.create({
          retrieve_player: true,
          generate_session_locally: true,
          cache: new UniversalCache(true),
          cookie: config.ytCookies,
          po_token: config.ytPoToken,
          visitor_data: config.ytVisitorData,
          fetch: config.proxies.length > 0 ? (customFetch as any) : undefined,
        });

        console.log('[YouTubeService] InnerTube successfully initialized and ready!');
        this.innertube = yt;
        return yt;
      } catch (err) {
        console.error('[YouTubeService] Failed to initialize InnerTube session:', err);
        throw err;
      } finally {
        this.isInitializing = false;
      }
    })();

    return this.initPromise;
  }

  /**
   * Extracts YouTube Video ID from standard formats or returns as-is
   */
  public extractVideoId(queryOrUrl: string): string | null {
    if (/^[a-zA-Z0-9_-]{11}$/.test(queryOrUrl)) {
      return queryOrUrl;
    }
    const match = queryOrUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
    return match ? match[1] : null;
  }

  /**
   * Cleans title string for search fallbacks (removes [Official Video], feat, etc.)
   */
  public cleanTitle(rawTitle: string): string {
    return rawTitle
      .replace(/\[.*?\]|\(.*?\)/g, '')
      .replace(/ft\..*|feat\..*/i, '')
      .replace(/official\s*(music)?\s*(video|audio)?/gi, '')
      .replace(/lyrics?/gi, '')
      .replace(/\|\s*.*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Resolves a video ID or search query to track metadata
   */
  public async resolveTrack(queryOrUrl: string): Promise<{ id: string; title: string; duration: number; author: string; thumbnail?: string }> {
    const videoId = this.extractVideoId(queryOrUrl);

    if (videoId) {
      try {
        const info = await this.getInfo(videoId);
        return {
          id: videoId,
          title: info.title || 'Unknown Title',
          duration: info.duration || 0,
          author: info.author || 'Unknown Artist',
          thumbnail: info.thumbnails?.[0]?.url,
        };
      } catch {
        // Fallback to oEmbed if getInfo fails
        const title = await this.resolveVideoTitle(videoId);
        return {
          id: videoId,
          title: title || 'YouTube Track',
          duration: 0,
          author: 'YouTube',
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        };
      }
    }

    // If it's a search term, search and get the first result
    const searchResults = await this.search(queryOrUrl, 1);
    if (searchResults.length > 0) {
      const top = searchResults[0];
      return {
        id: top.id,
        title: top.title,
        duration: top.duration || 0,
        author: top.author,
        thumbnail: top.thumbnail,
      };
    }

    throw new Error(`Could not resolve track for: "${queryOrUrl}"`);
  }

  /**
   * Resolves a video ID to song title via public oEmbed
   */
  public async resolveVideoTitle(videoId: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = (await res.json()) as any;
        if (data?.title) return data.title;
      }
    } catch {}

    return null;
  }

  /**
   * Search songs with YouTube + Fallback support
   */
  public async search(query: string, limit: number = 10): Promise<SearchResultItem[]> {
    const cacheKey = `yt:search:${query.toLowerCase().trim()}`;
    const cached = cacheService.get<SearchResultItem[]>(cacheKey);
    if (cached) {
      return cached.slice(0, limit);
    }

    const results: SearchResultItem[] = [];

    try {
      const yt = await this.getInstance();
      const searchRes = await yt.search(query);

      const items: any[] = [];
      if (searchRes.videos && searchRes.videos.length > 0) {
        items.push(...searchRes.videos);
      } else if (searchRes.results && searchRes.results.length > 0) {
        items.push(...searchRes.results);
      }

      for (const item of items) {
        const id = item.id || item.video_id;
        if (id) {
          results.push({
            id,
            title: item.title?.text || item.title || 'Unknown Title',
            duration: item.duration?.seconds,
            durationText: item.duration?.text,
            author: item.author?.name || item.author?.text || item.short_byline_text?.text || 'Unknown Author',
            authorId: item.author?.id,
            thumbnail: item.thumbnails?.[0]?.url || item.thumbnail?.url || item.best_thumbnail?.url,
            views: item.view_count?.text,
            url: `https://www.youtube.com/watch?v=${id}`,
          });
        }
        if (results.length >= limit) break;
      }
    } catch (err: any) {
      console.warn(`[YouTubeService] YouTube search error:`, err?.message || err);
    }

    // Fallback search if YouTube returns 0 results
    if (results.length === 0 && config.enableFallback) {
      console.log(`[YouTubeService] YouTube returned 0 results, attempting fallback search...`);
      const fallbackTracks = await fallbackService.searchAll(query, limit);

      for (const fb of fallbackTracks) {
        results.push({
          id: fb.id,
          title: fb.title,
          duration: fb.duration,
          durationText: `${Math.floor(fb.duration / 60)}:${(fb.duration % 60).toString().padStart(2, '0')}`,
          author: fb.artist,
          thumbnail: fb.thumbnail,
          views: 'High Quality Stream',
          url: fb.streamUrl,
        });
      }
    }

    if (results.length > 0) {
      cacheService.set(cacheKey, results);
    }

    return results;
  }

  /**
   * Get autoplay recommendations
   */
  public async getAutoplayList(queryOrUrl: string, limit: number = 5): Promise<any[]> {
    const videoId = this.extractVideoId(queryOrUrl) || queryOrUrl;

    try {
      const yt = await this.getInstance();
      const info = await yt.getInfo(videoId);

      const related: any[] = [];
      const watchNext = (info as any).watch_next_feed || (info as any).related_videos || [];

      for (const item of watchNext) {
        if (item.id) {
          related.push({
            id: item.id,
            title: item.title?.text || item.title || 'Related Song',
            duration: item.duration?.seconds || 0,
            thumbnail: item.thumbnails?.[0]?.url || item.thumbnail?.url || '',
            artist: item.author?.name || 'Artist',
          });
        }
        if (related.length >= limit) break;
      }

      if (related.length > 0) return related;
    } catch {}

    // Fallback: search similar songs
    return (await this.search(queryOrUrl, limit)).map((item) => ({
      id: item.id,
      title: item.title,
      duration: item.duration || 0,
      thumbnail: item.thumbnail || '',
      artist: item.author,
    }));
  }

  /**
   * Get Video Metadata
   */
  public async getInfo(videoId: string) {
    const cacheKey = `yt:info:${videoId}`;
    const cached = cacheService.get<any>(cacheKey);
    if (cached) return cached;

    try {
      const yt = await this.getInstance();
      const info = await yt.getBasicInfo(videoId);
      const basic = info.basic_info;

      const data = {
        id: basic.id,
        title: basic.title,
        description: basic.short_description,
        duration: basic.duration,
        author: basic.author,
        channelId: basic.channel_id,
        thumbnails: basic.thumbnail,
        viewCount: basic.view_count,
      };

      cacheService.set(cacheKey, data);
      return data;
    } catch (err: any) {
      const title = await this.resolveVideoTitle(videoId);
      if (title) {
        return { id: videoId, title, author: 'YouTube' };
      }
      throw err;
    }
  }

  /**
   * Audio Stream Pipe (Bulletproof: YouTube Direct -> YouTube Clients -> JioSaavn 320kbps Fallback)
   */
  public async getAudioStream(videoId: string, songTitleHint?: string): Promise<StreamDataResult> {
    const clients: ('TV_EMBEDDED' | 'ANDROID' | 'IOS' | 'WEB')[] = ['TV_EMBEDDED', 'ANDROID', 'IOS', 'WEB'];

    // 1. Try YouTube stream decipher
    for (const client of clients) {
      try {
        const yt = await this.getInstance();
        const webStream = await yt.download(videoId, {
          type: 'audio',
          quality: 'best',
          client,
        });

        if (webStream) {
          const nodeStream = Readable.fromWeb(webStream as any);
          return {
            stream: nodeStream,
            source: 'youtube',
          };
        }
      } catch (err: any) {
        // Continue to next client or fallback
      }
    }

    // 2. Automatic Fallback to high quality direct audio stream
    if (config.enableFallback) {
      let rawTitle = songTitleHint;

      if (!rawTitle) {
        rawTitle = (await this.resolveVideoTitle(videoId)) || undefined;
      }

      const searchQuery = this.cleanTitle(rawTitle || videoId);

      if (searchQuery) {
        console.log(`[YouTubeService] Using Fallback stream for: "${searchQuery}"`);
        const fallback = await fallbackService.getFallbackTrack(searchQuery);

        if (fallback && fallback.streamUrl) {
          const fbRes = await fetch(fallback.streamUrl);

          if (fbRes.ok && fbRes.body) {
            return {
              stream: Readable.fromWeb(fbRes.body as any),
              source: fallback.source,
              title: fallback.title,
              artist: fallback.artist,
              thumbnail: fallback.thumbnail,
            };
          }
        }
      }
    }

    throw new Error(`Failed to stream audio for video ${videoId}`);
  }
}

export const youtubeService = new YouTubeService();
