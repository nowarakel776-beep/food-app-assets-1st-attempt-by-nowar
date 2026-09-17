const express = require('express');
const { initializeApp } = require('firebase-admin/app'); // <-- Changed
const { cert } = require('firebase-admin/app');         // <-- Changed
const { getMessaging } = require('firebase-admin/messaging'); // Generated for modern FCM
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Initialize Firebase Admin using environment variables
initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  }),
});

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
    // Updated to use modern messaging getter
    const response = await getMessaging().send(message); 
    res.status(200).json({ success: true, messageId: response });
  } catch (error) {
    console.error('Error sending FCM message:', error);
    res.status(500).json({ error: error.message });
  }
});
