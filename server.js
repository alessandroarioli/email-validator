/**
 * Email Validator — SMTP Probe Backend
 * Node.js + Express, no external SMTP libraries needed.
 * Uses Node's built-in `dns` and `net` modules.
 */

const express = require('express');
const cors    = require('cors');
const dns     = require('dns').promises;
const net     = require('net');

const app  = express();
const PORT = process.env.PORT || 3322;

app.use(cors());
app.use(express.json());

// ── helpers ──────────────────────────────────────────────────────────────────

function isValidSyntax(email) {
    // RFC 5322 simplified
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

const DISPOSABLE_DOMAINS = new Set([
    'mailinator.com','guerrillamail.com','tempmail.com','throwaway.email',
    'yopmail.com','sharklasers.com','guerrillamailblock.com','grr.la',
    'guerrillamail.info','guerrillamail.biz','guerrillamail.de',
    'guerrillamail.net','guerrillamail.org','spam4.me','trashmail.com',
    'trashmail.me','trashmail.net','dispostable.com','mailnull.com',
    'maildrop.cc','10minutemail.com','10minutemail.net','tempinbox.com',
    'fakeinbox.com','mailnesia.com','spamgourmet.com','mytrashmail.com',
    'spamfree24.org','discard.email','spamthisplease.com','getonemail.com',
    'tempr.email','zetmail.com','getnada.com','mailsac.com','mohmal.com',
    'tempail.com','temp-mail.org','temp-mail.io','emailondeck.com',
]);

const COMMON_DOMAINS = ['gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com'];

function suggestTypoFix(email) {
    const [local, domain] = email.split('@');
    if (!domain) return null;
    let best = null, bestDist = 3;
    for (const d of COMMON_DOMAINS) {
        const dist = levenshteinDist(domain.toLowerCase(), d);
        if (dist > 0 && dist < bestDist) {
            bestDist = dist;
            best = `${local}@${d}`;
        }
    }
    return best;
}

function levenshteinDist(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
        Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i-1] === b[j-1]
                ? dp[i-1][j-1]
                : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
}

// ── SMTP probe ────────────────────────────────────────────────────────────────

function smtpProbe(mxHost, email) {
    return new Promise((resolve) => {
        const TIMEOUT = 8000;
        let result = { connected: false, accepted: null, greeting: '', log: [] };
        let buffer = '';
        let stage = 0;
        let timer;

        const done = (accepted, note) => {
            clearTimeout(timer);
            socket.destroy();
            result.accepted = accepted;
            if (note) result.log.push(note);
            resolve(result);
        };

        const socket = net.createConnection({ host: mxHost, port: 25 });

        timer = setTimeout(() => done(null, 'TIMEOUT'), TIMEOUT);

        socket.on('connect', () => { result.connected = true; });

        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\r\n');
            buffer = lines.pop(); // keep incomplete line

            for (const line of lines) {
                if (!line) continue;
                result.log.push(`← ${line}`);
                const code = parseInt(line.slice(0, 3), 10);

                if (stage === 0 && code === 220) {
                    result.greeting = line;
                    stage = 1;
                    const cmd = `EHLO mail-validator.check\r\n`;
                    result.log.push(`→ ${cmd.trim()}`);
                    socket.write(cmd);
                } else if (stage === 1 && (code === 250 || code === 220)) {
                    if (line.slice(3, 4) !== '-') { // last 250 line
                        stage = 2;
                        const cmd = `MAIL FROM:<check@mail-validator.check>\r\n`;
                        result.log.push(`→ ${cmd.trim()}`);
                        socket.write(cmd);
                    }
                } else if (stage === 2 && code === 250) {
                    stage = 3;
                    const cmd = `RCPT TO:<${email}>\r\n`;
                    result.log.push(`→ ${cmd.trim()}`);
                    socket.write(cmd);
                } else if (stage === 3) {
                    if (code === 250 || code === 251) return done(true, `✅ Mailbox accepted (${code})`);
                    if (code === 550 || code === 551 || code === 553) return done(false, `❌ Mailbox rejected (${code})`);
                    if (code === 450 || code === 451 || code === 452) return done(null, `⚠ Greylisted / temp failure (${code})`);
                    if (code === 421) return done(null, `⚠ Server busy (${code})`);
                    if (code === 554) return done(false, `❌ Transaction failed (${code})`);
                    return done(null, `? Unexpected code ${code}`);
                } else if (code >= 500 && stage < 3) {
                    return done(null, `⚠ Server rejected handshake (${code})`);
                }
            }
        });

        socket.on('error', (err) => done(null, `⚠ Connection error: ${err.message}`));
        socket.on('close', () => { if (result.accepted === null && !result.log.some(l => l.includes('TIMEOUT'))) done(null, 'Connection closed early'); });
    });
}

// ── Route ─────────────────────────────────────────────────────────────────────

app.post('/validate', async (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Missing email' });
    }

    const trimmed = email.trim().toLowerCase();
    const response = {
        email: trimmed,
        checks: {
            syntax: false,
            disposable: false,
            mxExists: false,
            smtpProbe: null,   // true | false | null (inconclusive)
        },
        mx: [],
        smtpLog: [],
        suggestion: null,
        verdict: 'unknown',   // valid | invalid | risky | unknown
        confidence: 0,
    };

    // 1. Syntax
    if (!isValidSyntax(trimmed)) {
        response.checks.syntax = false;
        response.verdict = 'invalid';
        response.confidence = 99;
        response.suggestion = suggestTypoFix(trimmed);
        return res.json(response);
    }
    response.checks.syntax = true;

    const domain = trimmed.split('@')[1];

    // 2. Disposable check
    response.checks.disposable = DISPOSABLE_DOMAINS.has(domain);

    // 3. Typo suggestion
    response.suggestion = suggestTypoFix(trimmed);

    // 4. MX lookup
    try {
        const mxRecords = await dns.resolveMx(domain);
        mxRecords.sort((a, b) => a.priority - b.priority);
        response.mx = mxRecords.slice(0, 3).map(r => ({ host: r.exchange, priority: r.priority }));
        response.checks.mxExists = mxRecords.length > 0;
    } catch {
        response.checks.mxExists = false;
        response.verdict = 'invalid';
        response.confidence = 90;
        return res.json(response);
    }

    if (!response.checks.mxExists) {
        response.verdict = 'invalid';
        response.confidence = 90;
        return res.json(response);
    }

    // 5. SMTP probe (try top 2 MX hosts)
    for (const mx of response.mx.slice(0, 2)) {
        const probe = await smtpProbe(mx.host, trimmed);
        response.smtpLog = probe.log;
        if (probe.accepted !== null) {
            response.checks.smtpProbe = probe.accepted;
            break;
        }
    }

    // 6. Verdict + confidence
    if (response.checks.disposable) {
        response.verdict = 'risky';
        response.confidence = 85;
    } else if (response.checks.smtpProbe === true) {
        response.verdict = 'valid';
        response.confidence = 95;
    } else if (response.checks.smtpProbe === false) {
        response.verdict = 'invalid';
        response.confidence = 92;
    } else {
        // SMTP inconclusive (greylisted, catch-all, etc.)
        response.verdict = 'unknown';
        response.confidence = 60;
    }

    res.json(response);
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`✅ Email validator running on http://localhost:${PORT}`));

