import { Request, Response } from 'express';
import { spawn } from 'node:child_process';
import { youtubeService } from '../services/youtubeService.js';
import { cacheService } from '../services/cacheService.js';
import { fallbackService } from '../services/fallbackService.js';
import { saavnService } from '../services/saavnService.js';
import { config } from '../config.js';

export class StreamController {
  public async getHealth(req: Request, res: Response): Promise<void> {
    const cacheStats = cacheService.getStats();

    res.json({
      status: 'healthy',
      version: '1.0.0',
      uptime: process.uptime(),
      clientType: config.ytClientType,
      cache: cacheStats,
      timestamp: new Date().toISOString(),
    });
  }

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
      const videoInfo = await youtubeService.resolveTrack(trimmed);
      const videoTitle = videoInfo.title || '';

      const isMixOrVariant = /remix|mashup|8d|lofi|lo-fi|slowed|reverb|tiktok|trending|cover|mix|edit|bass|acoustic|live/i.test(
        videoTitle + ' ' + trimmed
      );

      let directUrl: string | null = null;

      // Try JioSaavn 320kbps studio master for standard releases
      if (!isMixOrVariant) {
        const cleanTitle = youtubeService.cleanTitle(videoTitle);
        const saavnTrack = await saavnService.getOfficialStream(cleanTitle);

        if (saavnTrack && saavnTrack.streamUrl) {
          const saavnTitleLower = saavnTrack.title.toLowerCase();
          const cleanWords = cleanTitle.toLowerCase().split(' ').filter(w => w.length > 2);
          const hasMatch = cleanWords.some(w => saavnTitleLower.includes(w));
          if (hasMatch) {
            directUrl = saavnTrack.streamUrl;
          }
        }
      }

      // Fallback to SoundCloud (keeps mix/remix variants intact)
      if (!directUrl) {
        const searchQuery = isMixOrVariant
          ? videoTitle.replace(/\|\s*.*$/g, '').trim()
          : youtubeService.cleanTitle(videoTitle);
        directUrl = await fallbackService.getDirectStream(searchQuery);
      }

      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      const host = req.headers['x-forwarded-host'] || req.get('host') || `${config.host}:${config.port}`;
      const baseUrl = `${protocol}://${host}`;

      const pipeUrl = `${baseUrl}/pipe/${videoInfo.id}?title=${encodeURIComponent(videoTitle)}`;
      const finalStreamUrl = (directUrl && !directUrl.includes('.m3u8')) ? directUrl : pipeUrl;

      const responseData = {
        streamUrl: finalStreamUrl,
        title: videoInfo.title,
        quality: '320kbps',
        duration: videoInfo.duration || 0,
        thumbnail: videoInfo.thumbnail || '',
        artist: videoInfo.author || 'Unknown Artist',
      };

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

  public async pipeAudio(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    const titleHint = req.query.title as string | undefined;

    if (!id) {
      res.status(400).json({ error: 'Parameter "id" is required.' });
      return;
    }

    let title = titleHint;
    if (!title) {
      try {
        const info = await youtubeService.resolveTrack(id);
        title = info.title;
      } catch {
        title = id;
      }
    }

    const cleanSearchQuery = youtubeService.cleanTitle(title || id);
    const streamUrl = await fallbackService.getDirectStream(cleanSearchQuery);

    if (!streamUrl) {
      res.status(500).json({ success: false, error: `Could not extract stream for ${id}` });
      return;
    }

    // Fast HEAD response for PyTgCalls / curl probes
    if (req.method === 'HEAD') {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Accept-Ranges', 'none');
      res.status(200).end();
      return;
    }

    // Transcode HLS (.m3u8) to progressive MP3 to prevent PyTgCalls reconnect loops
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

    res.redirect(302, streamUrl);
  }

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
