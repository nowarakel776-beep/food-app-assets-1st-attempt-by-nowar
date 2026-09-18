const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { getDatabase } = require('firebase-admin/database');
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
  databaseURL: "https://foodiehub-5919d-default-rtdb.firebaseio.com"
});

// General notification endpoint (passes token explicitly)
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

// Order notification endpoint (looks up restaurant token automatically from Database)
app.post('/send-order-notification', async (req, res) => {
  try {
    const { restaurantId, orderId, customerName } = req.body;

    if (!restaurantId) {
      return res.status(400).json({ error: 'Missing restaurantId' });
    }

    // Fetch the restaurant's FCM token from Realtime Database
    const snapshot = await getDatabase().ref(`restaurants/${restaurantId}/fcmToken`).once('value');
    const fcmToken = snapshot.val();

    if (!fcmToken) {
      return res.status(404).json({ error: 'Restaurant FCM token not found' });
    }

    const message = {
      token: fcmToken,
      notification: {
        title: 'New Order Received! 🍔',
        body: `Order #${orderId || ''} was placed by ${customerName || 'a customer'}.`,
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

// Driver notification endpoint (looks up driver token automatically from Database)
app.post('/send-driver-notification', async (req, res) => {
  try {
    const { driverId, orderId, restaurantName } = req.body;

    if (!driverId) {
      return res.status(400).json({ error: 'Missing driverId' });
    }

    // Fetch the driver's FCM token from Realtime Database
    const snapshot = await getDatabase().ref(`users/${driverId}/fcmToken`).once('value');
    const fcmToken = snapshot.val();

    if (!fcmToken) {
      return res.status(404).json({ error: 'Driver FCM token not found' });
    }

    const message = {
      token: fcmToken,
      notification: {
        title: 'New Delivery Assignment! 🚚',
        body: `You have been assigned an order from ${restaurantName || 'a restaurant'}.`,
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

// Render dynamically sets process.env.PORT. Fallback to 10000 which is Render's default.
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});

