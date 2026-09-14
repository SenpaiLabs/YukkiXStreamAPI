# YukkiXStreamAPI 🚀
> High-Performance, Anti-IP-Ban Audio Streaming & Search API for Telegram Music Bots (Yukki, AnonX, Daisy, PyTgCalls).

---

## 🛑 Problem: Telegram Music Bots Bar-Bar IP Block Kyu Hote Hain?

Agar aap Telegram par Music Bot (Yukki, AnonX, etc.) run kar rahe hain aur YouTube se stream karte hain, toh bar-bar yeh problems aati hain:
1. **YouTube Datacenter IP Ban (HTTP 429 & BotGuard Challenge)**:
   - YouTube ab Hetzner, DigitalOcean, AWS, Contabo jaise cloud providers ke IP ranges ko actively block karta hai ("Sign in to confirm you're not a bot").
2. **YouTube Stream Link IP Binding (403 Forbidden)**:
   - YouTube ke audio links (`googlevideo.com/videoplayback?...`) client IP se lock hote hain. Agar extraction kisi aur IP pe hui aur bot dusre IP se play karne ki koshish kare, toh instant `403 Forbidden` milta hai.
3. **High Request Rate on Single VPS**:
   - Har group me `/play` command chalne par yt-dlp bar-bar YouTube ko hit karta hai, jisse IP ban trigger hota hai.

---

## 🛡️ Anti-Ban Solution Architecture (Is Project Me Kya Kiya Hai?)

Is project (**YukkiXStreamAPI**) me humne 6 layers of protection implement kiye hain:

```
[ Telegram Music Bot (Yukki / PyTgCalls) ]
                   │
                   ▼  GET /api/stream/:id (Chunked Audio Pipe)
       [ YukkiXStreamAPI (Node/TS Server) ]
         │         │               │
  (Cache Check)  (Proxy Pool)   (Fallback Engine)
         │         │               │
         ▼         ▼               ▼
     [RAM Cache] [Rotating Proxy]  [JioSaavn / SoundCloud]
                   │
                   ▼ (InnerTube Android Client Spoof + PO Token)
              [ YouTube ]
```

1. **Client Spoofing (`ANDROID` / `TV_EMBEDDED`)**:
   - Web client sabse zyada BotGuard challenge trigger karta hai.
   - InnerTube ka `ANDROID` client spoof karne par BotGuard challenges 90% tak bypass ho jaate hain.
2. **Rotating Proxy Manager (Auto-Rotation & Cooldown)**:
   - Agar aapke paas multiple proxies hain, toh yeh manager automatically round-robin karta hai.
   - Agar kisi proxy ko 429 milta hai, toh yeh system us IP ko 5 minutes ke cooldown me daal kar turant doosri proxy se retry karta hai.
3. **PO-Token (Proof of Origin) & Visitor Data**:
   - Modern YouTube BotGuard attestation tokens inject karne ka support.
4. **Pass-Through Chunked Stream Pipe (`/api/stream/:id`)**:
   - Raw `googlevideo.com` URL return karne ke bajay, yeh API audio stream ko khud chunks me pipe karti hai.
   - Telegram Bot ko YouTube ke direct link ki zaroorat hi nahi hoti—bot direct aapki API se stream karta hai, jisse **IP mismatch / 403 error bilkul khatam ho jaata hai**.
5. **Smart In-Memory RAM Cache (`node-cache`)**:
   - Ek baar jo song search ya play hua, uski metadata aur direct stream cache ho jaati hai. Bar-bar YouTube hit nahi hota.
6. **Automatic Multi-Source Fallback (JioSaavn)**:
   - Agar kisi reason se YouTube ka IP temporary ban ho bhi jaaye, toh yeh bot user ko error dene ke bajay automatically JioSaavn (320kbps / 160kbps AAC/MP4) se song fetch karke stream kar deta hai. Music kabhi stop nahi hota!

---

## ⚡ Quick Start

### 1. Requirements
- Node.js 18+ / 20+ / 22+
- npm

### 2. Setup
```bash
# Clone or navigate to directory
cd YukkiXStreamAPI

# Dependencies install karein
npm install

# .env file create karein
cp .env.example .env
```

### 3. Configure `.env`
Apne `.env` file ko customize karein:
```env
PORT=3000
HOST=0.0.0.0
API_SECRET_KEY=my_super_secret_key

# Options: ANDROID, TV_EMBEDDED, IOS, WEB
YT_CLIENT_TYPE=ANDROID

# Proxies (Comma separated: http, https, ya socks5)
# Agar proxies nahi hain toh empty chhod sakte hain
PROXIES=http://user:pass@proxy1:8080,socks5://proxy2:1080

# Fallback enable (JioSaavn)
ENABLE_FALLBACK=true
```

### 4. Run Server
```bash
# Development Mode (auto-reload)
npm run dev

# Production Build & Run
npm run build
npm start
```

---

## 🔌 API Endpoints Reference

| Method | Endpoint | Description | Example |
|---|---|---|---|
| `GET` | `/health` | Server status, active proxies, and cache stats | `/health` |
| `GET` | `/api/search` | Fast search with metadata and caching | `/api/search?q=tum+hi+ho&limit=5` |
| `GET` | `/api/info/:id` | Video duration, title, thumbnails, channel | `/api/info/kJQP7kiw5Fk` |
| `GET` | `/api/stream/:id` | **Live Audio Pipe Stream** (Use this in bot) | `/api/stream/kJQP7kiw5Fk` |
| `GET` | `/api/direct-url/:id` | Deciphered direct audio playback link | `/api/direct-url/kJQP7kiw5Fk` |
| `POST` | `/api/refresh-session` | Re-initializes InnerTube session & resets proxies | `/api/refresh-session` |

---

## 🤖 Yukki Music Bot (Python) Me Kaise Integrate Karein?

Apne Yukki Music Bot ya kisi bhi PyTgCalls bot ke andar stream function me YouTube ke direct extractor ki jagah is Stream API ka URL pass karein:

```python
# In your Yukki Music stream handler / player:
STREAM_API_URL = "http://YOUR_SERVER_IP:3000"

async def play_music(chat_id, video_id, title):
    # Direct piped audio stream from your Anti-Ban API:
    stream_url = f"{STREAM_API_URL}/api/stream/{video_id}?title={title}"
    
    # Pass stream_url to PyTgCalls:
    await call.play(
        chat_id,
        stream_url
    )
```

Ab Telegram Bot ko YouTube ko direct hit karne ki zaroorat hi nahi hai, aur IP Ban ka problem permanently solve ho jaata hai!
