// api/contact.js
import admin from 'firebase-admin';

// ──────────────────────────────────────────────
// Initialize Firebase Admin SDK (server-side only)
// This is now defensive: if credentials are missing or malformed,
// `db` stays undefined instead of crashing the whole function on
// every request. The Firestore write later checks for `db` before
// using it, so email delivery still works even if Firebase is down
// or misconfigured.
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

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
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

    // Validate name
    if (name.length < 2 || name.length > 80) {
      return res.status(400).json({
        error: 'Name must be 2-80 characters.',
      });
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: 'Please enter a valid email address.',
      });
    }

    // Validate message
    if (message.length < 5 || message.length > 2000) {
      return res.status(400).json({
        error: 'Message must be 5-2000 characters.',
      });
    }

    // ──────────────────────────────────────────────
    // 1️⃣ Save to Firestore (for admin panel)
    // Only runs if Firebase Admin actually initialized successfully.
    // ──────────────────────────────────────────────
    if (db) {
      try {
        await db.collection('contact_messages').add({
          name: name.trim(),
          email: email.trim(),
          reason: reason || 'Something else',
          message: message.trim(),
          status: 'new',
          source: 'website_contact_form',
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log('✅ Message saved to Firestore');
      } catch (firestoreError) {
        console.error('❌ Firestore write error:', firestoreError);
        // Don't fail the whole request if Firestore fails
        // The email notification is more important for the user
      }
    } else {
      console.warn('⚠️ Skipping Firestore save — Firebase Admin was not initialized.');
    }

    // ──────────────────────────────────────────────
    // 2️⃣ Send email notification via FormSubmit
    // ──────────────────────────────────────────────
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
        // Don't fail if email fails - the data may already be in Firestore
      } else {
        console.log('✅ Email notification sent');
      }
    } catch (emailError) {
      console.error('❌ Email error:', emailError);
      // Don't fail the whole request
    }

    // ──────────────────────────────────────────────
    // 3️⃣ Return success response
    // ──────────────────────────────────────────────
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
