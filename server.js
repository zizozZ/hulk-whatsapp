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

const sessions = new Map();
const pairingLocks = new Set();
const trainerQueues = new Map();
const dailyCounters = new Map();
const traineeCooldowns = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizePhone(raw) {
  let digits = String(raw || "").replace(/[^0-9]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("01") && digits.length === 11) digits = "2" + digits;
  return digits.replace(/^0+/, "");
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
  const traineesSnap = await db.collection('trainees').where('trainerId', '==', trainerId).get();
  let matchedTraineeDoc = null;
  for (const d of traineesSnap.docs) {
    const data = d.data();
    if (phonesMatch(data.phone, senderPhone) || phonesMatch(data.whatsapp, senderPhone)) {
      matchedTraineeDoc = d;
      break;
    }
  }

  if (!matchedTraineeDoc && senderPhone) {
    const usersSnap = await db.collection('users').get();
    for (const u of usersSnap.docs) {
      const uData = u.data();
      if (phonesMatch(uData.phone, senderPhone) || phonesMatch(uData.whatsapp, senderPhone)) {
        const tDoc = await db.collection('trainees').doc(u.id).get();
        if (tDoc.exists) {
          matchedTraineeDoc = tDoc;
          break;
        }
      }
    }
  }

  if (!matchedTraineeDoc) {
    return {
      traineeDoc: null,
      contextText: `حالة الشخص: زائر جديد غير مسجل كمتدرب بعد (اسمه على واتساب: ${pushName || 'غير معروف'} | رقمه: ${senderPhone}). رحّب به، اسأله عن هدفه ووزنه وطوله، ووضح له باقات التدريب الأونلاين على منصة HULK FITNESS: https://hulk-fitness-9dbc0.web.app`,
    };
  }

  const t = matchedTraineeDoc.data();
  const traineeId = matchedTraineeDoc.id;

  const [workoutsSnap, nutritionSnap, measurementsSnap] = await Promise.all([
    db.collection('workoutPlans').where('traineeId', '==', traineeId).limit(1).get().catch(() => ({ docs: [] })),
    db.collection('nutritionPlans').where('traineeId', '==', traineeId).limit(1).get().catch(() => ({ docs: [] })),
    db.collection('bodyMeasurements').where('traineeId', '==', traineeId).limit(5).get().catch(() => ({ docs: [] })),
  ]);

  const workoutPlan = workoutsSnap.docs[0]?.data();
  const nutritionPlan = nutritionSnap.docs[0]?.data();
  const measurements = measurementsSnap.docs.map((m) => m.data());

  let summary = `بيانات المتدرب المسجل في المنصة:
- الاسم: ${t.fullName || pushName || 'بطل'}
- الهدف: ${t.goal || 'بناء عضل وتحسين الفورمة'}
- الطول: ${t.height ? t.height + ' سم' : 'غير مسجل'}
- الوزن البدائي: ${t.startWeight ? t.startWeight + ' كجم' : 'غير مسجل'}
- الوزن الحالي: ${t.currentWeight ? t.currentWeight + ' كجم' : 'غير مسجل'}
- الوزن المستهدف: ${t.targetWeight ? t.targetWeight + ' كجم' : 'غير مسجل'}
- مستوى الالتزام: ${t.complianceLevel || 'ممتاز'}
- حالة الاشتراك: ${t.subscriptionStatus || t.status || 'نشط'}`;

  if (workoutPlan) {
    summary += `\n- البرنامج التدريبي الحالي: ${workoutPlan.title || workoutPlan.splitName || 'مخصص'} (${workoutPlan.daysPerWeek || ''} أيام أسبوعياً)`;
  }
  if (nutritionPlan) {
    summary += `\n- النظام الغذائي الحالي: ${nutritionPlan.targetCalories || nutritionPlan.calories || ''} سعرة حرارية (بروتين: ${nutritionPlan.protein || ''}جم)`;
  }
  if (measurements.length > 0) {
    const weightsList = measurements.map((m) => m.weight).filter(Boolean).join(' -> ');
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
      const { traineeDoc, contextText } = await buildFullTraineeContext(trainerId, senderPhone, pushName);
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
    console.error('Incoming WA AI handler error:', err?.message || err);
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
    browser: Browsers.macOS('Desktop'),
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
          if (!cleanPhone || cleanPhone.length < 10) {
            pairingLocks.delete(trainerId);
            await db.collection("whatsappSessions").doc(trainerId).set(
              { status: "error", error: "صيغة الرقم غير صحيحة، اكتب الرقم بكود الدولة مثل 2010xxxxxxxx", updatedAt: admin.firestore.FieldValue.serverTimestamp() },
              { merge: true }
            );
            return;
          }
          const rawCode = await sock.requestPairingCode(cleanPhone);
          const cleanCode = String(rawCode || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
          const formatted = cleanCode.match(/.{1,4}/g)?.join("-") || cleanCode;
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
          pairingCodeRequested = false;
          pairingLocks.delete(trainerId);
          await db.collection("whatsappSessions").doc(trainerId).set(
            { status: "error", error: "تعذر توليد كود الربط: " + (err?.message || "حاول مجدداً"), updatedAt: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
        }
      }, 3000);
    }

    if (connection === 'open') {
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
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const curAuto = sessions.get(trainerId)?.autoMotivationEnabled ?? true;
      sessions.set(trainerId, { sock: null, connected: false, phoneNumber: cleanPhone, autoMotivationEnabled: curAuto });

      if (loggedOut) {
        fs.rmSync(authDir, { recursive: true, force: true });
        await db.collection('whatsappSessions').doc(trainerId).set(
          { status: 'disconnected', pairingCode: null, connectedNumber: null, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
      } else if (requestPairing && !sock.authState.creds.registered) {
        // لا نعيد بدء الجلسة أثناء انتظار إدخال الكود حتى لا يصبح الكود غير صالح
        console.log("⏳ Waiting for user to enter pairing code on phone...");
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
        await msg.ref.update({ status: 'failed', error: 'جلسة واتساب تعيد الاتصال حالياً، حاول بعد ثوانٍ' }).catch(() => {});
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

    if (data.status === "pairing_requested") pairingLocks.delete(trainerId);
    if ((data.status === "pairing_requested" || (data.status === "generating_code" && !existing)) && data.phoneNumber) {
      await db.collection("whatsappSessions").doc(trainerId).update({ status: "generating_code" });
      await startWhatsAppSession(trainerId, data.phoneNumber, true, 0);
    } else if (data.status === 'disconnect_requested') {
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
      // لن يمسح الحالة في المنصة أبداً إذا أعيد تشغيل السيرفر، إلا عند الضغط على "فصل الربط" يدوياً
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
const hasAiKey = Boolean((process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '').trim());
app.get('/', (_, res) =>
  res.json({
    status: 'HULK WhatsApp Web Service Running',
    version: '2.4.0-SILENT-RECONNECT',
    aiConfigured: hasAiKey,
    activeSessions: sessions.size,
  })
);
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 WhatsApp Web Backend v2.4.0 running on port ${PORT}`));
