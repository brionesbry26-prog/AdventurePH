// api/contact.js
import admin from 'firebase-admin';

// ──────────────────────────────────────────────
// Initialize Firebase Admin SDK (server-side only)
// Defensive: if credentials are missing/malformed, `db` stays
// undefined instead of crashing the whole function on every request.
// ──────────────────────────────────────────────
let db;

if (!admin.apps.length) {
  const missingEnvVars = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']
    .filter((key) => !process.env[key]);

  if (missingEnvVars.length > 0) {
    // This is almost always why rate limiting silently does nothing in
    // production: without these three set on the host (Vercel/etc,
    // for BOTH Production and Preview environments), `db` stays
    // undefined below and every rate-limit check fails open.
    console.error(
      `❌ Firebase env vars missing: ${missingEnvVars.join(', ')}. ` +
      'Rate limiting (per-IP and per-email) will be DISABLED until these are set and the app is redeployed.'
    );
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
    console.log('✅ Firebase Admin initialized successfully');
  } catch (error) {
    console.error('❌ Firebase Admin initialization error — rate limiting will be DISABLED:', error);
  }
}

if (admin.apps.length) {
  try {
    db = admin.firestore();
  } catch (error) {
    console.error('❌ Firestore client error — rate limiting will be DISABLED:', error);
  }
}

// If true, requests are REJECTED when Firestore is unreachable instead
// of being let through. Off by default (fail-open) so a database outage
// doesn't take down your contact form entirely — flip this on if you'd
// rather block all messages than risk unlimited spam getting through.
const RATE_LIMIT_FAIL_CLOSED = process.env.RATE_LIMIT_FAIL_CLOSED === 'true';

// ──────────────────────────────────────────────
// Rate limit config (from .env, with sane fallbacks)
// ──────────────────────────────────────────────
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 3;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 24 * 60 * 60 * 1000; // 24h
const RATE_LIMIT_COOLDOWN_MS = parseInt(process.env.RATE_LIMIT_COOLDOWN_MS, 10) || 30 * 1000; // 30s between sends

// ──────────────────────────────────────────────
// Message content limits — mirrors client-side limits in contact.html.
// Keep these two files in sync if you change one.
// ──────────────────────────────────────────────
const MIN_WORDS = 3;
const MAX_WORDS = 300;
const MIN_VALID_WORD_RATIO = 0.6; // at least 60% of words must look "real"

// ──────────────────────────────────────────────
// Blocklist — profanity / violent / spam-trigger terms across
// English, Tagalog, and Bisaya. NOT exhaustive — this is a starter
// list intended as a baseline spam/abuse filter, not full moderation
// coverage. For production-grade coverage, swap this for a maintained
// package (e.g. "leo-profanity", "bad-words", or a hosted moderation
// API) instead of hand-maintaining a word list — and keep this list
// in sync with the copy in contact.html if you do keep it.
// ──────────────────────────────────────────────
const BLOCKLIST = [
  // english — profanity / slurs / violent threats (starter set)
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'whore',
  'nigger', 'faggot', 'retard',
  'kill you', 'kill him', 'kill her', 'i will kill', 'gonna kill',
  'shoot up', 'shoot you', 'bomb the', 'blow up', 'i have a gun',
  'rape you', 'terrorist attack',
  // tagalog — profanity (starter set)
  'puta', 'pota', 'putax', 'putangina', 'putang ina', 'putanginamo',
  'gago', 'gaga', 'tangina', 'tang ina', 'tarantado', 'ulol', 'bobo',
  'leche', 'punyeta', 'walang hiya', 'lintik', 'bwisit', 'buwisit',
  'hayop ka', 'siraulo', 'inutil',
  // bisaya / cebuano — profanity (starter set)
  'yawa', 'buang', 'bilat', 'piste', 'pisti', 'atay', 'animal ka',
  'pesteng yawa', 'baboy ka', 'ilo ka',
];

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // x-forwarded-for can be a comma-separated list; the first entry is the original client
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function sanitizeForDocId(str) {
  // Firestore doc IDs can't contain '/', and we want something filesystem/URL-safe
  return str.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/**
 * Normalizes an email for use as a rate-limit key: lowercased and
 * trimmed, so "Bob@Gmail.com" and "bob@gmail.com " count as the same
 * sender. This intentionally does NOT try to canonicalize Gmail's
 * dot/plus-addressing tricks (bob.smith+x@gmail.com vs bobsmith@gmail.com)
 * — that's a deeper anti-abuse feature, not a quick add.
 */
function normalizeEmailForRateLimit(email) {
  return (email || '').trim().toLowerCase();
}

/**
 * Checks whether a given key (an IP address, or an email address) has
 * exceeded its message quota within the rolling window, and enforces a
 * short cooldown between individual sends from that same key.
 * `collection` keeps IP-based and email-based counters in separate
 * Firestore collections so a shared IP (e.g. an office network) doesn't
 * interfere with per-email counting and vice versa.
 * Returns { allowed: true } or { allowed: false, error: '...' }.
 * If Firestore isn't available, rate limiting is skipped (logged, not enforced) —
 * serverless functions don't reliably share memory across invocations, so
 * without a persistent store there's nowhere safe to count from.
 */
async function checkRateLimitForKey(key, collection, label) {
  if (!db) {
    if (RATE_LIMIT_FAIL_CLOSED) {
      console.error(`❌ Rejecting request — ${label} rate limit can't be checked (Firestore unavailable) and RATE_LIMIT_FAIL_CLOSED is on.`);
      return { allowed: false, error: 'Message sending is temporarily unavailable. Please try emailing adventureromblon@yahoo.com directly.' };
    }
    console.warn(`⚠️ Skipping ${label} rate limit check — Firestore not available. (This message is NOT being counted or limited.)`);
    return { allowed: true };
  }

  const docId = sanitizeForDocId(key);
  const ref = db.collection(collection).doc(docId);

  try {
    const snap = await ref.get();
    const now = Date.now();
    const existing = (snap.exists && snap.data().timestamps) || [];

    // Keep only timestamps still inside the rolling window
    const recent = existing.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);

    if (recent.length > 0) {
      const lastSent = Math.max(...recent);
      if (now - lastSent < RATE_LIMIT_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((RATE_LIMIT_COOLDOWN_MS - (now - lastSent)) / 1000);
        return {
          allowed: false,
          error: `Please wait ${waitSeconds}s before sending another message.`,
        };
      }
    }

    if (recent.length >= RATE_LIMIT_MAX) {
      return {
        allowed: false,
        error: label === 'email'
          ? `This email address has reached the limit of ${RATE_LIMIT_MAX} messages per day. Please try again tomorrow, or email adventureromblon@yahoo.com directly.`
          : `You've reached the limit of ${RATE_LIMIT_MAX} messages per day. Please try again tomorrow, or email adventureromblon@yahoo.com directly.`,
      };
    }

    // Record this attempt (store only the trimmed, recent list so the doc never grows unbounded)
    recent.push(now);
    await ref.set({ timestamps: recent }, { merge: false });

    console.log(`✅ ${label} rate limit OK for "${key}" — ${recent.length}/${RATE_LIMIT_MAX} used today.`);
    return { allowed: true };
  } catch (error) {
    console.error(`❌ Rate limit check error (${label}):`, error);
    // Fail open — a rate-limit bug shouldn't block legitimate messages
    return { allowed: true };
  }
}

/** Per-IP limit: max RATE_LIMIT_MAX messages/day from the same IP address. */
async function checkRateLimitByIp(ip) {
  return checkRateLimitForKey(ip, 'rate_limits', 'ip');
}

/** Per-email limit: max RATE_LIMIT_MAX messages/day from the same email address. */
async function checkRateLimitByEmail(email) {
  return checkRateLimitForKey(normalizeEmailForRateLimit(email), 'rate_limits_email', 'email');
}

/**
 * Normalizes text for blocklist matching: lowercases, undoes common
 * leetspeak substitutions (0->o, 1->i, 3->e, 4/@->a, 5/$->s), and
 * strips punctuation so simple obfuscation ("f.u.c.k", "sh1t") doesn't
 * slip past the filter.
 */
function normalizeForBlocklist(text) {
  return text
    .toLowerCase()
    .replace(/[0]/g, 'o')
    .replace(/1/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns true if the message contains a blocked term — profanity,
 * violent threats, or common spam trigger phrases.
 *
 * Single-word terms (no space) are matched with word boundaries
 * (\bterm\b), NOT a raw substring — a plain .includes('puta') would
 * also match "computation" (com-PUTA-tion), which is a real false
 * positive risk for short profanity words. Word boundaries mean the
 * term has to stand on its own, so "pota ka" and "putanginamo" still
 * match (the term sits at a real word edge) but "computation" doesn't.
 *
 * Multi-word phrases (contain a space) are matched by substring on the
 * normalized text, since they're specific enough not to false-positive.
 *
 * Also checks a "collapsed" version of the text (spaces between single
 * letters removed) to catch spaced-out obfuscation like "p u t a".
 */
function containsBlockedTerm(text) {
  const normalized = normalizeForBlocklist(text);
  const collapsed = normalized.replace(/\b(\w)\s+(?=\w\b)/g, '$1');

  for (const term of BLOCKLIST) {
    if (term.includes(' ')) {
      if (normalized.includes(term) || collapsed.includes(term.replace(/\s+/g, ''))) {
        return true;
      }
    } else {
      const boundaryRegex = new RegExp(`\\b${escapeRegExp(term)}\\b`);
      if (boundaryRegex.test(normalized) || boundaryRegex.test(collapsed)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Per-word "looks like a real word" check — language-agnostic.
 * English, Tagalog, and Bisaya are all Latin-alphabet, vowel-rich
 * languages: real words rarely go 5+ consonants in a row, contain zero
 * vowels, or repeat the same character 4+ times in a row. Each word is
 * judged individually; the message needs a real majority of
 * individually-valid words to pass — not just a good average.
 *
 * Also enforces word-count bounds and runs the blocklist check first,
 * since a blocked term is an instant reject regardless of word shape.
 *
 * Returns { ok: true, wordCount } or { ok: false, reason, wordCount? }
 * where reason is one of: 'blocked' | 'too_short' | 'too_long' | 'gibberish'.
 */
function analyzeMessage(rawText) {
  const text = (rawText || '').trim();

  if (containsBlockedTerm(text)) {
    return { ok: false, reason: 'blocked' };
  }

  const rawWords = text.split(/\s+/).filter(Boolean);
  const words = rawWords
    .map((w) => w.replace(/[^a-zA-Z'-]/g, ''))
    .filter((w) => w.length > 0);

  if (words.length < MIN_WORDS) {
    return { ok: false, reason: 'too_short', wordCount: words.length };
  }
  if (words.length > MAX_WORDS) {
    return { ok: false, reason: 'too_long', wordCount: words.length };
  }

  let validCount = 0;
  let judged = 0;

  for (const word of words) {
    if (word.length < 2) continue; // too short to judge (e.g. "a", "i", "sa")
    judged++;

    const hasVowel = /[aeiouAEIOU]/.test(word);
    const longConsonantRun = /[^aeiouAEIOU]{5,}/.test(word);
    const repeatedChar = /(.)\1{3,}/.test(word); // "aaaa", "kkkk"

    if (hasVowel && !longConsonantRun && !repeatedChar) {
      validCount++;
    }
  }

  // Not enough judgeable words (e.g. message is all 1-letter tokens) — treat as gibberish
  if (judged === 0) {
    return { ok: false, reason: 'gibberish', wordCount: words.length };
  }

  const ratio = validCount / judged;
  if (ratio < MIN_VALID_WORD_RATIO) {
    return { ok: false, reason: 'gibberish', wordCount: words.length, ratio };
  }

  return { ok: true, wordCount: words.length };
}

function errorMessageForAnalysis(analysis) {
  switch (analysis.reason) {
    case 'blocked':
      return "That message can't be sent — please remove any offensive or threatening language.";
    case 'too_short':
      return `Please write at least ${MIN_WORDS} real words.`;
    case 'too_long':
      return `Please keep your message under ${MAX_WORDS} words.`;
    case 'gibberish':
    default:
      return 'Your message doesn\'t look like readable text — please rewrite it so Bryan can understand what you need.';
  }
}

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, email, reason, message } = req.body;

    // Validate required fields
    if (!name || !email || !message) {
      return res.status(400).json({
        error: 'Please fill in your name, email, and message.',
      });
    }

    if (name.length < 2 || name.length > 80) {
      return res.status(400).json({
        error: 'Name must be 2-80 characters.',
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: 'Please enter a valid email address.',
      });
    }

    if (message.length < 5 || message.length > 2000) {
      return res.status(400).json({
        error: 'Message must be 5-2000 characters.',
      });
    }

    // Name/email fields also run through the blocklist — a slur in the
    // name field is just as much abuse as one in the message.
    if (containsBlockedTerm(name) || containsBlockedTerm(reason || '')) {
      return res.status(400).json({
        error: "That submission can't be sent — please remove any offensive or threatening language.",
      });
    }

    // Word-count bounds + per-word gibberish check + blocklist on the message
    const analysis = analyzeMessage(message);
    if (!analysis.ok) {
      return res.status(400).json({ error: errorMessageForAnalysis(analysis) });
    }

    // ──────────────────────────────────────────────
    // Rate limit: max RATE_LIMIT_MAX messages per day, enforced BOTH
    // per IP address and per email address, plus a short cooldown
    // between individual sends on each. Two separate limits close two
    // separate bypasses: per-IP alone lets someone burn a shared IP's
    // quota with different email addresses, and per-email alone lets
    // someone burn one IP's quota with throwaway email addresses.
    // Checked after content validation so obviously broken submissions
    // don't burn a person's daily quota.
    // ──────────────────────────────────────────────
    const clientIp = getClientIp(req);

    const ipRateLimitResult = await checkRateLimitByIp(clientIp);
    if (!ipRateLimitResult.allowed) {
      return res.status(429).json({ error: ipRateLimitResult.error });
    }

    const emailRateLimitResult = await checkRateLimitByEmail(email);
    if (!emailRateLimitResult.allowed) {
      return res.status(429).json({ error: emailRateLimitResult.error });
    }

    // 1️⃣ Save to Firestore (for admin panel)
    if (db) {
      try {
        await db.collection('contact_messages').add({
          name: name.trim(),
          email: email.trim(),
          reason: reason || 'Something else',
          message: message.trim(),
          status: 'new',
          source: 'website_contact_form',
          ip: clientIp,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log('✅ Message saved to Firestore');
      } catch (firestoreError) {
        console.error('❌ Firestore write error:', firestoreError);
      }
    } else {
      console.warn('⚠️ Skipping Firestore save — Firebase Admin was not initialized.');
    }

    // 2️⃣ Send email notification via FormSubmit
    try {
      const formSubmitResponse = await fetch(
        process.env.FORM_SUBMIT_ENDPOINT ||
          `https://formsubmit.co/ajax/${process.env.CONTACT_EMAIL || 'adventureromblon@yahoo.com'}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            name: name.trim(),
            email: email.trim(),
            reason: reason || 'Something else',
            message: message.trim(),
            _subject: `Adventure contact form: ${reason || 'General inquiry'}`,
            _template: 'table',
            _captcha: 'false',
          }),
        }
      );

      if (!formSubmitResponse.ok) {
        console.error('❌ FormSubmit error:', await formSubmitResponse.text());
      } else {
        console.log('✅ Email notification sent');
      }
    } catch (emailError) {
      console.error('❌ Email error:', emailError);
    }

    // 3️⃣ Return success response
    return res.status(200).json({
      success: true,
      message: 'Thanks — your message has been sent. Bryan will get back to you soon.',
    });
  } catch (error) {
    console.error('❌ Contact form error:', error);
    return res.status(500).json({
      error: 'Something went wrong. Please try emailing adventureromblon@yahoo.com directly.',
    });
  }
}
