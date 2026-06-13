# 💬 Pulse Messenger — Flask + Supabase + Vercel

A professional, real-time messenger (like Messenger) built for cloud deployment:

| Part | Tech | Deploy to |
|------|------|-----------|
| **Backend** | Flask + Flask-SocketIO + SQLAlchemy | **Render** |
| **Frontend** | Static HTML / CSS / JS | **Vercel** |
| **Database** | PostgreSQL | **Supabase** |
| **Media storage** | Photos / videos / files | **Supabase Storage** |

### ✨ Features
- 🔐 Secure accounts (register / login, hashed passwords + JWT)
- 💬 Real-time chat (Socket.IO)
- 👥 Add friends (search → request → accept)
- 📷 Photos · 🎥 videos · 📎 files (up to 50 MB)
- 🟢 Online presence · ✍️ typing indicator · ✓ "Seen" receipts
- 🔔 In-app notifications · 📱 mobile responsive
- 🧹 **Daily auto-clearing chats** — every chat resets to empty each new day

```
New folder (2)/
├── backend/          → Flask API (deploy to Render)
│   ├── app.py        → REST + Socket.IO
│   ├── db.py         → SQLAlchemy models & queries
│   ├── storage.py    → Supabase Storage (local fallback)
│   ├── requirements.txt
│   ├── render.* / Procfile / runtime.txt
│   ├── schema.sql    → (reference only — tables auto-create)
│   ├── daily_clear.sql → daily auto-clear (pg_cron) reference
│   └── test_e2e.py   → end-to-end test
├── frontend/         → Static site (deploy to Vercel)
│   ├── index.html · styles.css · app.js
│   ├── config.js     → ⭐ set your backend URL here
│   └── vercel.json
├── render.yaml       → one-click Render blueprint
└── _node-version/    → (the earlier all-in-one Node.js version, archived)
```

---

## 🧪 Run locally first (recommended)

You can run everything on your PC before deploying. It uses SQLite + local file
storage automatically, so you need **nothing** else installed.

```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env      # the defaults already work for local dev
python app.py               # API at http://localhost:5000
```

Then in another terminal serve the frontend (leave `frontend/config.js`
`backendUrl: ""` for local — it will use `http://localhost:5000` automatically
if you open the frontend from the same machine). The simplest way:

```powershell
cd frontend
python -m http.server 5500
```

> ⚠️ Important: when running locally with the frontend on a **different port**
> (5500) than the backend (5000), set `backendUrl: "http://localhost:5000"` in
> `frontend/config.js` so the browser knows where the API is. Then open
> <http://localhost:5500>.

Run the automated test (with the backend running):
```powershell
cd backend
.venv\Scripts\python test_e2e.py
```

---

## 🚀 Deploy to the cloud

### 1️⃣ Push this project to GitHub
Render and Vercel both deploy from a Git repository.
```powershell
cd "New folder (2)"
git init
git add .
git commit -m "Pulse Messenger"
# create an empty repo on github.com, then:
git remote add origin https://github.com/YOUR-NAME/pulse-messenger.git
git branch -M main
git push -u origin main
```

### 2️⃣ Supabase — database + media storage
1. Create a project at <https://supabase.com> (free tier is fine).
2. **Database connection string:** Project → **Settings → Database** →
   *Connection string* → **URI**. Copy it and replace `[YOUR-PASSWORD]` with your
   DB password. This is your `DATABASE_URL`.
   *(Tables are created automatically the first time the backend starts — you
   don't need to run any SQL.)*
3. **Service key:** Project → **Settings → API** → copy the **`service_role`**
   key. This is `SUPABASE_SERVICE_ROLE_KEY`. Also copy the **Project URL**
   (`https://xxxx.supabase.co`) — that's `SUPABASE_URL`.
4. **Storage bucket:** Project → **Storage** → **New bucket** → name it
   **`media`** → toggle **Public bucket = ON** → create.

### 3️⃣ Render — the Flask backend
**Option A — Blueprint (easiest):** In Render → **New + → Blueprint**, connect your
repo. It reads `render.yaml` and asks you to fill in the secret values.

**Option B — manual:** New + → **Web Service** → connect repo, then set:
- **Root Directory:** `backend`
- **Build Command:** `pip install -r requirements.txt`
- **Start Command:** `gunicorn -k eventlet -w 1 --bind 0.0.0.0:$PORT app:app`
- **Health Check Path:** `/api/health`

Add these **Environment Variables** (either option):

| Key | Value |
|-----|-------|
| `DATABASE_URL` | your Supabase URI from step 2️⃣ |
| `SUPABASE_URL` | `https://YOUR-REF.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | your service_role key |
| `SUPABASE_BUCKET` | `media` |
| `JWT_SECRET` | any long random string |
| `SOCKETIO_ASYNC_MODE` | `eventlet` |
| `FRONTEND_ORIGIN` | your Vercel URL (add after step 4️⃣) |
| `PYTHON_VERSION` | `3.11.9` |

Deploy. When it's live you'll get a URL like
`https://pulse-messenger-api.onrender.com`. Open `…/api/health` — it should show
`{"status":"ok"}`.

> 💤 Render's free tier sleeps after inactivity, so the **first** request after a
> while may take ~30–50 seconds to wake up. That's normal.

### 4️⃣ Vercel — the frontend
1. Edit **`frontend/config.js`** and set your Render URL:
   ```js
   window.PULSE_CONFIG = { backendUrl: "https://pulse-messenger-api.onrender.com" };
   ```
   Commit & push this change.
2. In Vercel → **Add New → Project** → import your repo → set
   **Root Directory = `frontend`** → **Deploy**. (Framework preset: *Other*.)
3. You'll get a URL like `https://pulse-messenger.vercel.app`.

### 5️⃣ Connect them (CORS)
Back in **Render**, set `FRONTEND_ORIGIN` to your exact Vercel URL
(e.g. `https://pulse-messenger.vercel.app`) and let it redeploy. Done! 🎉

---

## 👫 Using it
1. Open your Vercel URL and **Sign up**.
2. Have a friend sign up too (or use a second browser / phone).
3. Search their username → **Add** → they **Accept** in the *Requests* tab.
4. Start chatting in real time — text, photos, videos, and files. 🎉

---

## 🧹 Daily auto-clearing chats

Every chat is automatically wiped at **midnight Philippine time (UTC+8)** so each
new day starts empty. This is handled inside Supabase (already set up), so it runs
reliably even while the Render backend is asleep. Two daily `pg_cron` jobs do it:

| Job | What it deletes |
|-----|-----------------|
| `clear-daily-chats` | all **messages** from previous days |
| `clear-daily-media` | all **uploaded files** (photos/videos/files) from previous days |

- The media files are removed from Supabase Storage by the **`clear-media`** Edge
  Function (source: [`supabase/functions/clear-media/index.ts`](supabase/functions/clear-media/index.ts)),
  triggered daily via `pg_net`.
- **What stays:** your account and your friends list.
- Full reference & management commands: [`backend/daily_clear.sql`](backend/daily_clear.sql).

Quick management (run in the Supabase SQL Editor):
```sql
-- clear messages right now:   select public.clear_daily_chats();
-- see scheduled jobs:         select jobid, jobname, schedule, active from cron.job;
-- turn message clearing OFF:  select cron.unschedule('clear-daily-chats');
-- turn media clearing OFF:    select cron.unschedule('clear-daily-media');
```

---

## 🔧 Environment variables reference

| Variable | Used for | Local default |
|----------|----------|---------------|
| `DATABASE_URL` | Database connection | `sqlite:///data/local.db` |
| `JWT_SECRET` | Signing login tokens | random (set in prod!) |
| `FRONTEND_ORIGIN` | Allowed CORS origin(s) | `*` |
| `SUPABASE_URL` | Storage uploads | empty → local `./uploads` |
| `SUPABASE_SERVICE_ROLE_KEY` | Storage auth | empty |
| `SUPABASE_BUCKET` | Storage bucket name | `media` |
| `SOCKETIO_ASYNC_MODE` | Real-time engine | `threading` (use `eventlet` in prod) |

Built with ❤️ using Flask, Socket.IO, SQLAlchemy, Supabase, Render & Vercel.
