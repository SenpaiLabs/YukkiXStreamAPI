import { Request, Response } from 'express';
import { spawn } from 'node:child_process';
import { youtubeService } from '../services/youtubeService.js';
import { proxyManager } from '../services/proxyManager.js';
import { cacheService } from '../services/cacheService.js';
import { fallbackService } from '../services/fallbackService.js';
import { saavnService } from '../services/saavnService.js';
import { config } from '../config.js';

export class StreamController {
  /**
   * Health Check and Proxy Status
   */
  public async getHealth(req: Request, res: Response): Promise<void> {
    const proxyStatus = proxyManager.getStatus();
    const cacheStats = cacheService.getStats();

    res.json({
      status: 'healthy',
      version: '1.0.0',
      uptime: process.uptime(),
      clientType: config.ytClientType,
      proxies: proxyStatus,
      cache: cacheStats,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Primary Stream Resolver for YukkiMusic
   * GET /stream?url=<id_or_url>&format=audio
   *
   * YukkiMusic expects:
   * {
   *   "success": true,
   *   "data": {
   *     "streamUrl": "http://<host>/pipe/<id>",
   *     "title": "...",
   *     "quality": "320kbps",
   *     "duration": 213,
   *     "thumbnail": "...",
   *     "artist": "..."
   *   }
   * }
   */
  public async resolveStream(req: Request, res: Response): Promise<void> {
    const queryOrUrl = (req.query.url as string) || (req.query.q as string);

    if (!queryOrUrl || queryOrUrl.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Query parameter "url" is required.',
      });
      return;
    }

    const trimmed = queryOrUrl.trim();
    const cacheKey = `resolved:${trimmed.toLowerCase()}`;
    const cached = cacheService.get<any>(cacheKey);
    if (cached) {
      res.json({
        success: true,
        data: cached,
      });
      return;
    }

    try {
      // 1. Try JioSaavn first for 100% official studio master 320kbps track
      const cleanTitle = youtubeService.cleanTitle(trimmed);
      const saavnTrack = await saavnService.getOfficialStream(cleanTitle || trimmed);

      if (saavnTrack && saavnTrack.streamUrl) {
        const responseData = {
          streamUrl: saavnTrack.streamUrl,
          title: saavnTrack.title,
          quality: '320kbps',
          duration: saavnTrack.duration,
          thumbnail: saavnTrack.thumbnail,
          artist: saavnTrack.artist,
        };
        // Cache response for 4 hours
        cacheService.set(cacheKey, responseData, 14400);
        res.json({
          success: true,
          data: responseData,
        });
        return;
      }

      // 2. Fallback to YouTube InnerTube metadata + SoundCloud direct stream
      const videoInfo = await youtubeService.resolveTrack(trimmed);

      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      const host = req.headers['x-forwarded-host'] || req.get('host') || `${config.host}:${config.port}`;
      const baseUrl = `${protocol}://${host}`;

      const pipeUrl = `${baseUrl}/pipe/${videoInfo.id}?title=${encodeURIComponent(videoInfo.title)}`;

      const cleanSearchQuery = youtubeService.cleanTitle(videoInfo.title || videoInfo.id);
      const directUrl = await fallbackService.getDirectStream(cleanSearchQuery);

      // If directUrl is a progressive stream (e.g. mp3/m4a/webm, not m3u8), PyTgCalls can stream it directly!
      const finalStreamUrl = (directUrl && !directUrl.includes('.m3u8')) ? directUrl : pipeUrl;

      const responseData = {
        streamUrl: finalStreamUrl,
        title: videoInfo.title,
        quality: '320kbps',
        duration: videoInfo.duration || 0,
        thumbnail: videoInfo.thumbnail || '',
        artist: videoInfo.author || 'Unknown Artist',
      };

      // Cache response for 4 hours
      cacheService.set(cacheKey, responseData, 14400);

      res.json({
        success: true,
        data: responseData,
      });
    } catch (err: any) {
      console.error('[StreamController] Resolve stream error:', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Failed to resolve stream.',
      });
    }
  }

  /**
   * Search songs (supports both ?query= and ?q= for YukkiMusic)
   * GET /search?query=<text>&limit=5&platform=youtube
   */
  public async search(req: Request, res: Response): Promise<void> {
    const query = (req.query.query as string) || (req.query.q as string);
    const limit = parseInt((req.query.limit as string) || '5', 10);

    if (!query || query.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Query parameter "query" or "q" is required.' });
      return;
    }

    try {
      const results = await youtubeService.search(query, limit);

      res.json({
        success: true,
        query,
        count: results.length,
        results,
      });
    } catch (err: any) {
      console.error('[StreamController] Search error:', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Internal error occurred during search.',
      });
    }
  }

  /**
   * Autoplay recommendations for continuous radio
   * GET /autoplay?url=<id_or_url>&limit=5
   */
  public async getAutoplay(req: Request, res: Response): Promise<void> {
    const queryOrUrl = (req.query.url as string) || (req.query.id as string);
    const limit = parseInt((req.query.limit as string) || '5', 10);

    if (!queryOrUrl) {
      res.status(400).json({ success: false, error: 'Parameter "url" is required.' });
      return;
    }

    try {
      const autoplayList = await youtubeService.getAutoplayList(queryOrUrl, limit);
      res.json({
        success: true,
        autoplay: autoplayList,
      });
    } catch (err: any) {
      console.error('[StreamController] Autoplay error:', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Failed to retrieve autoplay tracks.',
      });
    }
  }

  /**
   * Direct Audio Pipe (Handles PyTgCalls, ffmpeg, and curl -I HEAD requests)
   * GET /pipe/:id OR GET /stream/:id
   */
  public async pipeAudio(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    const titleHint = req.query.title as string | undefined;

    if (!id) {
      res.status(400).json({ error: 'Parameter "id" is required.' });
      return;
    }

    // 1. Resolve title
    let title = titleHint;
    if (!title) {
      try {
        const info = await youtubeService.resolveTrack(id);
        title = info.title;
      } catch {
        title = id;
      }
    }

    // 2. Fetch direct playable stream URL
    const cleanSearchQuery = youtubeService.cleanTitle(title || id);
    const streamUrl = await fallbackService.getDirectStream(cleanSearchQuery);

    if (!streamUrl) {
      res.status(500).json({ success: false, error: `Could not extract stream for ${id}` });
      return;
    }

    // CRITICAL: Handle HTTP HEAD requests (e.g. curl -I or PyTgCalls probe)
    if (req.method === 'HEAD') {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Accept-Ranges', 'none');
      res.status(200).end();
      return;
    }

    // If streamUrl is an HLS m3u8 playlist, transcode on-the-fly to progressive MP3 using ffmpeg pipe
    // This solves the PyTgCalls issue where -reconnect_at_eof causes infinite loops on m3u8 playlists
    if (streamUrl.includes('.m3u8')) {
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
      });

      const ff = spawn('ffmpeg', [
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '2',
        '-i',
        streamUrl,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        '-f',
        'mp3',
        'pipe:1',
      ]);

      ff.stdout.pipe(res);

      req.on('close', () => {
        ff.kill('SIGKILL');
      });

      ff.on('error', (err) => {
        console.error(`[StreamController] FFmpeg pipe error for ${id}:`, err);
        if (!res.headersSent) {
          res.status(500).end();
        }
      });
      return;
    }

    // 3. Progressive direct audio stream (e.g. CloudFront MP3) -> 302 Found
    res.redirect(302, streamUrl);
  }

  /**
   * Video metadata info
   * GET /api/info/:id
   */
  public async getInfo(req: Request, res: Response): Promise<void> {
    const id = req.params.id;

    if (!id) {
      res.status(400).json({ error: 'Parameter "id" is required.' });
      return;
    }

    try {
      const info = await youtubeService.getInfo(id);
      res.json({ success: true, data: info });
    } catch (err: any) {
      console.error(`[StreamController] GetInfo error for ${id}:`, err);
      res.status(500).json({
        success: false,
        error: err.message || 'Failed to retrieve video metadata.',
      });
    }
  }
}

export const streamController = new StreamController();
