const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const DB_FILE = path.join(__dirname, 'data.json');

// Initialize database
function initDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ bookings: [], config: { slotsPerHour: 1 } }, null, 2));
  }
}

function loadDB() {
  try {
    initDB();
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { bookings: [], config: { slotsPerHour: 1 } };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
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
    message: 'Booking API v2.0',
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
app.get('/api/bookings', (req, res) => {
  try {
    const data = loadDB();
    const counts = {};
    
    data.bookings.forEach(booking => {
      const key = `${booking.date}-${booking.time}`;
      counts[key] = (counts[key] || 0) + 1;
    });
    
    res.json({ success: true, bookings: counts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all bookings (admin)
app.get('/api/bookings/all', (req, res) => {
  try {
    const data = loadDB();
    res.json({ success: true, bookings: data.bookings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create a booking
app.post('/api/bookings', (req, res) => {
  try {
    const { date, time, service, name, email, phone, timezone, notes, slotsPerHour } = req.body;
    
    if (!date || !time) {
      return res.status(400).json({ success: false, error: 'Date and time are required' });
    }
    
    const data = loadDB();
    const maxSlots = slotsPerHour || data.config.slotsPerHour || 1;
    
    // Count existing bookings for this slot
    const existingCount = data.bookings.filter(b => b.date === date && b.time === time).length;
    
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
    
    data.bookings.push(booking);
    saveDB(data);
    
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
app.delete('/api/bookings/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const data = loadDB();
    
    const index = data.bookings.findIndex(b => b.id === id);
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }
    
    data.bookings.splice(index, 1);
    saveDB(data);
    
    res.json({ success: true, message: 'Booking deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get configuration
app.get('/api/config', (req, res) => {
  try {
    const data = loadDB();
    res.json({ success: true, config: data.config });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Alias for config
app.get('/api/config/slots', (req, res) => {
  try {
    const data = loadDB();
    res.json({ 
      slotsPerHour: data.config.slotsPerHour || 1,
      showAvailability: true
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update configuration
app.post('/api/config', (req, res) => {
  try {
    const { slotsPerHour } = req.body;
    const data = loadDB();
    
    data.config = {
      ...data.config,
      slotsPerHour: parseInt(slotsPerHour) || 1
    };
    
    saveDB(data);
    res.json({ success: true, config: data.config });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cancel booking by email
app.post('/api/bookings/cancel', (req, res) => {
  try {
    const { id, email } = req.body;
    const data = loadDB();
    
    const index = data.bookings.findIndex(b => 
      b.id === parseInt(id) && b.email.toLowerCase() === email.toLowerCase()
    );
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Booking not found or email does not match' });
    }
    
    data.bookings.splice(index, 1);
    saveDB(data);
    
    res.json({ success: true, message: 'Booking cancelled successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  initDB();
  console.log(`
╔════════════════════════════════════════════╗
║     🗓️  BOOKING API v2.0 RUNNING          ║
╠════════════════════════════════════════════╣
║  Port: ${PORT}                               ║
║  Status: Ready                             ║
╚════════════════════════════════════════════╝

Endpoints:
  GET  /                    Health check
  GET  /api/bookings        Get booking counts
  POST /api/bookings        Create booking
  GET  /api/bookings/all    Get all bookings
  DEL  /api/bookings/:id    Delete booking
  GET  /api/config          Get config
  POST /api/config          Update config
  `);
});
