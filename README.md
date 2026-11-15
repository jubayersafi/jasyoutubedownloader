# JAS — Standalone Web Version (Netlify + Backend URL Ready)

This package can run together on a single Node.js server **or** split across **Netlify (Frontend)** + **Render / Railway / Fly.io (Backend)**!

---

## Option A: Netlify (Frontend) + Render / Railway (Backend)

### Step 1: Deploy the Backend (`server.js` + `Dockerfile`)
1. Upload the `jas-web-version` folder to GitHub (or directly to **Render.com** / **Railway.app**).
2. Create a **New Web Service** choosing **Docker** (the included `Dockerfile` installs Node 20 + `ffmpeg` automatically).
3. Optional environment variables:
   - `ALLOWED_ORIGIN`: Your Netlify URL (e.g. `https://your-app.netlify.app`) or `*` (default)
   - `YOUTUBE_COOKIES`: Optional YouTube cookie header string
4. Copy your live Backend URL (e.g. `https://jas-backend.onrender.com`).

### Step 2: Deploy the Frontend (`public/` folder) to Netlify
1. Open `public/config.js` and paste your Backend URL:
   ```js
   window.JAS_BACKEND_URL = "https://jas-backend.onrender.com";
   ```
2. Drag and drop the **`public/`** folder onto **Netlify Drop** (`https://app.netlify.com/drop`), **or** connect your Git repo (it automatically uses `netlify.toml` with `publish = "public"`).
3. Done! Visitors on your Netlify link can download 4K, 1080p HD, 720p HD, and MP3 Audio seamlessly through your Backend URL. *(Users can also test/override the Backend URL in the **Backend & Session** modal.)*

---

## Option B: Run Everything Together Locally or on One VPS
```bash
npm install
npm start
```
Open `http://localhost:3000` (keep `window.JAS_BACKEND_URL = ""`).
