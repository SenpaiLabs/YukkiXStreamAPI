import CryptoJS from 'crypto-js';
import { cacheService } from './cacheService.js';

export interface SaavnSong {
  id: string;
  title: string;
  album: string;
  artist: string;
  duration: number;
  thumbnail: string;
  streamUrl: string;
  quality: string;
}

export class SaavnService {
  private readonly desKey = CryptoJS.enc.Utf8.parse('38346591');

  public decryptMediaUrl(encryptedUrl: string): string {
    try {
      const decrypted = CryptoJS.DES.decrypt(
        encryptedUrl,
        this.desKey,
        { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
      );
      const rawUrl = decrypted.toString(CryptoJS.enc.Utf8).trim();
      if (!rawUrl) return '';
      return rawUrl.replace(/_96\.mp4|_160\.mp4/, '_320.mp4');
    } catch {
      return '';
    }
  }

  public async getOfficialStream(query: string): Promise<SaavnSong | null> {
    const cleanQuery = query.toLowerCase().trim();
    const cacheKey = `saavn:track:${cleanQuery}`;
    const cached = cacheService.get<SaavnSong>(cacheKey);
    if (cached) return cached;

    try {
      const searchUrl = `https://www.jiosaavn.com/api.php?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=1&query=${encodeURIComponent(query)}`;
      const searchRes = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });

      if (!searchRes.ok) return null;
      const searchData = (await searchRes.json()) as any;
      const song = searchData?.songs?.data?.[0];
      if (!song || !song.id) return null;

      const detailUrl = `https://www.jiosaavn.com/api.php?__call=song.getDetails&cc=in&_marker=0&_format=json&pids=${song.id}`;
      const detailRes = await fetch(detailUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });

      if (!detailRes.ok) return null;
      const detailData = (await detailRes.json()) as any;
      const trackObj = detailData?.[song.id];
      if (!trackObj) return null;

      const encryptedMediaUrl = trackObj.encrypted_media_url;
      if (!encryptedMediaUrl) return null;

      const streamUrl = this.decryptMediaUrl(encryptedMediaUrl);
      if (!streamUrl || !streamUrl.startsWith('http')) return null;

      const result: SaavnSong = {
        id: song.id,
        title: trackObj.song || song.title,
        album: trackObj.album || song.album,
        artist: trackObj.primary_artists || song.more_info?.primary_artists || 'Official Artist',
        duration: parseInt(trackObj.duration || '0', 10),
        thumbnail: trackObj.image ? trackObj.image.replace(/150x150/, '500x500') : (song.image || ''),
        streamUrl,
        quality: '320kbps',
      };

      cacheService.set(cacheKey, result, 21600);
      return result;
    } catch (err: any) {
      console.warn(`[SaavnService] Search error for "${query}":`, err?.message);
      return null;
    }
  }
}

export const saavnService = new SaavnService();
