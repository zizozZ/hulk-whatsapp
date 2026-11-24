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

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const recentLogs = [];
function pushLog(level, msg, meta = null) {
  const time = new Date().toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour12: false });
  const entry = { time, level, msg, meta };
  recentLogs.push(entry);
  if (recentLogs.length > 120) recentLogs.shift();
  const line = `[${time}] [${level}] ${msg}` + (meta ? " " + JSON.stringify(meta) : "");
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

const sessions = new Map();
const pairingLocks = new Set();
const trainerQueues = new Map();
const dailyCounters = new Map();
const traineeCooldowns = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('01') && digits.length === 11) digits = '2' + digits;
  return digits.replace(/^0+/, '');
}


function collectAllPhonesFromObject(obj, depth = 0) {
  const results = new Set();
  if (!obj || typeof obj !== "object" || depth > 3) return [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" || typeof v === "number") {
      if (/phone|mobile|wa|tel|contact/i.test(k) || /^\+?\d[\d\s-]{7,}$/.test(String(v).trim())) {
        const norm = normalizePhone(String(v));
        if (norm && norm.length >= 8) results.add(norm);
      }
    } else if (v && typeof v === "object" && !v._seconds && typeof v.toDate !== "function") {
      for (const sub of collectAllPhonesFromObject(v, depth + 1)) {
        results.add(sub);
      }
    }
  }
  return Array.from(results);
}

function deepPhoneMatch(candPhone, obj) {
  const a = normalizePhone(candPhone);
  if (!a || a.length < 8) return false;
  const objPhones = collectAllPhonesFromObject(obj);
  for (const b of objPhones) {
    if (a === b) return true;
    if (a.length >= 10 && b.length >= 10 && a.slice(-10) === b.slice(-10)) return true;
    if (a.length >= 9 && b.length >= 9 && a.slice(-9) === b.slice(-9)) return true;
  }
  return false;
}

function phonesMatch(p1, p2) {
  const a = normalizePhone(p1);
  const b = normalizePhone(p2);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 10 && b.length >= 10) {
    return a.slice(-10) === b.slice(-10);
  }
  return false;
}

function getCairoTimeInfo() {
  const now = new Date();
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', hour: 'numeric', hour12: false }).format(now)
  );
  const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(now);
  return { hour, dateKey };
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
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

// ==================== HULK GEMINI AI & FULL TRAINEE CONTEXT ====================
const humanPauseMap = new Map();
const chatMemoryMap = new Map();
const incomingLocks = new Map();

async function buildFullTraineeContext(trainerId, senderPhone, pushName) {
  const cleanSender = normalizePhone(senderPhone);
  const [traineesSnap, usersSnap, subsSnap] = await Promise.all([
    db.collection("trainees").get().catch(() => ({ docs: [] })),
    db.collection("users").get().catch(() => ({ docs: [] })),
    db.collection("subscriptions").get().catch(() => ({ docs: [] })),
  ]);

  // البحث بالرقم في الاشتراكات إذا وُجد رقم مطابق مرتبط بـ traineeId
  for (const s of subsSnap.docs) {
    const sData = s.data() || {};
    if (matchesPhoneList(sData) && sData.traineeId) {
      const tDoc = await db.collection("trainees").doc(sData.traineeId).get().catch(() => null);
      if (tDoc?.exists) {
        await saveAutoLink(tDoc.id, tDoc.data() || {});
        return tDoc;
      }
    }
  }

  const phoneMatchesAny = (obj) => {
    if (!obj || !cleanSender) return false;
    const candidates = [
      obj.phone, obj.phoneNumber, obj.mobile, obj.whatsapp, obj.waPhone, obj.contactPhone
    ].filter(Boolean);
    return candidates.some((ph) => phonesMatch(ph, cleanSender));
  };

  let matchedTraineeDoc = null;
  let matchedUserDoc = null;

  for (const u of usersSnap.docs) {
    const uData = u.data() || {};
    if (phoneMatchesAny(uData)) {
      matchedUserDoc = u;
      break;
    }
  }

  for (const d of traineesSnap.docs) {
    const tData = d.data() || {};
    if (
      phoneMatchesAny(tData) ||
      (matchedUserDoc && (d.id === matchedUserDoc.id || tData.userId === matchedUserDoc.id || tData.uid === matchedUserDoc.id))
    ) {
      matchedTraineeDoc = d;
      break;
    }
  }

  // لو لقى مستخدم في users ومش موجود في trainees نعمله كيان متدرب من بيانات users
  if (!matchedTraineeDoc && matchedUserDoc) {
    const uData = matchedUserDoc.data() || {};
    matchedTraineeDoc = {
      id: matchedUserDoc.id,
      ref: matchedUserDoc.ref,
      data: () => ({ ...uData, fullName: uData.fullName || uData.name || uData.displayName || pushName }),
    };
  }

  if (!matchedTraineeDoc) {
    if (typeof pushLog === "function") {
      pushLog("WARN", "Trainee NOT matched", { trainerId, senderPhone: cleanSender, pushName, traineesCount: traineesSnap.size });
    }
    return {
      traineeDoc: null,
      contextText: `حالة الشخص: زائر جديد غير مسجل كمتدرب بعد (اسمه على واتساب: ${pushName || "غير معروف"} | رقمه: ${cleanSender || "غير ظاهر"}). رحّب به، اسأله عن هدفه ووزنه وطوله، ووضح له باقات التدريب الأونلاين على منصة HULK FITNESS: https://hulk-fitness-9dbc0.web.app`,
    };
  }

  const t = matchedTraineeDoc.data() || {};
  const traineeId = matchedTraineeDoc.id;

  const [workoutsSnap, daysSnap, nutritionSnap, measurementsSnap] = await Promise.all([
    db.collection("workoutPlans").where("traineeId", "==", traineeId).limit(3).get().catch(() => ({ docs: [] })),
    db.collection("workoutDays").where("traineeId", "==", traineeId).limit(10).get().catch(() => ({ docs: [] })),
    db.collection("nutritionPlans").where("traineeId", "==", traineeId).limit(2).get().catch(() => ({ docs: [] })),
    db.collection("bodyMeasurements").where("traineeId", "==", traineeId).limit(5).get().catch(() => ({ docs: [] })),
  ]);

  const workoutPlan = workoutsSnap.docs[0]?.data();
  const workoutDays = daysSnap.docs.map((d) => d.data());
  const nutritionPlan = nutritionSnap.docs[0]?.data();
  const measurements = measurementsSnap.docs.map((m) => m.data());

  if (typeof pushLog === "function") {
    pushLog("INFO", "Trainee MATCHED", { traineeId, name: t.fullName || t.name || pushName, phone: t.phone || t.phoneNumber });
  }

  let summary = `بيانات المتدرب المسجل رسمياً في المنصة (ممنوع معاملته كزائر نهائياً!):
- الاسم: ${t.fullName || t.name || t.displayName || pushName || "بطل"}
- الهدف: ${t.goal || "بناء عضل وتحسين الفورمة"}
- الطول: ${t.height ? t.height + " سم" : "غير مسجل"}
- الوزن البدائي: ${t.startWeight ? t.startWeight + " كجم" : "غير مسجل"}
- الوزن الحالي: ${t.currentWeight ? t.currentWeight + " كجم" : "غير مسجل"}
- الوزن المستهدف: ${t.targetWeight ? t.targetWeight + " كجم" : "غير مسجل"}
- مستوى الالتزام: ${t.complianceLevel || "ممتاز"}
- حالة الاشتراك: ${t.subscriptionStatus || t.status || "نشط"}`;

  if (workoutPlan) {
    summary += `\n- البرنامج التدريبي الحالي: ${workoutPlan.title || workoutPlan.name || workoutPlan.splitName || "مخصص"} (${workoutPlan.daysPerWeek || ""} أيام أسبوعياً)`;
  }
  if (workoutDays.length > 0) {
    const daysList = workoutDays.map((wd) => wd.title || wd.dayName || wd.name).filter(Boolean).join("، ");
    if (daysList) summary += `\n- أيام/تقسيمة التمرين المسجلة: ${daysList}`;
  }
  if (nutritionPlan) {
    summary += `\n- النظام الغذائي الحالي: ${nutritionPlan.targetCalories || nutritionPlan.calories || ""} سعرة حرارية (بروتين: ${nutritionPlan.protein || ""}جم)`;
  }
  if (measurements.length > 0) {
    const weightsList = measurements.map((m) => m.weight).filter(Boolean).join(" -> ");
    if (weightsList) summary += `\n- سجل الأوزان المسجل: ${weightsList} كجم`;
  }

  return { traineeDoc: matchedTraineeDoc, contextText: summary };
}

async function askHulkGemini(userPrompt, contextInfo, history = []) {
  const apiKey = (process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('مفتاح GEMINI_API_KEY غير مضاف في إعدادات Koyeb');
  }

  const systemInstruction = `أنت المساعد الذكي الرسمي لكابتن هالك (كوتش زياد طارق - Cap Ziad) على واتساب ومنصة HULK FITNESS.
تحدث باللهجة المصرية الرياضية الودودة والمحفزة بأسلوب كابتن ذياد.

معلومات الشخص الذي يراسلك الآن:
${contextInfo}

تعليمات صارمة:
1. اكتب رداً كاملاً ومفيداً ومباشراً في رسالة واحدة مترابطة (لا تقطع الجملة أبداً).
2. إذا كان الشخص متدرباً مسجلاً في المنصة:
   - ناديه باسمه الحقيقي مباشرة ولا تعامله كزائر جديد ولا تسأله عن وزنه وطوله إذا كانت مسجلة بالفعل في بياناته أعلاه!
   - قيّم تطوره بناءً على وزنه البدائي والحالي والمستهدف والتزامه، وشجعه بذكاء.
3. إذا ذكر المتدرب وزنه الجديد، أكد له أنه تم تحديث وزنه في حسابه على المنصة بنجاح.
4. ممنوع ترشيح الشوفان أو الواي بروتين في أي اقتراح غذائي.`;

  const contents = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: userPrompt }] },
  ];

  const models = ['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite'];
  let lastError = 'Unknown Gemini Error';

  for (const model of models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents,
            generationConfig: {
              temperature: 0.65,
              maxOutputTokens: 2048,
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        lastError = `[${model}] ` + (data?.error?.message || `HTTP ${res.status}`);
        continue;
      }
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const reply = parts.map((p) => p.text || '').join('').trim();
      if (reply) return reply;
    } catch (err) {
      lastError = `[${model}] ` + (err?.message || String(err));
    }
  }

  throw new Error(lastError);
}

async function handleIncomingWhatsAppMessage(trainerId, sock, msg) {
  try {
    if (!msg?.message || msg.key?.remoteJid === 'status@broadcast') return;
    const remoteJid = msg.key.remoteJid || '';
    if (remoteJid.endsWith('@g.us')) return;

    const rawJid = msg.key.senderPn || msg.key.participant || remoteJid;
    const senderPhone = normalizePhone(rawJid.split('@')[0]);
    const pushName = msg.pushName || '';

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';
    const cleanText = text.trim();
    if (!cleanText) return;

    const pauseKey = `${trainerId}_${remoteJid}`;

    if (msg.key.fromMe) {
      if (cleanText.toLowerCase() === '/ai off') {
        humanPauseMap.set(pauseKey, Date.now() + 24 * 60 * 60 * 1000);
        return;
      }
      if (cleanText.toLowerCase() === '/ai on') {
        humanPauseMap.delete(pauseKey);
        return;
      }
      if (!msg.key.id?.startsWith('BAE5') && !msg.key.id?.startsWith('3EB0')) {
        humanPauseMap.set(pauseKey, Date.now() + 2 * 60 * 60 * 1000);
      }
      return;
    }

    const pausedUntil = humanPauseMap.get(pauseKey) || 0;
    if (Date.now() < pausedUntil) return;

    if (incomingLocks.get(pauseKey)) {
      await sleep(2500);
    }
    incomingLocks.set(pauseKey, true);

    try {
      pushLog("INFO", "Incoming WA message", { trainerId, remoteJid, senderPhone, pushName, text: cleanText });
      const { traineeDoc, contextText } = await buildFullTraineeContext(trainerId, senderPhone, pushName);
      pushLog("INFO", "Trainee lookup", traineeDoc ? { id: traineeDoc.id, fullName: traineeDoc.data().fullName, phone: traineeDoc.data().phone } : { matched: false, senderPhone });
      let finalContext = contextText;

      if (traineeDoc) {
        const weightMatch = cleanText.match(/(?:وزني|الوزن|وزن|بقيت|وصلت)[^0-9]{0,12}(\d{2,3}(?:\.\d{1,2})?)/i);
        if (weightMatch) {
          const newWeight = parseFloat(weightMatch[1]);
          if (newWeight >= 35 && newWeight <= 250) {
            await traineeDoc.ref.update({
              currentWeight: newWeight,
              lastWeightAt: admin.firestore.FieldValue.serverTimestamp(),
              lastUpdateAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            await db.collection('bodyMeasurements').add({
              traineeId: traineeDoc.id,
              trainerId,
              weight: newWeight,
              source: 'whatsapp_ai',
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            }).catch(() => {});
            finalContext += `\n(ملاحظة هامة: تم تسجيل تحديث وزنه الجديد إلى ${newWeight} كجم في المنصة الآن)`;
          }
        }
      } else if (senderPhone) {
        await db.collection('whatsappLeads').doc(senderPhone).set(
          {
            trainerId,
            phone: senderPhone,
            name: pushName,
            lastMessage: cleanText,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        ).catch(() => {});
      }

      const history = chatMemoryMap.get(pauseKey) || [];
      const aiReply = await askHulkGemini(cleanText, finalContext, history);
      if (!aiReply) return;

      const updatedHistory = [
        ...history.slice(-6),
        { role: 'user', text: cleanText },
        { role: 'model', text: aiReply },
      ];
      chatMemoryMap.set(pauseKey, updatedHistory);

      await sock.presenceSubscribe(remoteJid).catch(() => {});
      await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
      await sleep(Math.min(3000, Math.max(1200, aiReply.length * 15)));
      await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
      await sock.sendMessage(remoteJid, { text: aiReply });
    } finally {
      incomingLocks.delete(pauseKey);
    }
  } catch (err) {
    pushLog("ERROR", "Incoming WA AI error", { error: err?.message || String(err) });
  }
}
// ==============================================================================

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
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
  });

  const prevAuto = oldEntry?.autoMotivationEnabled ?? true;
  sessions.set(trainerId, { sock, connected: false, phoneNumber: cleanPhone, autoMotivationEnabled: prevAuto });

  let pairingCodeRequested = false;
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      await handleIncomingWhatsAppMessage(trainerId, sock, m);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && requestPairing && !sock.authState.creds.registered && !pairingCodeRequested && !pairingLocks.has(trainerId)) {
      pairingCodeRequested = true;
      pairingLocks.add(trainerId);
      setTimeout(async () => {
        try {
          if (sock.authState.creds.registered) return;
          const rawCode = await sock.requestPairingCode(cleanPhone);
          const cleanCode = String(rawCode || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
          const formatted = cleanCode.match(/.{1,4}/g)?.join("-") || cleanCode;
          pushLog("INFO", "Generated pairing code", { trainerId, phone: cleanPhone, code: formatted });
          await db.collection("whatsappSessions").doc(trainerId).set(
            {
              trainerId,
              phoneNumber: cleanPhone,
              status: "waiting_for_code",
              pairingCode: formatted,
              error: null,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        } catch (err) {
          pushLog("ERROR", "requestPairingCode failed", { trainerId, phone: cleanPhone, error: err?.message || String(err) });
          pairingCodeRequested = false;
          pairingLocks.delete(trainerId);
        }
      }, 4000);
    }

    if (connection === 'open') {
      pushLog("INFO", "WhatsApp connected", { trainerId, phone: sock.user?.id?.split(':')[0] || cleanPhone });
      pairingLocks.delete(trainerId);
      const connectedNum = sock.user?.id?.split(':')[0] || cleanPhone;
      const curAuto = sessions.get(trainerId)?.autoMotivationEnabled ?? true;
      sessions.set(trainerId, { sock, connected: true, phoneNumber: connectedNum, autoMotivationEnabled: curAuto });
      await db.collection('whatsappSessions').doc(trainerId).set(
        {
          trainerId,
          status: 'connected',
          pairingCode: null,
          connectedNumber: connectedNum,
          autoMotivationEnabled: curAuto,
          error: null,
          connectedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      processTrainerQueue(trainerId);
    } else if (connection === 'close') {
      pushLog("WARN", "WhatsApp connection closed", { trainerId, statusCode: lastDisconnect?.error?.output?.statusCode, loggedOut: lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut });
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const curAuto = sessions.get(trainerId)?.autoMotivationEnabled ?? true;
      sessions.set(trainerId, { sock: null, connected: false, phoneNumber: cleanPhone, autoMotivationEnabled: curAuto });

      if (loggedOut) {
        pairingLocks.delete(trainerId);
        fs.rmSync(authDir, { recursive: true, force: true });
        await db.collection('whatsappSessions').doc(trainerId).set(
          { status: 'disconnected', pairingCode: null, connectedNumber: null, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
      } else if (requestPairing && !sock.authState.creds.registered) {
        if (retryCount < 3) {
          setTimeout(() => startWhatsAppSession(trainerId, cleanPhone, true, retryCount + 1), 2000);
        } else {
          pairingLocks.delete(trainerId);
          await db.collection('whatsappSessions').doc(trainerId).set(
            { status: 'error', error: 'تعذر توليد الكود، حاول مرة أخرى.', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
        }
      } else if (sock.authState.creds.registered) {
        setTimeout(() => startWhatsAppSession(trainerId, cleanPhone, false, 0), 3000);
      }
    }
  });
}

async function processTrainerQueue(trainerId) {
  if (!trainerQueues.has(trainerId)) {
    trainerQueues.set(trainerId, { items: [], processing: false });
  }
  const qState = trainerQueues.get(trainerId);
  if (qState.processing || qState.items.length === 0) return;

  qState.processing = true;

  try {
    while (qState.items.length > 0) {
      const msg = qState.items.shift();
      const entry = sessions.get(trainerId);

      if (msg.isAutomated && entry?.autoMotivationEnabled === false) {
        await msg.ref.update({ status: 'skipped', error: 'الرسائل التلقائية متوقفة' }).catch(() => {});
        continue;
      }

      if (!entry?.connected || !entry?.sock) {
        await msg.ref.update({ status: 'failed', error: 'جلسة واتساب غير متصلة في السيرفر' }).catch(() => {});
        continue;
      }

      const { hour, dateKey } = getCairoTimeInfo();
      if (msg.isAutomated && (hour >= 23 || hour < 8)) {
        qState.items.unshift(msg);
        setTimeout(() => processTrainerQueue(trainerId), 15 * 60 * 1000);
        break;
      }

      const dayCounterKey = `${trainerId}_${dateKey}`;
      const sentToday = dailyCounters.get(dayCounterKey) || 0;
      if (sentToday >= 35) {
        await msg.ref.update({ status: 'skipped', error: 'الحد اليومي الآمن (35 رسالة)' }).catch(() => {});
        continue;
      }

      const cleanTo = normalizePhone(msg.toPhone);
      if (!cleanTo || cleanTo.length < 10) {
        await msg.ref.update({ status: 'failed', error: 'رقم هاتف غير صالح' }).catch(() => {});
        continue;
      }

      const cooldownKey = `${trainerId}_${cleanTo}`;
      const lastSentAt = traineeCooldowns.get(cooldownKey) || 0;
      if (msg.isAutomated && Date.now() - lastSentAt < 12 * 60 * 60 * 1000) {
        await msg.ref.update({ status: 'skipped', error: 'تم إرسال رسالة تحفيزية لهذا المتدرب مؤخراً' }).catch(() => {});
        continue;
      }

      try {
        const jid = `${cleanTo}@s.whatsapp.net`;
        await entry.sock.presenceSubscribe(jid).catch(() => {});
        await entry.sock.sendPresenceUpdate('composing', jid).catch(() => {});
        const typingMs = Math.min(4500, Math.max(2000, (msg.text?.length || 40) * 35));
        await sleep(typingMs);
        await entry.sock.sendPresenceUpdate('paused', jid).catch(() => {});

        await entry.sock.sendMessage(jid, { text: msg.text });

        dailyCounters.set(dayCounterKey, sentToday + 1);
        traineeCooldowns.set(cooldownKey, Date.now());

        await msg.ref.update({
          status: 'sent',
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      } catch (err) {
        await msg.ref.update({
          status: 'failed',
          error: err?.message || 'فشل الإرسال',
        }).catch(() => {});
      }

      if (qState.items.length > 0) {
        const safeDelay = 25000 + Math.floor(Math.random() * 35000);
        await sleep(safeDelay);
      }
    }
  } finally {
    qState.processing = false;
  }
}

async function runDailyMotivationScheduler() {
  const { hour } = getCairoTimeInfo();
  if (hour < 10 || hour > 20) return;

  for (const [trainerId, entry] of sessions.entries()) {
    if (!entry.connected || entry.autoMotivationEnabled === false) continue;

    try {
      const traineesSnap = await db
        .collection('trainees')
        .where('trainerId', '==', trainerId)
        .where('status', '==', 'active')
        .get();

      for (const docSnap of traineesSnap.docs) {
        const t = docSnap.data();
        if (!t.phone) continue;

        const lastAutoMs = t.lastAutoWhatsAppAt?.toMillis ? t.lastAutoWhatsAppAt.toMillis() : 0;
        if (Date.now() - lastAutoMs < 72 * 60 * 60 * 1000) continue;

        const firstName = String(t.fullName || 'بطل').split(' ')[0];
        const lastWorkoutMs = t.lastWorkoutAt?.toMillis ? t.lastWorkoutAt.toMillis() : 0;
        const daysSinceWorkout = lastWorkoutMs ? (Date.now() - lastWorkoutMs) / 86400000 : 4;
        let text = '';
        if (daysSinceWorkout >= 3) {
          text = pickRandom([
            `وحشنا تمرينك يا كابتن ${firstName} 💪🔥 الاستمرارية هي سر النتيجة، مستني أشوف تحديث تمرينك النهاردة على منصة HULK!`,
            `أهلاً يا بطل ${firstName} ⚡ بقالك كام يوم مسجلتش تمرينك.. ارجع بقوة النهاردة حتى لو تمرينة خفيفة، المهم متوقفش!`,
            `كابتن ${firstName} 🏋️‍♂️ هدفك (${t.goal || 'الفورمة'}) محتاج التزامك.. مستنيك النهاردة في الجيم وتبعتلي تحديثك!`,
          ]);
        } else {
          text = pickRandom([
            `عاش يا وحش ${firstName} 🔥 التزامك الفترة دي ممتاز، كمل بنفس القوة وهتوصل لأقوى نسخة منك مع HULK 💪`,
            `صباح الأبطال يا ${firstName} ⚡ افتكر إن كل عدة زيادة وكل التزام في الدايت بيقربك خطوة لهدفك.. كمل يا بطل!`,
            `بطل ${firstName} 🏆 فخور باستمراريتك والتزامك في التمرين، لو محتاج أي تعديل في جدولك ابعتلي فوراً!`,
          ]);
        }

        await docSnap.ref.update({ lastAutoWhatsAppAt: admin.firestore.FieldValue.serverTimestamp() });
        await db.collection('whatsappQueue').add({
          trainerId,
          traineeId: docSnap.id,
          traineeName: t.fullName || firstName,
          toPhone: t.phone,
          text,
          isAutomated: true,
          category: 'daily_motivation',
          status: 'pending',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } catch (err) {
      console.error('Scheduler error:', err?.message || err);
    }
  }
}

setTimeout(runDailyMotivationScheduler, 2 * 60 * 1000);
setInterval(runDailyMotivationScheduler, 60 * 60 * 1000);

db.collection('whatsappSessions').onSnapshot((snap) => {
  snap.docChanges().forEach(async (change) => {
    const data = change.doc.data();
    const trainerId = change.doc.id;
    const existing = sessions.get(trainerId);
    if (existing && typeof data.autoMotivationEnabled === 'boolean') {
      existing.autoMotivationEnabled = data.autoMotivationEnabled;
    }

    if (data.status === 'pairing_requested' && data.phoneNumber) {
      pairingLocks.delete(trainerId);
      await db.collection('whatsappSessions').doc(trainerId).update({ status: 'generating_code', pairingCode: null, error: null });
      await startWhatsAppSession(trainerId, data.phoneNumber, true, 0);
    } else if (data.status === 'disconnect_requested') {
      pairingLocks.delete(trainerId);
      if (existing?.sock) {
        try { await existing.sock.logout(); } catch {}
      }
      fs.rmSync(path.join(__dirname, 'auth_sessions', trainerId), { recursive: true, force: true });
      sessions.delete(trainerId);
      await db.collection('whatsappSessions').doc(trainerId).set(
        { status: 'disconnected', pairingCode: null, connectedNumber: null, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } else if (data.status === 'connected' && !existing) {
      const authDir = path.join(__dirname, 'auth_sessions', trainerId);
      if (fs.existsSync(authDir)) {
        await startWhatsAppSession(trainerId, data.phoneNumber || data.connectedNumber || '', false, 0);
      }
    }
  });
});

db.collection('whatsappQueue')
  .where('status', '==', 'pending')
  .onSnapshot((snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type !== 'added') return;
      const msgDoc = change.doc;
      const data = msgDoc.data();
      if (!data.trainerId) return;

      if (!trainerQueues.has(data.trainerId)) {
        trainerQueues.set(data.trainerId, { items: [], processing: false });
      }
      const qState = trainerQueues.get(data.trainerId);
      if (!qState.items.some((x) => x.id === msgDoc.id)) {
        qState.items.push({ id: msgDoc.id, ref: msgDoc.ref, ...data });
        processTrainerQueue(data.trainerId);
      }
    });
  });

db.collection('whatsappAiTests')
  .where('status', '==', 'pending')
  .onSnapshot((snap) => {
    snap.docChanges().forEach(async (change) => {
      if (change.type !== 'added') return;
      const d = change.doc.data();
      try {
        const reply = await askHulkGemini(d.prompt || 'اهلا', 'اختبار من لوحة المدرب', []);
        await change.doc.ref.update({ status: 'done', reply });
      } catch (err) {
        await change.doc.ref.update({ status: 'error', error: err?.message || 'AI Error' });
      }
    });
  });

const app = express();
app.use(express.json());
const hasAiKey = Boolean((process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || "").trim());


async function loadAllTrainersList() {
  const map = new Map();
  const [tSnap, uSnap, sSnap] = await Promise.all([
    db.collection("trainers").get().catch(() => ({ docs: [] })),
    db.collection("users").get().catch(() => ({ docs: [] })),
    db.collection("whatsappSessions").get().catch(() => ({ docs: [] })),
  ]);

  for (const d of tSnap.docs) {
    const data = d.data() || {};
    map.set(d.id, {
      id: d.id,
      name: data.fullName || data.name || data.displayName || data.brandName || "مدرب (" + d.id.slice(0, 6) + ")",
      phone: data.phone || data.phoneNumber || data.whatsapp || "",
    });
  }

  for (const d of uSnap.docs) {
    const data = d.data() || {};
    const r = String(data.role || "").toLowerCase();
    if (r === "trainer" || r === "coach" || r === "admin" || map.has(d.id)) {
      const prev = map.get(d.id) || {};
      map.set(d.id, {
        id: d.id,
        name: data.fullName || data.name || data.displayName || prev.name || "مدرب (" + d.id.slice(0, 6) + ")",
        phone: data.phone || data.phoneNumber || data.whatsapp || prev.phone || "",
      });
    }
  }

  // لو لسه فاضي، أضف كل مستخدمي users كاحتياط عشان متبقاش القائمة فاضية أبداً
  if (map.size === 0) {
    for (const d of uSnap.docs) {
      const data = d.data() || {};
      map.set(d.id, {
        id: d.id,
        name: (data.fullName || data.name || data.email || d.id) + (data.role ? " [" + data.role + "]" : ""),
        phone: data.phone || data.phoneNumber || data.whatsapp || "",
      });
    }
  }

  for (const d of sSnap.docs) {
    const data = d.data() || {};
    if (!map.has(d.id)) {
      map.set(d.id, {
        id: d.id,
        name: data.trainerName || ("مدرب (" + d.id.slice(0, 6) + ")"),
        phone: data.phoneNumber || data.connectedNumber || "",
      });
    }
  }

  return Array.from(map.values());
}


async function resolveTrainerIdentifier(inputRaw, phoneRaw) {
  const raw = String(inputRaw || "").trim();
  const cleanPhone = normalizePhone(phoneRaw || "");

  // لو المستخدم كتب ID مطابق بالضبط في trainers أو users أو whatsappSessions
  if (raw) {
    const [tDoc, uDoc, sDoc] = await Promise.all([
      db.collection("trainers").doc(raw).get().catch(() => null),
      db.collection("users").doc(raw).get().catch(() => null),
      db.collection("whatsappSessions").doc(raw).get().catch(() => null),
    ]);
    if (tDoc?.exists || uDoc?.exists || sDoc?.exists) {
      return raw;
    }
  }

  // البحث بالاسم أو البريد الإلكتروني أو رقم الهاتف في trainers و users
  const [tSnap, uSnap] = await Promise.all([
    db.collection("trainers").get().catch(() => ({ docs: [] })),
    db.collection("users").get().catch(() => ({ docs: [] })),
  ]);

  const needle = raw.toLowerCase();

  for (const d of tSnap.docs) {
    const data = d.data() || {};
    const name = String(data.fullName || data.name || data.displayName || data.brandName || "").toLowerCase();
    const email = String(data.email || "").toLowerCase();
    const tPhone = data.phone || data.phoneNumber || data.whatsapp || "";
    if (
      (needle && (name.includes(needle) || email === needle || d.id.toLowerCase() === needle)) ||
      (cleanPhone && phonesMatch(tPhone, cleanPhone))
    ) {
      return d.id;
    }
  }

  for (const d of uSnap.docs) {
    const data = d.data() || {};
    const r = String(data.role || "").toLowerCase();
    if (r === "trainee") continue;
    const name = String(data.fullName || data.name || data.displayName || "").toLowerCase();
    const email = String(data.email || "").toLowerCase();
    const uPhone = data.phone || data.phoneNumber || data.whatsapp || "";
    if (
      (needle && (name.includes(needle) || email === needle || d.id.toLowerCase() === needle)) ||
      (cleanPhone && phonesMatch(uPhone, cleanPhone))
    ) {
      return d.id;
    }
  }

  // لو كتب اسم مخصص للربط (مثلاً cap-ziad أو hulk-main) بدون حساب سابق، نستخدمه كمعرّف جلسة نظيف
  if (raw) {
    return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) || "default_trainer";
  }

  return cleanPhone ? ("trainer_" + cleanPhone) : "default_trainer";
}

async function collectSessionsOverview() {
  const map = new Map();
  const snap = await db.collection("whatsappSessions").get().catch(() => ({ docs: [] }));

  for (const doc of snap.docs) {
    const d = doc.data() || {};
    const mem = sessions.get(doc.id);
    map.set(doc.id, {
      trainerId: doc.id,
      phoneNumber: d.phoneNumber || mem?.phoneNumber || "-",
      connectedNumber: d.connectedNumber || (mem?.connected ? mem?.phoneNumber : null) || "-",
      status: mem?.connected ? "connected" : (d.status || "disconnected"),
      pairingCode: d.pairingCode || null,
      error: d.error || null,
      inMemorySocket: Boolean(mem?.sock),
      inMemoryConnected: Boolean(mem?.connected),
      autoMotivationEnabled: typeof d.autoMotivationEnabled === "boolean" ? d.autoMotivationEnabled : true,
    });
  }

  // إضافة أي جلسات نشطة في الذاكرة لم تكن موجودة في جدول whatsappSessions
  for (const [tid, mem] of sessions.entries()) {
    if (!map.has(tid)) {
      map.set(tid, {
        trainerId: tid,
        phoneNumber: mem?.phoneNumber || "-",
        connectedNumber: mem?.connected ? (mem?.phoneNumber || "-") : "-",
        status: mem?.connected ? "connected" : "active_in_memory",
        pairingCode: null,
        error: null,
        inMemorySocket: Boolean(mem?.sock),
        inMemoryConnected: Boolean(mem?.connected),
        autoMotivationEnabled: mem?.autoMotivationEnabled ?? true,
      });
    }
  }

  // إضافة أي مجلدات جلسات محفوظة على القرص المحلي في auth_sessions
  const authRoot = path.join(__dirname, "auth_sessions");
  if (fs.existsSync(authRoot)) {
    for (const folder of fs.readdirSync(authRoot)) {
      const fullPath = path.join(authRoot, folder);
      if (fs.statSync(fullPath).isDirectory() && !map.has(folder)) {
        const mem = sessions.get(folder);
        map.set(folder, {
          trainerId: folder,
          phoneNumber: mem?.phoneNumber || "-",
          connectedNumber: mem?.connected ? (mem?.phoneNumber || "-") : "-",
          status: mem?.connected ? "connected" : "cached_on_disk",
          pairingCode: null,
          error: null,
          inMemorySocket: Boolean(mem?.sock),
          inMemoryConnected: Boolean(mem?.connected),
          autoMotivationEnabled: mem?.autoMotivationEnabled ?? true,
        });
      }
    }
  }

  return Array.from(map.values());
}

app.get("/api/status", async (_, res) => {
  try {
    const list = await collectSessionsOverview();
    res.json({
      ok: true,
      version: "2.6.0-KOYEB-DASHBOARD",
      aiConfigured: hasAiKey,
      activeSessionsCount: Array.from(sessions.values()).filter((s) => s.connected).length,
      trainers: await loadAllTrainersList(),
      sessions: list,
      logs: recentLogs.slice().reverse(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/api/pair", async (req, res) => {
  try {
    const rawTrainer = String(req.body?.trainerId || req.body?.trainerName || "").trim();
    const trainerId = await resolveTrainerIdentifier(rawTrainer, req.body?.phone || "");
    const phone = normalizePhone(req.body?.phone || "");
    if (phone.length < 10) {
      return res.status(400).json({ ok: false, error: "أدخل رقم هاتف صحيح بكود الدولة (مثال 2010...)" });
    }
    pairingLocks.delete(trainerId);
    pushLog("INFO", "Manual pair requested from Koyeb page", { trainerId, phone });
    await db.collection("whatsappSessions").doc(trainerId).set(
      {
        trainerId,
        phoneNumber: phone,
        status: "generating_code",
        pairingCode: null,
        error: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    startWhatsAppSession(trainerId, phone, true, 0);
    res.json({ ok: true, trainerId, message: "جاري توليد كود الربط للمدرب: " + trainerId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/api/disconnect", async (req, res) => {
  try {
    const trainerId = String(req.body?.trainerId || "").trim();
    if (!trainerId) return res.status(400).json({ ok: false, error: "trainerId مطلوب" });
    pairingLocks.delete(trainerId);
    const existing = sessions.get(trainerId);
    if (existing?.sock) {
      try { await existing.sock.logout(); } catch {}
    }
    fs.rmSync(path.join(__dirname, "auth_sessions", trainerId), { recursive: true, force: true });
    sessions.delete(trainerId);
    pushLog("WARN", "Disconnected from Koyeb page", { trainerId });
    await db.collection("whatsappSessions").doc(trainerId).set(
      { status: "disconnected", pairingCode: null, connectedNumber: null, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get("/", (_, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HULK WhatsApp Koyeb Monitor</title>
  <style>
    body { margin: 0; font-family: Tahoma, Arial, sans-serif; background: #090d0a; color: #eef5ef; padding: 16px; }
    .box { max-width: 900px; margin: 0 auto 16px; background: #111913; border: 1px solid #223326; border-radius: 12px; padding: 14px; }
    h2 { margin: 0 0 10px; color: #39ff14; font-size: 18px; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
    input, button { padding: 9px 12px; border-radius: 8px; border: 1px solid #2c4231; font-size: 13px; }
    input { background: #0a0f0b; color: #fff; flex: 1; min-width: 160px; }
    button { background: #39ff14; color: #071008; font-weight: bold; cursor: pointer; border: none; }
    button.danger { background: #d9383a; color: #fff; }
    button.secondary { background: #1e2d22; color: #d5e8d8; border: 1px solid #354f3b; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #1e2d22; padding: 8px; text-align: right; }
    .badge { padding: 3px 8px; border-radius: 99px; font-size: 11px; font-weight: bold; }
    .ok { background: rgba(57,255,20,0.16); color: #39ff14; }
    .warn { background: rgba(255,193,7,0.16); color: #ffc107; }
    .err { background: rgba(244,67,54,0.18); color: #ff6b6b; }
    .code { font-family: monospace; font-size: 15px; background: #09130b; padding: 3px 8px; border-radius: 6px; border: 1px dashed #39ff14; color: #39ff14; }
    .logs { background: #060907; border: 1px solid #1b291f; border-radius: 8px; padding: 10px; max-height: 360px; overflow-y: auto; font-family: monospace; font-size: 12px; direction: ltr; text-align: left; }
    .log-line { padding: 3px 0; border-bottom: 1px dashed #131d16; white-space: pre-wrap; word-break: break-word; }
    .INFO { color: #8ce99a; }
    .WARN { color: #ffd43b; }
    .ERROR { color: #ff6b6b; }
  </style>
</head>
<body>
  <div class="box">
    <h2>⚡ HULK FITNESS — مراقبة واتساب والربط واللوج (Koyeb)</h2>
    <div id="topMeta" class="row" style="font-size:13px;color:#a8c2ad;">جاري التحميل...</div>
    <div class="row">
      <select id="trainerSelect" onchange="onTrainerChange()" style="padding:9px 12px;border-radius:8px;border:1px solid #2c4231;background:#0a0f0b;color:#fff;font-size:13px;flex:1;min-width:190px;"><option value="">-- اختر المدرب --</option></select>
      <input id="phoneInput" placeholder="رقم واتساب بكود الدولة (مثال 2010...)" />
      <input id="manualTrainerId" placeholder="أو اكتب اسم المدرب / إيميله / اسم جلسة (بدون ID)" />
      <button onclick="pairNow()">ربط رقم / توليد كود</button>
      <button class="secondary" onclick="refreshAll()">تحديث الآن</button>
    </div>
    <div id="actionMsg" style="font-size:12px;color:#39ff14;"></div>
  </div>

  <div class="box">
    <h2>📱 الأرقام والجلسات المسجلة</h2>
    <table>
      <thead>
        <tr>
          <th>Trainer ID</th>
          <th>الرقم</th>
          <th>الحالة</th>
          <th>كود الربط</th>
          <th>تحكم</th>
        </tr>
      </thead>
      <tbody id="sessionsBody"></tbody>
    </table>
  </div>

  <div class="box">
    <h2>📜 سجل اللوج المباشر (Live Logs)</h2>
    <div id="logsBox" class="logs"></div>
  </div>

  <script>
    async function refreshAll() {
      try {
        const res = await fetch("/api/status");
        const data = await res.json();
        if (!data.ok) return;
        document.getElementById("topMeta").innerHTML =
          "النسخة: <b>" + data.version + "</b> | Gemini Key: <b>" + (data.aiConfigured ? "مفعّل ✅" : "غير مضاف ❌") + "</b> | جلسات متصلة فعلياً: <b>" + data.activeSessionsCount + "</b>";

        const tbody = document.getElementById("sessionsBody");
        if (!data.sessions.length) {
          tbody.innerHTML = "<tr><td colspan=5>لا توجد جلسات مسجلة بعد</td></tr>";
        } else {
          tbody.innerHTML = data.sessions.map(s => {
            const cls = s.status === "connected" ? "ok" : (s.status === "error" ? "err" : "warn");
            const num = s.connectedNumber && s.connectedNumber !== "-" ? s.connectedNumber : s.phoneNumber;
            return "<tr>" +
              "<td><b>" + ((window.__hulkTrainersMap && window.__hulkTrainersMap[s.trainerId]) || s.trainerId) + "</b><div style=font-family:monospace;font-size:10px;color:#8aa390>" + s.trainerId + "</div></td>" +
              "<td>" + (num || "-") + "</td>" +
              "<td><span class=\"badge " + cls + "\">" + s.status + "</span>" + (s.error ? "<div style=color:#ff6b6b;font-size:11px>" + s.error + "</div>" : "") + "</td>" +
              "<td>" + (s.pairingCode ? "<span class=code>" + s.pairingCode + "</span>" : "-") + "</td>" +
              "<td><button class=danger onclick=\"disconnectId('" + s.trainerId + "')\">فصل</button></td>" +
            "</tr>";
          }).join("");
        }

        const logsEl = document.getElementById("logsBox");
        logsEl.innerHTML = (data.logs || []).map(l =>
          "<div class=\"log-line " + l.level + "\">[" + l.time + "] [" + l.level + "] " + l.msg + (l.meta ? " " + JSON.stringify(l.meta) : "") + "</div>"
        ).join("");
      } catch (e) {}
    }

    function onTrainerChange() {
      const sel = document.getElementById("trainerSelect");
      const pInp = document.getElementById("phoneInput");
      if (!sel || !pInp) return;
      const txt = sel.options[sel.selectedIndex]?.text || "";
      const m = txt.match(/\(([^)]+)\)/);
      if (m && m[1]) pInp.value = m[1].trim();
    }
    async function pairNow() {
      const selVal = document.getElementById("trainerSelect").value.trim();
      const manualVal = (document.getElementById("manualTrainerId")?.value || "").trim();
      const rawTrainerInput = manualVal || selVal;
      const phone = document.getElementById("phoneInput").value.trim();
      const msgEl = document.getElementById("actionMsg");
      msgEl.textContent = "جاري إرسال طلب الربط...";
      const res = await fetch("/api/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trainerId, phone })
      });
      const out = await res.json();
      msgEl.textContent = out.ok ? (out.message || "تم الطلب") : ("خطأ: " + out.error);
      setTimeout(refreshAll, 1500);
    }

    async function disconnectId(trainerId) {
      await fetch("/api/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trainerId })
      });
      refreshAll();
    }

    refreshAll();
    setInterval(refreshAll, 3000);
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => pushLog("INFO", "HULK WhatsApp Web Backend running", { port: PORT, version: "2.6.0-KOYEB-DASHBOARD" }));
