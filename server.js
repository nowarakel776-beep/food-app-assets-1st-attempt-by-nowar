const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
let privateKey = process.env.FIREBASE_PRIVATE_KEY;
if(privateKey){
  privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
}
// Initialize Firebase Admin using environment variables
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: privateKey,
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
    const response = await admin.messaging().send(message);
    res.status(200).json({ success: true, messageId: response });
  } catch (error) {
    console.error('Error sending FCM message:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

