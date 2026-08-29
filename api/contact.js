// api/contact.js
import admin from 'firebase-admin';

// ──────────────────────────────────────────────
// Initialize Firebase Admin SDK (server-side only)
// Defensive: if credentials are missing/malformed, `db` stays
// undefined instead of crashing the whole function on every request.
// ──────────────────────────────────────────────
let db;

if (!admin.apps.length) {
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
    console.error('❌ Firebase Admin initialization error:', error);
  }
}

if (admin.apps.length) {
  try {
    db = admin.firestore();
  } catch (error) {
    console.error('❌ Firestore client error:', error);
  }
}

// ──────────────────────────────────────────────
// Rate limit config (from .env, with sane fallbacks)
// ──────────────────────────────────────────────
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 3;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 24 * 60 * 60 * 1000; // 24h
const RATE_LIMIT_COOLDOWN_MS = parseInt(process.env.RATE_LIMIT_COOLDOWN_MS, 10) || 30 * 1000; // 30s between sends

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
 * Checks whether an IP has exceeded its message quota.
 * Returns { allowed: true } or { allowed: false, error: '...' }.
 * If Firestore isn't available, rate limiting is skipped (logged, not enforced) —
 * serverless functions don't reliably share memory across invocations, so
 * without a persistent store there's nowhere safe to count from.
 */
async function checkRateLimit(ip) {
  if (!db) {
    console.warn('⚠️ Skipping rate limit check — Firestore not available.');
    return { allowed: true };
  }

  const docId = sanitizeForDocId(ip);
  const ref = db.collection('rate_limits').doc(docId);

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
        error: `You've reached the limit of ${RATE_LIMIT_MAX} messages per day. Please try again tomorrow, or email adventureromblon@yahoo.com directly.`,
      };
    }

    // Record this attempt (store only the trimmed, recent list so the doc never grows unbounded)
    recent.push(now);
    await ref.set({ timestamps: recent }, { merge: false });

    return { allowed: true };
  } catch (error) {
    console.error('❌ Rate limit check error:', error);
    // Fail open — a rate-limit bug shouldn't block legitimate messages
    return { allowed: true };
  }
}

/**
 * Heuristic gibberish/spam-text detector — no dictionary or external API,
 * just pattern checks for keyboard-mashing like "hrgbalhrf alkefawe":
 *  - words with no vowels at all (beyond a short/allowed length)
 *  - words with a long run of consecutive consonants (unusual in real English)
 * If a large share of the message's words look like this, reject it.
 */
function looksLikeGibberish(text) {
  const words = text
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z]/g, ''))
    .filter((w) => w.length > 0);

  if (words.length === 0) return true;

  let suspicious = 0;
  let checkable = 0;

  for (const word of words) {
    if (word.length < 3) continue; // too short to judge (e.g. "hi", "ok", "a")
    checkable++;

    const hasVowel = /[aeiouAEIOU]/.test(word);
    const longConsonantRun = /[^aeiouAEIOU]{5,}/.test(word); // 5+ consonants in a row

    if (!hasVowel || longConsonantRun) {
      suspicious++;
    }
  }

  // Not enough real content to judge either way — let it through
  if (checkable === 0) return false;

  return suspicious / checkable > 0.4; // more than 40% of words look like keyboard mashing
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

    // Reject keyboard-mashing / gibberish messages
    if (looksLikeGibberish(message)) {
      return res.status(400).json({
        error: 'Your message doesn\'t look like readable text — please rewrite it so Bryan can understand what you need.',
      });
    }

    // ──────────────────────────────────────────────
    // Rate limit: max N messages per IP per day, plus a short cooldown
    // between individual sends. Checked after validation so obviously
    // broken submissions don't burn a person's daily quota.
    // ──────────────────────────────────────────────
    const clientIp = getClientIp(req);
    const rateLimitResult = await checkRateLimit(clientIp);
    if (!rateLimitResult.allowed) {
      return res.status(429).json({ error: rateLimitResult.error });
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
