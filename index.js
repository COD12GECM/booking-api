const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3001;

// MongoDB Connection - MUST be set in environment variables
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI environment variable is required!');
}
const DB_NAME = 'bookingdb';

let db = null;

async function connectDB() {
  if (db) return db;
  
  try {
    const client = new MongoClient(MONGODB_URI, {
      tls: true,
      tlsAllowInvalidCertificates: false,
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000
    });
    await client.connect();
    db = client.db(DB_NAME);
    console.log('✅ Connected to MongoDB Atlas');
    
    // Create indexes for better performance
    await db.collection('bookings').createIndex({ date: 1, time: 1 });
    await db.collection('bookings').createIndex({ email: 1 });
    
    return db;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    throw error;
  }
}

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Booking API v3.0 (MongoDB)',
    database: db ? 'connected' : 'disconnected',
    endpoints: {
      'GET /api/bookings': 'Get booking counts by date-time',
      'POST /api/bookings': 'Create a booking',
      'GET /api/bookings/all': 'Get all bookings (admin)',
      'DELETE /api/bookings/:id': 'Delete a booking',
      'GET /api/config': 'Get slot configuration',
      'POST /api/config': 'Update slot configuration'
    }
  });
});

// Get booking counts by date-time slot
app.get('/api/bookings', async (req, res) => {
  try {
    const database = await connectDB();
    const bookings = await database.collection('bookings').find({}).toArray();
    
    const counts = {};
    bookings.forEach(booking => {
      const key = `${booking.date}-${booking.time}`;
      counts[key] = (counts[key] || 0) + 1;
    });
    
    res.json({ success: true, bookings: counts });
  } catch (error) {
    console.error('Error getting bookings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all bookings (admin)
app.get('/api/bookings/all', async (req, res) => {
  try {
    const database = await connectDB();
    const bookings = await database.collection('bookings').find({}).sort({ createdAt: -1 }).toArray();
    res.json({ success: true, bookings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create a booking
app.post('/api/bookings', async (req, res) => {
  try {
    const { date, time, service, name, email, phone, timezone, notes, slotsPerHour } = req.body;
    
    if (!date || !time) {
      return res.status(400).json({ success: false, error: 'Date and time are required' });
    }
    
    const database = await connectDB();
    const maxSlots = slotsPerHour || 1;
    
    // Count existing bookings for this slot
    const existingCount = await database.collection('bookings').countDocuments({ date, time });
    
    if (existingCount >= maxSlots) {
      return res.status(409).json({ 
        success: false, 
        error: 'This time slot is fully booked. Please choose another time.' 
      });
    }
    
    // Create booking
    const booking = {
      id: Date.now(),
      date,
      time,
      service: service || 'Consultation',
      name: name || 'Guest',
      email: email || '',
      phone: phone || '',
      timezone: timezone || 'UTC',
      notes: notes || '',
      createdAt: new Date().toISOString()
    };
    
    await database.collection('bookings').insertOne(booking);
    
    console.log(`✅ Booking created: ${date} ${time} - ${name}`);
    
    res.json({ 
      success: true, 
      message: 'Booking confirmed!',
      bookingId: booking.id,
      id: booking.id
    });
  } catch (error) {
    console.error('❌ Booking error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete a booking
app.delete('/api/bookings/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const database = await connectDB();
    
    const result = await database.collection('bookings').deleteOne({ id });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }
    
    res.json({ success: true, message: 'Booking deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get configuration
app.get('/api/config', async (req, res) => {
  try {
    const database = await connectDB();
    let config = await database.collection('config').findOne({ _id: 'settings' });
    
    if (!config) {
      config = { slotsPerHour: 1 };
      await database.collection('config').insertOne({ _id: 'settings', ...config });
    }
    
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Alias for config
app.get('/api/config/slots', async (req, res) => {
  try {
    const database = await connectDB();
    let config = await database.collection('config').findOne({ _id: 'settings' });
    
    res.json({ 
      slotsPerHour: config?.slotsPerHour || 1,
      showAvailability: true
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update configuration
app.post('/api/config', async (req, res) => {
  try {
    const { slotsPerHour } = req.body;
    const database = await connectDB();
    
    const config = { slotsPerHour: parseInt(slotsPerHour) || 1 };
    
    await database.collection('config').updateOne(
      { _id: 'settings' },
      { $set: config },
      { upsert: true }
    );
    
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cancel booking by email
app.post('/api/bookings/cancel', async (req, res) => {
  try {
    const { id, email } = req.body;
    const database = await connectDB();
    
    const result = await database.collection('bookings').deleteOne({
      id: parseInt(id),
      email: { $regex: new RegExp(`^${email}$`, 'i') }
    });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, error: 'Booking not found or email does not match' });
    }
    
    res.json({ success: true, message: 'Booking cancelled successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`
╔════════════════════════════════════════════╗
║     🗓️  BOOKING API v3.0 (MongoDB)        ║
╠════════════════════════════════════════════╣
║  Port: ${PORT}                               ║
║  Status: Starting...                       ║
╚════════════════════════════════════════════╝
  `);
  
  // Connect to MongoDB on startup
  try {
    await connectDB();
    console.log('🚀 Server ready with MongoDB Atlas!');
  } catch (error) {
    console.error('⚠️ Server started but MongoDB connection failed:', error.message);
  }
});
