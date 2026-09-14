import { Innertube, UniversalCache } from 'youtubei.js';
import { config } from '../config.js';
import { cacheService } from './cacheService.js';
import { fallbackService } from './fallbackService.js';

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

export class YouTubeService {
  private innertube: Innertube | null = null;
  private isInitializing: boolean = false;
  private initPromise: Promise<Innertube> | null = null;

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

        const yt = await Innertube.create({
          retrieve_player: true,
          generate_session_locally: true,
          cache: new UniversalCache(true),
          cookie: config.ytCookies,
          po_token: config.ytPoToken,
          visitor_data: config.ytVisitorData,
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

  public extractVideoId(queryOrUrl: string): string | null {
    if (/^[a-zA-Z0-9_-]{11}$/.test(queryOrUrl)) {
      return queryOrUrl;
    }
    const match = queryOrUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
    return match ? match[1] : null;
  }

  public cleanTitle(rawTitle: string): string {
    return rawTitle
      .replace(/\[(?:[^\]]*(?:official|video|audio|lyrics?|lyrical|4k|hd|remastered)[^\]]*)\]/gi, '')
      .replace(/\((?:[^\)]*(?:official|video|audio|lyrics?|lyrical|4k|hd|remastered|feat\.|ft\.)[^\)]*)\)/gi, '')
      .replace(/\[(?:feat\.|ft\.).*?\]/gi, '')
      .replace(/\b(official\s*(music)?\s*(video|audio)?|lyrical(\s*video)?|lyrics?|full\s*(video|audio|song))\b/gi, '')
      .replace(/\b(ft\.|feat\.)\s+[^()\[\]|]+/gi, '')
      .replace(/[()[\]{}]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  public extractTitleCandidates(rawTitle: string, author?: string): string[] {
    const candidates: string[] = [];
    const cleaned = this.cleanTitle(rawTitle);

    // 1. Full cleaned title without pipe clutter
    const noPipe = cleaned.split('|')[0].trim();
    if (noPipe) candidates.push(noPipe);
    if (cleaned && cleaned !== noPipe) candidates.push(cleaned);

    // 2. Segments split by '|' or '/'
    const segments = rawTitle
      .split(/[|/]/)
      .map((s) => this.cleanTitle(s))
      .filter((s) => s.length > 2);

    for (const seg of segments) {
      if (!candidates.includes(seg)) {
        candidates.push(seg);
      }
    }

    // 3. Main segment with author
    if (segments.length > 0 && author && author !== 'YouTube' && author !== 'Unknown Artist') {
      const cleanAuthor = author.replace(/-\s*Topic|VEVO/gi, '').trim();
      const withAuthor = `${segments[0]} ${cleanAuthor}`.trim();
      if (!candidates.includes(withAuthor)) {
        candidates.push(withAuthor);
      }
    }

    return candidates;
  }

  public async normalizeQuery(queryOrUrl: string): Promise<string> {
    let normalized = queryOrUrl.trim();
    const urlMatch = normalized.match(/(https?:\/\/\S+)/);
    if (urlMatch) {
      const cleanUrl = urlMatch[1].trim();
      if (cleanUrl.includes('spotify.com')) {
        try {
          const baseSpotify = cleanUrl.split('?')[0];
          const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(baseSpotify)}`);
          if (res.ok) {
            const data = (await res.json()) as any;
            if (data?.title) {
              const artist = data.author_name ? ` ${data.author_name}` : '';
              return `${data.title}${artist}`.trim();
            }
          }
        } catch {}
      } else if (cleanUrl.includes('jiosaavn.com/song/')) {
        try {
          const parts = cleanUrl.split('jiosaavn.com/song/')[1]?.split('/');
          if (parts && parts[0]) {
            return parts[0].replace(/-/g, ' ');
          }
        } catch {}
      } else if (cleanUrl.includes('music.apple.com')) {
        try {
          const match = cleanUrl.match(/\/(?:song|album)\/([^/?#]+)/);
          if (match && match[1]) {
            return match[1].replace(/-/g, ' ');
          }
        } catch {}
      } else if (cleanUrl.includes('soundcloud.com')) {
        try {
          const sc = await fallbackService.getDirectUrlFromLink(cleanUrl);
          if (sc && sc.title) {
            const author = sc.artist ? ` ${sc.artist}` : '';
            return `${sc.title}${author}`.trim();
          }
        } catch {}
      }
    }
    return normalized;
  }

  public async resolveTrack(queryOrUrl: string): Promise<{ id: string; title: string; duration: number; author: string; thumbnail?: string }> {
    const normalized = await this.normalizeQuery(queryOrUrl);
    const videoId = this.extractVideoId(normalized);

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

    const searchResults = await this.search(normalized, 1);
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

  public async search(query: string, limit: number = 10): Promise<SearchResultItem[]> {
    const normalized = await this.normalizeQuery(query);
    const cacheKey = `yt:search:${normalized.toLowerCase().trim()}`;
    const cached = cacheService.get<SearchResultItem[]>(cacheKey);
    if (cached) {
      return cached.slice(0, limit);
    }

    const results: SearchResultItem[] = [];

    try {
      const yt = await this.getInstance();
      const searchRes = await yt.search(normalized);

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

    if (results.length === 0 && config.enableFallback) {
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

    return (await this.search(queryOrUrl, limit)).map((item) => ({
      id: item.id,
      title: item.title,
      duration: item.duration || 0,
      thumbnail: item.thumbnail || '',
      artist: item.author,
    }));
  }

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
}

export const youtubeService = new YouTubeService();
