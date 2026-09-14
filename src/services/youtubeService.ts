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
   * Resolve ClientType from string config
   */
  private resolveClientType(typeStr: string): ClientType {
    switch (typeStr.toUpperCase()) {
      case 'TV_EMBEDDED':
        return ClientType.TV_EMBEDDED;
      case 'TV':
        return ClientType.TV;
      case 'IOS':
        return ClientType.IOS;
      case 'ANDROID':
        return ClientType.ANDROID;
      case 'WEB':
      default:
        return ClientType.WEB;
    }
  }

  /**
   * Initializes or gets the active InnerTube instance with anti-ban settings
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

        // Custom fetch wrapper to route requests through rotating proxies and catch 429
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
              console.warn(`[YouTubeService] Received HTTP 429 (Rate Limited / IP Ban) from YouTube.`);
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

        // Note: WEB session allows extracting base.js decipher algorithm successfully.
        // Mobile/TV client spoofing is applied at download/stream extraction time.
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
   * Resolves a video ID to song title using public oEmbed APIs (no IP ban or decipher needed)
   */
  public async resolveVideoTitle(videoId: string): Promise<string | null> {
    try {
      const res = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data?.title) return data.title;
      }
    } catch {}

    try {
      const res2 = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
      if (res2.ok) {
        const data2 = (await res2.json()) as any;
        if (data2?.title) return data2.title;
      }
    } catch {}

    return null;
  }

  /**
   * Search songs with caching and anti-ban retry logic
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

      // Extract results from both videos getter and raw results array
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
      console.warn(`[YouTubeService] YouTube search error for "${query}":`, err?.message || err);
    }

    // If YouTube returned 0 results or failed (e.g. Datacenter IP block), fallback automatically
    if (results.length === 0 && config.enableFallback) {
      console.log(`[YouTubeService] YouTube search yielded 0 results for "${query}". Triggering Fallback provider...`);
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
      // Fallback to oEmbed if YouTube blocks basic_info
      const title = await this.resolveVideoTitle(videoId);
      if (title) {
        return {
          id: videoId,
          title,
          author: 'Unknown Artist',
        };
      }
      throw err;
    }
  }

  /**
   * Stream audio directly (pipes YouTube audio chunks directly to the response)
   * If YouTube blocks on VPS, automatically switches to Fallback with title resolution.
   */
  public async getAudioStream(videoId: string, songTitleHint?: string): Promise<StreamDataResult> {
    const clientTypesToTry = [
      this.resolveClientType(config.ytClientType),
      ClientType.TV_EMBEDDED,
      ClientType.ANDROID,
      ClientType.IOS,
    ];

    let lastError: any = null;

    // Try multiple client types for YouTube
    for (const clientType of clientTypesToTry) {
      try {
        const yt = await this.getInstance();
        const webStream = await yt.download(videoId, {
          type: 'audio',
          quality: 'best',
          client: clientType as any,
        });

        const nodeStream = Readable.fromWeb(webStream as any);
        return {
          stream: nodeStream,
          source: 'youtube',
        };
      } catch (err: any) {
        lastError = err;
        console.warn(`[YouTubeService] Audio download failed with client ${clientType}:`, err?.message || err);
      }
    }

    // If all YouTube clients failed (Datacenter IP ban / 429), trigger Fallback
    if (config.enableFallback) {
      console.log(`[YouTubeService] YouTube direct stream blocked. Resolving title for fallback...`);

      // Determine track title for search
      let searchTitle = songTitleHint;
      if (!searchTitle) {
        searchTitle = (await this.resolveVideoTitle(videoId)) || undefined;
      }

      if (searchTitle) {
        console.log(`[YouTubeService] Fallback search title: "${searchTitle}"`);
        const fallback = await fallbackService.getFallbackTrack(searchTitle);

        if (fallback && fallback.streamUrl) {
          console.log(`[YouTubeService] Streaming from fallback provider: "${fallback.title}"`);
          const fbRes = await fetch(fallback.streamUrl);

          if (fbRes.ok && fbRes.body) {
            const fbStream = Readable.fromWeb(fbRes.body as any);
            return {
              stream: fbStream,
              source: fallback.source,
              title: fallback.title,
              artist: fallback.artist,
              thumbnail: fallback.thumbnail,
            };
          }
        }
      }
    }

    throw new Error(`Failed to stream audio for ${videoId}: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Get direct streaming playback URL
   */
  public async getDirectPlaybackUrl(videoId: string): Promise<string> {
    const cacheKey = `yt:directurl:${videoId}`;
    const cached = cacheService.get<string>(cacheKey);
    if (cached) return cached;

    try {
      const yt = await this.getInstance();
      const format = await yt.getStreamingData(videoId, {
        type: 'audio',
        quality: 'best',
        client: this.resolveClientType(config.ytClientType) as any,
      });

      if (!format || !format.url) {
        throw new Error('Could not decipher direct audio playback format URL.');
      }

      cacheService.set(cacheKey, format.url, 7200);
      return format.url;
    } catch (err: any) {
      console.warn(`[YouTubeService] Failed to extract direct URL for ${videoId}:`, err?.message);
      throw err;
    }
  }

  /**
   * Force refresh session
   */
  public async refreshSession(): Promise<void> {
    console.log('[YouTubeService] Refreshing InnerTube session...');
    this.innertube = null;
    await this.getInstance();
  }
}

export const youtubeService = new YouTubeService();
