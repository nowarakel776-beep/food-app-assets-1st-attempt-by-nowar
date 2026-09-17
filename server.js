const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app'); // Modern Sub-modules
const { getMessaging } = require('firebase-admin/messaging');  // Modern Sub-modules
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
    // Updated from admin.messaging().send() to modern syntax
    const response = await getMessaging().send(message);
    res.status(200).json({ success: true, messageId: response });
  } catch (error) {
    console.error('Error sending FCM message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Render dynamically sets process.env.PORT. Fallback to 10000 which is Render's default.
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
