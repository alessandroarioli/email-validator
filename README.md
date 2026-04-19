# 📧 Email Validator

A real **SMTP-level** email validation tool. Unlike basic regex or syntax checkers, this tool connects directly to the target mail server and probes if a mailbox actually exists.

## How it works

1. **Syntax check** — RFC 5322 regex validation
2. **Disposable domain detection** — blocklist of 40+ known temp-mail providers
3. **Typo suggestion** — detects common misspellings (`gmial.com` → `gmail.com`)
4. **MX record lookup** — verifies the domain can receive email
5. **SMTP probe** — real TCP handshake: `EHLO → MAIL FROM → RCPT TO`
   - `250` response → mailbox **accepted** ✅
   - `550` response → mailbox **rejected** ❌
   - `4xx` / no response → **inconclusive** ❓

## Stack

- **Backend** — Node.js + Express (no external SMTP libraries, uses built-in `dns` + `net`)
- **Frontend** — Vanilla JS, single HTML file

## Getting started

### Local development
```bash
npm install
npm start
```
Then open `index.html` in your browser. The backend runs on `http://localhost:3322`.

### Deploy backend to Koyeb (free)
1. Go to [koyeb.com](https://koyeb.com) → **Create Web Service**
2. Connect your GitHub repo `alessandroarioli/email-validator`
3. Set **Run command**: `node server.js`
4. Set **Port**: `8000` (Koyeb default) — the app reads `process.env.PORT` automatically
5. Deploy — your backend will be live at `https://email-validator-alessandroarioli.koyeb.app`

### Deploy frontend to GitHub Pages
1. Go to your GitHub repo → **Settings → Pages**
2. Set source to **Deploy from branch → main → / (root)**
3. Your frontend will be live at `https://alessandroarioli.github.io/email-validator`

## ⚠️ Notes

- Some providers (Gmail, Outlook) use **catch-all** or **greylisting** which may return inconclusive results
- Port 25 may be **blocked by your ISP** on residential connections — works best on a VPS/server
- This tool is intended for **legitimate validation** use cases only

## License

MIT

