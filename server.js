const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Boom } = require('@hapi/boom');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Initialize Firebase Admin using environment variables & Realtime Database URL
initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  }),
  databaseURL: "https://foodiehub-5919d-default-rtdb.firebaseio.com"
});

let waSock;
let isWhatsAppReady = false;

// ==========================================
// --- FIREBASE AUTH STATE ADAPTER FOR BAILEYS ---
// ==========================================
async function useFirebaseAuthState(dbPath = 'whatsapp_auth_session') {
  const db = getDatabase();
  const ref = db.ref(dbPath);

  const snapshot = await ref.once('value');
  const data = snapshot.val() || {};

  let creds = data.creds ? JSON.parse(JSON.stringify(data.creds), BufferJSON.reviver) : initAuthCreds();

  const saveCreds = async () => {
    const serializedCreds = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    await ref.child('creds').set(serializedCreds);
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const dataSnap = await ref.child('keys').child(type).once('value');
          const allKeys = dataSnap.val() || {};
          const obj = {};
          for (const id of ids) {
            let value = allKeys[id];
            if (value) {
              if (type === 'app-state-sync-key') {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              obj[id] = JSON.parse(JSON.stringify(value), BufferJSON.reviver);
            }
          }
          return obj;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const path = ref.child('keys').child(category).child(id);
              if (value) {
                tasks.push(path.set(JSON.parse(JSON.stringify(value, BufferJSON.replacer))));
              } else {
                tasks.push(path.remove());
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds
  };
}

// ==========================================
// --- KEEP-ALIVE ENDPOINT (For GitHub Actions) ---
// ==========================================
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    service: 'Tikram WhatsApp OTP & Notification Backend',
    whatsappReady: isWhatsAppReady,
    timestamp: new Date().toISOString()
  });
});

// Initialize Baileys WhatsApp Connection with Firebase Persistence
async function connectToWhatsApp() {
  isWhatsAppReady = false;
  const { state, saveCreds } = await useFirebaseAuthState('tikram_whatsapp_session');

  waSock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
  });

  waSock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR code with your WhatsApp Business app:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      isWhatsAppReady = false;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed, reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp bot connected successfully!');
      setTimeout(() => {
        isWhatsAppReady = true;
      }, 3000);
    }
  });

  waSock.ev.on('creds.update', saveCreds);

  // Silent/unmonitored notice for inbound replies from users
  waSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type === 'notify') {
      const incomingMsg = messages[0];
      if (!incomingMsg.key.fromMe && incomingMsg.message) {
        const senderJid = incomingMsg.key.remoteJid;
        await waSock.sendMessage(senderJid, { 
          text: "⚠️ This is an automated notification channel. Please enter your verification code inside the app. Replies are unmonitored." 
        }, { quoted: incomingMsg });
      }
    }
  });
}

// Helper to clean phone numbers
const cleanPhoneNumber = (phone) => phone.replace(/[^0-9]/g, '');

// ==========================================
// --- WHATSAPP OTP & AUTHENTICATION ROUTES ---
// ==========================================

// 1. Send OTP Route
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

    const cleanNumber = cleanPhoneNumber(phoneNumber);
    const rtdb = getDatabase();

    if (!waSock || !isWhatsAppReady) {
      return res.status(503).json({ error: 'WhatsApp bot is still syncing. Please try again in 5 seconds.' });
    }

    try {
      const blacklistSnap = await rtdb.ref(`blacklisted_phones/${cleanNumber}`).once('value');
      if (blacklistSnap.exists()) {
        return res.status(403).json({ error: 'This phone number has been suspended.' });
      }
    } catch (ruleErr) {
      console.log('Skipping blacklist check:', ruleErr.message);
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 3 * 60 * 1000;

    await rtdb.ref(`phone_otps/${cleanNumber}`).set({
      code: otpCode,
      expiresAt: expiresAt,
    });

    const recipientJid = `${cleanNumber}@s.whatsapp.net`;

    await waSock.sendMessage(recipientJid, { 
      text: `Your verification code is: *${otpCode}*\n\nValid for 3 minutes.` 
    });

    res.status(200).json({ success: true, message: 'OTP sent successfully via WhatsApp' });
  } catch (error) {
    console.error('Error sending OTP:', error);
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// 2. Verify OTP & Issue Firebase Custom Token Route
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { phoneNumber, code } = req.body;
    if (!phoneNumber || !code) return res.status(400).json({ error: 'Phone number and code are required' });

    const cleanNumber = cleanPhoneNumber(phoneNumber);
    const formattedPhone = `+${cleanNumber}`;
    const rtdb = getDatabase();

    const otpRef = rtdb.ref(`phone_otps/${cleanNumber}`);
    const otpSnap = await otpRef.once('value');

    if (!otpSnap.exists()) {
      return res.status(400).json({ error: 'OTP expired or not requested' });
    }

    const otpData = otpSnap.val();
    if (otpData.code !== code || Date.now() > otpData.expiresAt) {
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }

    await otpRef.remove();

    let uid;
    try {
      const userRecord = await getAuth().getUserByPhoneNumber(formattedPhone);
      uid = userRecord.uid;
      
      if (userRecord.disabled) {
        return res.status(403).json({ error: 'This account has been suspended.' });
      }
    } catch (e) {
      const newUserRecord = await getAuth().createUser({
        phoneNumber: formattedPhone,
      });
      uid = newUserRecord.uid;
    }

    const customToken = await getAuth().createCustomToken(uid);

    res.status(200).json({ success: true, customToken });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// --- EXISTING NOTIFICATION ENDPOINTS ---
// ==========================================

app.post('/send-notification', async (req, res) => {
  const { token, title, body, data } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Missing FCM device token' });
  }

  const message = {
    token: token,
    notification: {
      title: title || 'New Update',
      body: body || '',
    },
    data: data || {},
  };

  try {
    const response = await getMessaging().send(message);
    res.status(200).json({ success: true, messageId: response });
  } catch (error) {
    console.error('Error sending FCM message:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-order-notification', async (req, res) => {
  try {
    const { restaurantId, orderId, customerName } = req.body;

    if (!restaurantId) {
      return res.status(400).json({ error: 'Missing restaurantId' });
    }

    const snapshot = await getDatabase().ref(`restaurants/${restaurantId}/fcmToken`).once('value');
    const fcmToken = snapshot.val();

    if (!fcmToken) {
      return res.status(404).json({ error: 'Restaurant FCM token not found' });
    }

    const message = {
      token: fcmToken,
      notification: {
        title: 'تم استلام طلب جديد! 🍔',
        body: `الطلب رقم #${orderId || ''} تم وضعه من قبل  ${customerName || 'زبون'}.`,
      },
      data: {
        orderId: orderId || '',
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
    };

    const response = await getMessaging().send(message);
    res.status(200).json({ success: true, messageId: response });
  } catch (error) {
    console.error('Error sending order notification:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-driver-notification', async (req, res) => {
  try {
    const { driverId, orderId, restaurantName } = req.body;

    if (!driverId) {
      return res.status(400).json({ error: 'Missing driverId' });
    }

    const snapshot = await getDatabase().ref(`users/${driverId}/fcmToken`).once('value');
    const fcmToken = snapshot.val();

    if (!fcmToken) {
      return res.status(404).json({ error: 'Driver FCM token not found' });
    }

    const message = {
      token: fcmToken,
      notification: {
        title: 'لديك مهمة جديدة! 🚚',
        body: `لديك طلب في  ${restaurantName || 'مطعم'}.`,
      },
      data: {
        orderId: orderId || '',
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
    };

    const response = await getMessaging().send(message);
    res.status(200).json({ success: true, messageId: response });
  } catch (error) {
    console.error('Error sending driver notification:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-customer-notification', async (req, res) => {
  try {
    const { customerId, orderId, reason } = req.body;

    if (!customerId) {
      return res.status(400).json({ error: 'Missing customerId' });
    }

    const snapshot = await getDatabase().ref(`users/${customerId}/fcmToken`).once('value');
    const fcmToken = snapshot.val();

    if (!fcmToken) {
      return res.status(404).json({ error: 'Customer FCM token not found' });
    }

    const message = {
      token: fcmToken,
      notification: {
        title: 'تم إلغاء الطلب ❌',
        body: `عذراً، تم إلغاء طلبك رقم #${orderId || ''}. السبب: ${reason || 'غير متوفر'}`,
      },
      data: {
        orderId: orderId || '',
        reason: reason || '',
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
    };

    const response = await getMessaging().send(message);
    res.status(200).json({ success: true, messageId: response });
  } catch (error) {
    console.error('Error sending customer notification:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-restaurant-cancellation-notification', async (req, res) => {
  try {
    const { restaurantId, orderId, customerName, reason } = req.body;

    if (!restaurantId) {
      return res.status(400).json({ error: 'Missing restaurantId' });
    }

    const snapshot = await getDatabase().ref(`restaurants/${restaurantId}/fcmToken`).once('value');
    const fcmToken = snapshot.val();

    if (!fcmToken) {
      return res.status(404).json({ error: 'Restaurant FCM token not found' });
    }

    const message = {
      token: fcmToken,
      notification: {
        title: 'تم إلغاء الطلب من قبل الزبون ❌',
        body: `الزبون ${customerName || 'الزبون'} قام بإلغاء الطلب رقم #${orderId || ''}. السبب: ${reason || 'غير متوفر'}`,
      },
      data: {
        orderId: orderId || '',
        reason: reason || '',
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
    };

    const response = await getMessaging().send(message);
    res.status(200).json({ success: true, messageId: response });
  } catch (error) {
    console.error('Error sending restaurant cancellation notification:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
  connectToWhatsApp(); // Initialize WhatsApp connection on server boot
});

