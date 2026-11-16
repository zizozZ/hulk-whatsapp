const fs = require('fs');
const path = require('path');
const express = require('express');
const pino = require('pino');
const admin = require('firebase-admin');
const baileys = require('@whiskeysockets/baileys');

const makeWASocket = baileys.default || baileys.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;

let serviceAccount = null;
const keyPath = path.join(__dirname, 'serviceAccountKey.json');
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else if (fs.existsSync(keyPath)) {
  serviceAccount = require(keyPath);
} else {
  console.error('❌ Missing FIREBASE_SERVICE_ACCOUNT or serviceAccountKey.json');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const sessions = new Map();

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('01') && digits.length === 11) digits = '2' + digits;
  return digits;
}

async function getWaVersion() {
  try {
    if (typeof baileys.fetchLatestWaWebVersion === 'function') {
      const res = await baileys.fetchLatestWaWebVersion({});
      if (res?.version) return res.version;
    }
  } catch {}
  const fallback = await fetchLatestBaileysVersion();
  return fallback.version;
}

async function startWhatsAppSession(trainerId, phoneNumber, requestPairing = false, retryCount = 0) {
  const cleanPhone = normalizePhone(phoneNumber);
  const authDir = path.join(__dirname, 'auth_sessions', trainerId);

  if (requestPairing && retryCount === 0 && fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
  fs.mkdirSync(authDir, { recursive: true });

  const oldEntry = sessions.get(trainerId);
  if (oldEntry?.sock) {
    try { oldEntry.sock.end(); } catch {}
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = await getWaVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
  });

  sessions.set(trainerId, { sock, connected: false, phoneNumber: cleanPhone });

  let pairingCodeRequested = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log(`[WA ${trainerId}] connection:`, connection || '-', 'qr:', Boolean(qr));

    if (qr && requestPairing && !sock.authState.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true;
      setTimeout(async () => {
        try {
          const rawCode = await sock.requestPairingCode(cleanPhone);
          const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
          await db.collection('whatsappSessions').doc(trainerId).set(
            {
              trainerId,
              phoneNumber: cleanPhone,
              status: 'waiting_for_code',
              pairingCode: formatted,
              error: null,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          console.log(`🔑 Pairing code generated for ${trainerId}: ${formatted}`);
        } catch (err) {
          pairingCodeRequested = false;
          console.error('Pairing request failed:', err?.message || err);
        }
      }, 1000);
    }

    if (connection === 'open') {
      const connectedNum = sock.user?.id?.split(':')[0] || cleanPhone;
      sessions.set(trainerId, { sock, connected: true, phoneNumber: connectedNum });
      await db.collection('whatsappSessions').doc(trainerId).set(
        {
          trainerId,
          status: 'connected',
          pairingCode: null,
          connectedNumber: connectedNum,
          error: null,
          connectedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      console.log(`✅ WhatsApp Connected for ${trainerId} (${connectedNum})`);
    } else if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[WA ${trainerId}] closed with code:`, statusCode);
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      sessions.set(trainerId, { sock: null, connected: false, phoneNumber: cleanPhone });

      if (loggedOut) {
        fs.rmSync(authDir, { recursive: true, force: true });
        await db.collection('whatsappSessions').doc(trainerId).set(
          {
            status: 'disconnected',
            pairingCode: null,
            connectedNumber: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } else if (statusCode === DisconnectReason.restartRequired || sock.authState.creds.registered) {
        setTimeout(() => startWhatsAppSession(trainerId, cleanPhone, false, 0), 800);
      } else if (requestPairing && retryCount < 3) {
        setTimeout(() => startWhatsAppSession(trainerId, cleanPhone, true, retryCount + 1), 2000);
      } else {
        await db.collection('whatsappSessions').doc(trainerId).set(
          {
            status: 'error',
            error: 'تعذر إكمال الاتصال بواتساب، تأكد من الرقم بكود الدولة وحاول مرة أخرى.',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    }
  });
}

db.collection('whatsappSessions').onSnapshot((snap) => {
  snap.docChanges().forEach(async (change) => {
    const data = change.doc.data();
    const trainerId = change.doc.id;

    if (data.status === 'pairing_requested' && data.phoneNumber) {
      await db.collection('whatsappSessions').doc(trainerId).update({
        status: 'generating_code',
      });
      await startWhatsAppSession(trainerId, data.phoneNumber, true, 0);
    } else if (data.status === 'disconnect_requested') {
      const entry = sessions.get(trainerId);
      if (entry?.sock) {
        try { await entry.sock.logout(); } catch {}
      }
      const authDir = path.join(__dirname, 'auth_sessions', trainerId);
      fs.rmSync(authDir, { recursive: true, force: true });
      sessions.delete(trainerId);
      await db.collection('whatsappSessions').doc(trainerId).set(
        {
          status: 'disconnected',
          pairingCode: null,
          connectedNumber: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else if (data.status === 'connected' && !sessions.has(trainerId)) {
      const authDir = path.join(__dirname, 'auth_sessions', trainerId);
      if (fs.existsSync(authDir)) {
        await startWhatsAppSession(trainerId, data.phoneNumber || '', false, 0);
      }
    }
  });
});

db.collection('whatsappQueue')
  .where('status', '==', 'pending')
  .onSnapshot((snap) => {
    snap.docChanges().forEach(async (change) => {
      if (change.type !== 'added') return;
      const msgDoc = change.doc;
      const msg = msgDoc.data();
      const entry = sessions.get(msg.trainerId);

      if (!entry?.connected || !entry?.sock) {
        await msgDoc.ref.update({
          status: 'failed',
          error: 'جلسة واتساب المدرب غير متصلة حالياً.',
        });
        return;
      }

      try {
        const cleanTo = normalizePhone(msg.toPhone);
        const jid = `${cleanTo}@s.whatsapp.net`;
        await entry.sock.sendMessage(jid, { text: msg.text });
        await msgDoc.ref.update({
          status: 'sent',
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (err) {
        await msgDoc.ref.update({
          status: 'failed',
          error: err?.message || 'فشل الإرسال',
        });
      }
    });
  });

const app = express();
app.get('/', (_, res) => res.json({ status: 'HULK WhatsApp Web Service Running', version: '1.0.2', activeSessions: sessions.size }));
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 WhatsApp Web Backend v1.0.2 running on port ${PORT}`));
