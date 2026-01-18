const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');

const app = express();
const PORT = process.env.PORT || 3001;

// MongoDB Connection - MUST be set in environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = 'bookingsbuildhaze@gmail.com';

// API Key for secure communication (set in Render environment)
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'buildhaze-booking-secret-2024';

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI environment variable is required!');
}
if (!BREVO_API_KEY) {
  console.warn('⚠️ BREVO_API_KEY not set - emails will not be sent');
}
const DB_NAME = 'bookingdb';

let db = null;

async function connectDB() {
  if (db) return db;
  
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is not set');
  }
  
  try {
    const client = new MongoClient(MONGODB_URI, {
      retryWrites: true,
      w: 'majority',
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000
    });
    await client.connect();
    db = client.db(DB_NAME);
    console.log('✅ Connected to MongoDB Atlas');
    
    // Create indexes for better performance
    try {
      await db.collection('bookings').createIndex({ date: 1, time: 1 });
      await db.collection('bookings').createIndex({ email: 1 });
    } catch (indexError) {
      console.log('Index already exists or error:', indexError.message);
    }
    
    return db;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    db = null;
    throw error;
  }
}

// ===========================================
// SECURITY MIDDLEWARE
// ===========================================

// 1. Security Headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// 2. Rate Limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 min
  message: { success: false, error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const bookingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 bookings per minute per IP
  message: { success: false, error: 'Too many booking attempts. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(apiLimiter);

// 3. CORS - Allow all origins (multi-client booking system)
// Security is handled by rate limiting, input sanitization, and validation
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// 4. Body parser with limits
app.use(express.json({ limit: '10kb' }));

// 5. NoSQL Injection Prevention
app.use(mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    console.warn(`[SECURITY] NoSQL injection attempt blocked: ${key}`);
  }
}));

// 6. HTTP Parameter Pollution Prevention
app.use(hpp());

// 7. API Key validation middleware (for sensitive endpoints)
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  // For public booking endpoints, API key is optional but logged
  if (!apiKey) {
    // Allow public access but log it
    return next();
  }
  
  if (apiKey !== API_SECRET_KEY) {
    console.warn(`[SECURITY] Invalid API key attempt from ${req.ip}`);
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }
  
  next();
};

// 8. Input sanitization function
const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  return input
    .replace(/[<>]/g, '') // Remove HTML tags
    .replace(/javascript:/gi, '') // Remove JS protocol
    .replace(/on\w+=/gi, '') // Remove event handlers
    .trim()
    .substring(0, 500); // Limit length
};

// 9. Remove X-Powered-By
app.disable('x-powered-by');

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

// Get team members for a clinic (from owners database)
app.get('/api/team-members', async (req, res) => {
  try {
    const { clinicEmail } = req.query;
    
    if (!clinicEmail) {
      return res.json({ success: false, error: 'clinicEmail is required', teamMembers: [] });
    }
    
    // Connect to owners database
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const ownersDb = client.db('test'); // owners are stored in 'test' database
    
    const owner = await ownersDb.collection('owners').findOne({ 
      email: clinicEmail.toLowerCase() 
    });
    
    await client.close();
    
    if (!owner || !owner.teamMembers || owner.teamMembers.length === 0) {
      return res.json({ success: true, teamMembers: [] });
    }
    
    // Return only active team members with necessary fields
    const activeMembers = owner.teamMembers
      .filter(m => m.isActive !== false)
      .map(m => ({
        _id: m._id.toString(),
        name: m.name,
        role: m.role || 'Specialist',
        color: m.color || '#10b981'
      }));
    
    res.json({ success: true, teamMembers: activeMembers });
  } catch (error) {
    console.error('Get team members error:', error);
    res.json({ success: false, error: error.message, teamMembers: [] });
  }
});

// Generate unique cancel token
function generateCancelToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Send confirmation email via Brevo - Premium Template
async function sendConfirmationEmail(booking) {
  if (!BREVO_API_KEY) {
    console.log('Skipping email - BREVO_API_KEY not configured');
    return false;
  }

  const CLINIC_NAME = booking.clinicName || 'Clinic';
  const CLINIC_EMAIL = booking.clinicEmail || '';
  const CLINIC_PHONE = booking.clinicPhone || '';
  const CLINIC_ADDRESS = booking.clinicAddress || '';
  const WEBSITE_URL = booking.websiteUrl || '';

  const cancelUrl = `${WEBSITE_URL}/pages/cancel-booking?token=${booking.cancelToken}&id=${booking.id}`;
  
  const dateObj = new Date(booking.date + 'T' + booking.time);
  const formattedDate = dateObj.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e5e5e5;">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #059669 0%, #10b981 100%); padding: 50px 40px; text-align: center;">
              <table width="70" height="70" align="center" style="background: rgba(255,255,255,0.2); border-radius: 50%;"><tr><td align="center" valign="middle" style="font-size: 32px; color: #ffffff; font-weight: bold;">&#10003;</td></tr></table>
              <h1 style="color: #ffffff; margin: 24px 0 8px; font-size: 32px; font-weight: 600;">Booking Confirmed</h1>
              <p style="color: rgba(255,255,255,0.9); margin: 0; font-size: 18px;">Your appointment has been scheduled</p>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="padding: 40px 40px 24px;">
              <p style="color: #1a1a1a; font-size: 20px; margin: 0; line-height: 1.5;">
                Dear <strong>${booking.name}</strong>,
              </p>
              <p style="color: #666666; font-size: 18px; margin: 16px 0 0; line-height: 1.6;">
                Thank you for choosing ${CLINIC_NAME}. We look forward to seeing you.
              </p>
            </td>
          </tr>
          
          <!-- Appointment Details -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: #f8f9fa; border-radius: 12px; border: 1px solid #e9ecef;">
                <tr>
                  <td style="padding: 28px;">
                    <p style="color: #6c757d; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 24px; border-bottom: 2px solid #e9ecef; padding-bottom: 12px;">Appointment Details</p>
                    
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding: 16px 0; border-bottom: 1px solid #e9ecef;">
                          <p style="color: #6c757d; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Date</p>
                          <p style="color: #1a1a1a; font-size: 20px; font-weight: 600; margin: 0;">${formattedDate}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 16px 0; border-bottom: 1px solid #e9ecef;">
                          <p style="color: #6c757d; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Time</p>
                          <p style="color: #1a1a1a; font-size: 20px; font-weight: 600; margin: 0;">${booking.time}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 16px 0; border-bottom: 1px solid #e9ecef;">
                          <p style="color: #6c757d; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Service</p>
                          <p style="color: #1a1a1a; font-size: 20px; font-weight: 600; margin: 0;">${booking.service}</p>
                        </td>
                      </tr>
                      ${booking.teamMemberName ? `<tr>
                        <td style="padding: 16px 0;${CLINIC_ADDRESS ? ' border-bottom: 1px solid #e9ecef;' : ''}">
                          <p style="color: #6c757d; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Specialist</p>
                          <p style="color: #1a1a1a; font-size: 20px; font-weight: 600; margin: 0;">${booking.teamMemberName}</p>
                        </td>
                      </tr>` : ''}
                      ${CLINIC_ADDRESS ? `<tr>
                        <td style="padding: 16px 0;">
                          <p style="color: #6c757d; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Location</p>
                          <p style="color: #1a1a1a; font-size: 20px; font-weight: 600; margin: 0;">${CLINIC_ADDRESS}</p>
                        </td>
                      </tr>` : ''}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Reference Number -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #059669 0%, #10b981 100%); border-radius: 12px;">
                <tr>
                  <td style="padding: 28px; text-align: center;">
                    <p style="color: rgba(255,255,255,0.9); font-size: 14px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 2px; font-weight: 600;">Booking Reference</p>
                    <p style="color: #ffffff; font-size: 28px; font-weight: 700; margin: 0; letter-spacing: 1px;">#${booking.id}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Cancel Section -->
          <tr>
            <td style="padding: 0 40px 40px; text-align: center;">
              <p style="color: #666666; font-size: 16px; margin: 0 0 20px; line-height: 1.6;">Need to reschedule? Cancel up to 6 hours before your appointment.</p>
              <a href="${cancelUrl}" style="display: inline-block; background: #ffffff; color: #dc2626; text-decoration: none; padding: 16px 36px; border-radius: 8px; font-size: 16px; font-weight: 600; border: 2px solid #dc2626;">Cancel Booking</a>
            </td>
          </tr>
          
          <!-- Contact -->
          <tr>
            <td style="padding: 28px 40px; background: #f8f9fa; border-top: 1px solid #e9ecef;">
              <p style="color: #6c757d; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 16px;">Contact Us</p>
              <p style="color: #1a1a1a; font-size: 16px; margin: 0 0 8px;">
                <a href="mailto:${CLINIC_EMAIL}" style="color: #059669; text-decoration: none;">${CLINIC_EMAIL}</a>
              </p>
              <p style="color: #1a1a1a; font-size: 16px; margin: 0;">
                <a href="tel:${CLINIC_PHONE}" style="color: #059669; text-decoration: none;">${CLINIC_PHONE}</a>
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px; text-align: center; background: #f8f9fa;">
              <p style="color: #999999; font-size: 14px; margin: 0;">${new Date().getFullYear()} ${CLINIC_NAME}. All rights reserved.</p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: {
          name: CLINIC_NAME,
          email: BREVO_SENDER_EMAIL
        },
        replyTo: {
          email: CLINIC_EMAIL,
          name: CLINIC_NAME
        },
        to: [{
          email: booking.email,
          name: booking.name
        }],
        subject: `Booking Confirmed - ${formattedDate} at ${booking.time}`,
        htmlContent: emailHtml
      })
    });

    if (response.ok) {
      console.log(`Confirmation email sent to ${booking.email}`);
      return true;
    } else {
      const error = await response.json();
      console.error('❌ Brevo API error:', error);
      return false;
    }
  } catch (error) {
    console.error('❌ Email sending error:', error.message);
    return false;
  }
}

// Send new booking notification to clinic owner - Premium Template with Cancel Option
async function sendOwnerBookingNotification(booking) {
  if (!BREVO_API_KEY) {
    console.log('Skipping owner notification - BREVO_API_KEY not configured');
    return false;
  }

  const CLINIC_NAME = booking.clinicName || 'Clinic';
  const CLINIC_EMAIL = booking.clinicEmail || '';
  const WEBSITE_URL = booking.websiteUrl || '';
  
  if (!CLINIC_EMAIL) {
    console.log('Skipping owner notification - no clinic email in booking');
    return false;
  }

  const ownerCancelUrl = `${WEBSITE_URL}/pages/cancel-booking?token=${booking.cancelToken}&id=${booking.id}&owner=true`;

  const dateObj = new Date(booking.date + 'T' + booking.time);
  const formattedDate = dateObj.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });

  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e5e5e5;">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #059669 0%, #10b981 100%); padding: 50px 40px; text-align: center;">
              <table width="70" height="70" align="center" style="background: rgba(255,255,255,0.2); border-radius: 50%;"><tr><td align="center" valign="middle" style="font-size: 32px; color: #ffffff; font-weight: bold;">+</td></tr></table>
              <h1 style="color: #ffffff; margin: 24px 0 8px; font-size: 32px; font-weight: 600;">New Booking</h1>
              <p style="color: rgba(255,255,255,0.9); margin: 0; font-size: 18px;">A new appointment has been scheduled</p>
            </td>
          </tr>
          
          <!-- Appointment Details -->
          <tr>
            <td style="padding: 40px 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%); border-radius: 12px; border: 1px solid #a7f3d0;">
                <tr>
                  <td style="padding: 28px;">
                    <p style="color: #047857; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 24px; border-bottom: 2px solid #a7f3d0; padding-bottom: 12px;">Appointment Details</p>
                    
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding: 16px 0; border-bottom: 1px solid #a7f3d0;">
                          <p style="color: #047857; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Date & Time</p>
                          <p style="color: #065f46; font-size: 20px; font-weight: 600; margin: 0;">${formattedDate} at ${booking.time}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 16px 0; border-bottom: 1px solid #a7f3d0;">
                          <p style="color: #047857; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Service</p>
                          <p style="color: #065f46; font-size: 20px; font-weight: 600; margin: 0;">${booking.service}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 16px 0;">
                          <p style="color: #047857; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Reference</p>
                          <p style="color: #065f46; font-size: 24px; font-weight: 700; margin: 0;">#${booking.id}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Client Information -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: #f8f9fa; border-radius: 12px; border: 1px solid #e9ecef;">
                <tr>
                  <td style="padding: 28px;">
                    <p style="color: #6c757d; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 24px; border-bottom: 2px solid #e9ecef; padding-bottom: 12px;">Client Information</p>
                    
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding: 16px 0; border-bottom: 1px solid #e9ecef;">
                          <p style="color: #6c757d; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Name</p>
                          <p style="color: #1a1a1a; font-size: 20px; font-weight: 600; margin: 0;">${booking.name}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 16px 0; border-bottom: 1px solid #e9ecef;">
                          <p style="color: #6c757d; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Email</p>
                          <p style="margin: 0;"><a href="mailto:${booking.email}" style="color: #059669; font-size: 18px; text-decoration: none;">${booking.email}</a></p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 16px 0;${booking.notes ? ' border-bottom: 1px solid #e9ecef;' : ''}">
                          <p style="color: #6c757d; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Phone</p>
                          <p style="margin: 0;"><a href="tel:${booking.phone}" style="color: #059669; font-size: 18px; text-decoration: none;">${booking.phone || 'Not provided'}</a></p>
                        </td>
                      </tr>
                      ${booking.notes ? `<tr>
                        <td style="padding: 16px 0;">
                          <p style="color: #6c757d; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Notes</p>
                          <p style="color: #1a1a1a; font-size: 16px; margin: 0; line-height: 1.6;">${booking.notes}</p>
                        </td>
                      </tr>` : ''}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Owner Cancel Button -->
          <tr>
            <td style="padding: 0 40px 40px; text-align: center;">
              <p style="color: #666666; font-size: 16px; margin: 0 0 20px;">Need to cancel this booking?</p>
              <a href="${ownerCancelUrl}" style="display: inline-block; background: #ffffff; color: #dc2626; text-decoration: none; padding: 16px 36px; border-radius: 8px; font-size: 16px; font-weight: 600; border: 2px solid #dc2626;">Cancel This Booking</a>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px; text-align: center; background: #f8f9fa; border-top: 1px solid #e9ecef;">
              <p style="color: #999999; font-size: 14px; margin: 0;">${CLINIC_NAME} Booking System</p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: {
          name: `${CLINIC_NAME} Bookings`,
          email: BREVO_SENDER_EMAIL
        },
        to: [{
          email: CLINIC_EMAIL,
          name: CLINIC_NAME
        }],
        subject: `New Booking - ${booking.name} | ${formattedDate} at ${booking.time}`,
        htmlContent: emailHtml
      })
    });

    if (response.ok) {
      console.log(`Owner notification sent to ${CLINIC_EMAIL}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Owner notification error:', error.message);
    return false;
  }
}

// Send cancellation notification to clinic owner - Premium Template
async function sendOwnerCancellationNotification(booking) {
  if (!BREVO_API_KEY) {
    console.log('Skipping owner notification - BREVO_API_KEY not configured');
    return false;
  }

  const CLINIC_NAME = booking.clinicName || 'Clinic';
  const CLINIC_EMAIL = booking.clinicEmail || '';
  
  if (!CLINIC_EMAIL) {
    console.log('Skipping owner notification - no clinic email in booking');
    return false;
  }

  const dateObj = new Date(booking.date + 'T' + booking.time);
  const formattedDate = dateObj.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });

  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e5e5e5;">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #dc2626 0%, #ef4444 100%); padding: 50px 40px; text-align: center;">
              <table width="70" height="70" align="center" style="background: rgba(255,255,255,0.2); border-radius: 50%;"><tr><td align="center" valign="middle" style="font-size: 32px; color: #ffffff; font-weight: bold;">X</td></tr></table>
              <h1 style="color: #ffffff; margin: 24px 0 8px; font-size: 32px; font-weight: 600;">Booking Cancelled</h1>
              <p style="color: rgba(255,255,255,0.9); margin: 0; font-size: 18px;">An appointment has been cancelled</p>
            </td>
          </tr>
          
          <!-- Cancelled Appointment Details -->
          <tr>
            <td style="padding: 40px 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%); border-radius: 12px; border: 1px solid #fecaca;">
                <tr>
                  <td style="padding: 28px;">
                    <p style="color: #991b1b; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 24px; border-bottom: 2px solid #fecaca; padding-bottom: 12px;">Cancelled Appointment</p>
                    
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding: 16px 0; border-bottom: 1px solid #fecaca;">
                          <p style="color: #991b1b; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Date & Time</p>
                          <p style="color: #7f1d1d; font-size: 20px; font-weight: 600; margin: 0;">${formattedDate} at ${booking.time}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 16px 0; border-bottom: 1px solid #fecaca;">
                          <p style="color: #991b1b; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Service</p>
                          <p style="color: #7f1d1d; font-size: 20px; font-weight: 600; margin: 0;">${booking.service}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 16px 0;">
                          <p style="color: #991b1b; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Reference</p>
                          <p style="color: #dc2626; font-size: 24px; font-weight: 700; margin: 0;">#${booking.id}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Client Information -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: #f8f9fa; border-radius: 12px; border: 1px solid #e9ecef;">
                <tr>
                  <td style="padding: 28px;">
                    <p style="color: #6c757d; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 24px; border-bottom: 2px solid #e9ecef; padding-bottom: 12px;">Client Information</p>
                    
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding: 16px 0; border-bottom: 1px solid #e9ecef;">
                          <p style="color: #6c757d; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Name</p>
                          <p style="color: #1a1a1a; font-size: 20px; font-weight: 600; margin: 0;">${booking.name}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 16px 0; border-bottom: 1px solid #e9ecef;">
                          <p style="color: #6c757d; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Email</p>
                          <p style="margin: 0;"><a href="mailto:${booking.email}" style="color: #059669; font-size: 18px; text-decoration: none;">${booking.email}</a></p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 16px 0;">
                          <p style="color: #6c757d; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Phone</p>
                          <p style="margin: 0;"><a href="tel:${booking.phone}" style="color: #059669; font-size: 18px; text-decoration: none;">${booking.phone || 'Not provided'}</a></p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Slot Released Notice -->
          <tr>
            <td style="padding: 0 40px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 12px; border: 1px solid #fcd34d;">
                <tr>
                  <td style="padding: 24px;">
                    <p style="color: #92400e; font-size: 18px; font-weight: 600; margin: 0 0 8px;">Time Slot Released</p>
                    <p style="color: #a16207; font-size: 16px; margin: 0;">${booking.time} on ${formattedDate} is now available for new bookings.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px; text-align: center; background: #f8f9fa; border-top: 1px solid #e9ecef;">
              <p style="color: #999999; font-size: 14px; margin: 0;">${CLINIC_NAME} Booking System</p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: {
          name: `${CLINIC_NAME} Bookings`,
          email: BREVO_SENDER_EMAIL
        },
        to: [{
          email: CLINIC_EMAIL,
          name: CLINIC_NAME
        }],
        subject: `Booking Cancelled - ${booking.name} | ${formattedDate} at ${booking.time}`,
        htmlContent: emailHtml
      })
    });

    if (response.ok) {
      console.log(`Owner cancellation notification sent to ${CLINIC_EMAIL}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Owner notification error:', error.message);
    return false;
  }
}

// Send cancellation confirmation email to client - Premium Template
async function sendCancellationEmail(booking) {
  if (!BREVO_API_KEY) {
    console.log('Skipping email - BREVO_API_KEY not configured');
    return false;
  }

  const CLINIC_NAME = booking.clinicName || 'Clinic';
  const CLINIC_EMAIL = booking.clinicEmail || '';
  const WEBSITE_URL = booking.websiteUrl || '';

  const dateObj = new Date(booking.date + 'T' + booking.time);
  const formattedDate = dateObj.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });

  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e5e5e5;">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #6b7280 0%, #9ca3af 100%); padding: 50px 40px; text-align: center;">
              <table width="70" height="70" align="center" style="background: rgba(255,255,255,0.2); border-radius: 50%;"><tr><td align="center" valign="middle" style="font-size: 32px; color: #ffffff; font-weight: bold;">X</td></tr></table>
              <h1 style="color: #ffffff; margin: 24px 0 8px; font-size: 32px; font-weight: 600;">Booking Cancelled</h1>
              <p style="color: rgba(255,255,255,0.9); margin: 0; font-size: 18px;">Your appointment has been cancelled</p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 40px 24px;">
              <p style="color: #1a1a1a; font-size: 20px; margin: 0 0 16px;">Dear <strong>${booking.name}</strong>,</p>
              <p style="color: #666666; font-size: 18px; margin: 0; line-height: 1.6;">Your appointment scheduled for <strong style="color: #1a1a1a;">${formattedDate}</strong> at <strong style="color: #1a1a1a;">${booking.time}</strong> has been successfully cancelled.</p>
            </td>
          </tr>
          
          <!-- Cancelled Reference -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: #f8f9fa; border-radius: 12px; border: 1px solid #e9ecef;">
                <tr>
                  <td style="padding: 28px; text-align: center;">
                    <p style="color: #6c757d; font-size: 14px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 2px; font-weight: 700;">Cancelled Booking</p>
                    <p style="color: #1a1a1a; font-size: 28px; font-weight: 600; margin: 0;">#${booking.id}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Message -->
          <tr>
            <td style="padding: 0 40px 32px; text-align: center;">
              <p style="color: #666666; font-size: 18px; margin: 0; line-height: 1.6;">We hope to see you again soon.</p>
            </td>
          </tr>
          
          <!-- Book Again Button -->
          <tr>
            <td style="padding: 0 40px 40px; text-align: center;">
              <a href="${WEBSITE_URL}/pages/booking" style="display: inline-block; background: linear-gradient(135deg, #059669 0%, #10b981 100%); color: #ffffff; text-decoration: none; padding: 18px 44px; border-radius: 8px; font-size: 18px; font-weight: 600;">Book New Appointment</a>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px; text-align: center; background: #f8f9fa; border-top: 1px solid #e9ecef;">
              <p style="color: #999999; font-size: 14px; margin: 0;">${new Date().getFullYear()} ${CLINIC_NAME}. All rights reserved.</p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: {
          name: CLINIC_NAME,
          email: BREVO_SENDER_EMAIL
        },
        replyTo: {
          email: CLINIC_EMAIL,
          name: CLINIC_NAME
        },
        to: [{
          email: booking.email,
          name: booking.name
        }],
        subject: `Booking Cancelled - ${formattedDate}`,
        htmlContent: emailHtml
      })
    });

    if (response.ok) {
      console.log(`Cancellation email sent to ${booking.email}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Email sending error:', error.message);
    return false;
  }
}

// Send cancellation email to client when OWNER cancels - Apologetic Template
async function sendOwnerCancelledClientEmail(booking) {
  if (!BREVO_API_KEY) {
    console.log('Skipping email - BREVO_API_KEY not configured');
    return false;
  }

  const CLINIC_NAME = booking.clinicName || 'Clinic';
  const CLINIC_EMAIL = booking.clinicEmail || '';
  const CLINIC_PHONE = booking.clinicPhone || '';
  const WEBSITE_URL = booking.websiteUrl || '';

  const dateObj = new Date(booking.date + 'T' + booking.time);
  const formattedDate = dateObj.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });

  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e5e5e5;">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #d97706 0%, #f59e0b 100%); padding: 50px 40px; text-align: center;">
              <table width="70" height="70" align="center" style="background: rgba(255,255,255,0.2); border-radius: 50%;"><tr><td align="center" valign="middle" style="font-size: 32px; color: #ffffff; font-weight: bold;">!</td></tr></table>
              <h1 style="color: #ffffff; margin: 24px 0 8px; font-size: 32px; font-weight: 600;">Appointment Cancelled</h1>
              <p style="color: rgba(255,255,255,0.9); margin: 0; font-size: 18px;">We're sorry for the inconvenience</p>
            </td>
          </tr>
          
          <!-- Apology Message -->
          <tr>
            <td style="padding: 40px 40px 24px;">
              <p style="color: #1a1a1a; font-size: 20px; margin: 0 0 20px;">Dear <strong>${booking.name}</strong>,</p>
              <p style="color: #666666; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">We sincerely apologize, but we need to cancel your appointment scheduled for <strong style="color: #1a1a1a;">${formattedDate}</strong> at <strong style="color: #1a1a1a;">${booking.time}</strong>.</p>
              <p style="color: #666666; font-size: 18px; margin: 0; line-height: 1.6;">Due to unforeseen circumstances, we are unable to accommodate this booking. We truly value your time and apologize for any inconvenience this may cause.</p>
            </td>
          </tr>
          
          <!-- Cancelled Booking Details -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 12px; border: 1px solid #fcd34d;">
                <tr>
                  <td style="padding: 28px;">
                    <p style="color: #92400e; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 24px; border-bottom: 2px solid #fcd34d; padding-bottom: 12px;">Cancelled Appointment</p>
                    
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding: 16px 0; border-bottom: 1px solid #fcd34d;">
                          <p style="color: #92400e; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Date & Time</p>
                          <p style="color: #78350f; font-size: 20px; font-weight: 600; margin: 0;">${formattedDate} at ${booking.time}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 16px 0; border-bottom: 1px solid #fcd34d;">
                          <p style="color: #92400e; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Service</p>
                          <p style="color: #78350f; font-size: 20px; font-weight: 600; margin: 0;">${booking.service}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 16px 0;">
                          <p style="color: #92400e; font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 1px;">Reference</p>
                          <p style="color: #b45309; font-size: 24px; font-weight: 700; margin: 0;">#${booking.id}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Reschedule Message -->
          <tr>
            <td style="padding: 0 40px 32px; text-align: center;">
              <p style="color: #666666; font-size: 18px; margin: 0; line-height: 1.6;">We would love to reschedule your appointment at a time that works for you.</p>
            </td>
          </tr>
          
          <!-- Book Again Button -->
          <tr>
            <td style="padding: 0 40px 32px; text-align: center;">
              <a href="${WEBSITE_URL}/pages/booking" style="display: inline-block; background: linear-gradient(135deg, #059669 0%, #10b981 100%); color: #ffffff; text-decoration: none; padding: 18px 44px; border-radius: 8px; font-size: 18px; font-weight: 600;">Reschedule Appointment</a>
            </td>
          </tr>
          
          <!-- Contact Section -->
          <tr>
            <td style="padding: 0 40px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: #f8f9fa; border-radius: 12px; border: 1px solid #e9ecef;">
                <tr>
                  <td style="padding: 28px; text-align: center;">
                    <p style="color: #6c757d; font-size: 14px; margin: 0 0 16px; text-transform: uppercase; letter-spacing: 2px; font-weight: 700;">Questions? Contact Us</p>
                    <p style="color: #1a1a1a; font-size: 16px; margin: 0 0 8px;">
                      <a href="mailto:${CLINIC_EMAIL}" style="color: #059669; text-decoration: none;">${CLINIC_EMAIL}</a>
                    </p>
                    <p style="color: #1a1a1a; font-size: 16px; margin: 0;">
                      <a href="tel:${CLINIC_PHONE}" style="color: #059669; text-decoration: none;">${CLINIC_PHONE}</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px; text-align: center; background: #f8f9fa; border-top: 1px solid #e9ecef;">
              <p style="color: #999999; font-size: 14px; margin: 0;">${new Date().getFullYear()} ${CLINIC_NAME}. All rights reserved.</p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: {
          name: CLINIC_NAME,
          email: BREVO_SENDER_EMAIL
        },
        replyTo: {
          email: CLINIC_EMAIL,
          name: CLINIC_NAME
        },
        to: [{
          email: booking.email,
          name: booking.name
        }],
        subject: `Important: Your Appointment Has Been Cancelled - ${formattedDate}`,
        htmlContent: emailHtml
      })
    });

    if (response.ok) {
      console.log(`Owner-cancelled notification sent to client ${booking.email}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Email sending error:', error.message);
    return false;
  }
}

// Create a booking (with rate limiting and input sanitization)
app.post('/api/bookings', bookingLimiter, async (req, res) => {
  try {
    const { 
      date, time, service, name, email, phone, timezone, notes, slotsPerHour,
      // Website/Clinic info - sent from each website
      clinicName, clinicEmail, clinicPhone, clinicAddress, websiteUrl
    } = req.body;
    
    // Validate required fields
    if (!date || !time) {
      return res.status(400).json({ success: false, error: 'Date and time are required' });
    }
    
    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, error: 'Invalid date format' });
    }
    
    // Validate time format (HH:MM)
    if (!/^\d{2}:\d{2}$/.test(time)) {
      return res.status(400).json({ success: false, error: 'Invalid time format' });
    }
    
    // Validate email format if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }
    
    // Log booking attempt
    console.log(`[BOOKING] Attempt from ${req.ip}: ${date} ${time} - ${sanitizeInput(name)}`);
    
    
    const database = await connectDB();
    const maxSlots = slotsPerHour || 1;
    
    // Count existing bookings for this slot (per clinic)
    const existingCount = await database.collection('bookings').countDocuments({ 
      date, 
      time, 
      clinicEmail: clinicEmail ? clinicEmail.toLowerCase().trim() : '',
      status: { $nin: ['cancelled', 'no-show'] } 
    });
    
    if (existingCount >= maxSlots) {
      return res.status(409).json({ 
        success: false, 
        error: 'This time slot is fully booked. Please choose another time.' 
      });
    }
    
    // Generate unique cancel token
    const cancelToken = generateCancelToken();
    
    // Create booking with sanitized clinic info
    const booking = {
      id: Date.now(),
      date,
      time,
      service: sanitizeInput(service) || 'Consultation',
      name: sanitizeInput(name) || 'Guest',
      email: email ? email.toLowerCase().trim() : '',
      phone: sanitizeInput(phone) || '',
      timezone: timezone || 'UTC',
      notes: sanitizeInput(notes) || '',
      cancelToken,
      status: 'confirmed',
      // Store sanitized clinic/website info with the booking
      clinicName: sanitizeInput(clinicName) || 'Clinic',
      clinicEmail: clinicEmail ? clinicEmail.toLowerCase().trim() : '',
      clinicPhone: sanitizeInput(clinicPhone) || '',
      clinicAddress: sanitizeInput(clinicAddress) || '',
      websiteUrl: sanitizeInput(websiteUrl) || '',
      // Team member info (from Shopify form)
      teamMemberId: req.body.teamMemberId || '',
      teamMemberName: sanitizeInput(req.body.teamMemberName) || '',
      createdAt: new Date().toISOString(),
      source: 'shopify'
    };
    
    await database.collection('bookings').insertOne(booking);
    
    console.log(`✅ Booking created: ${date} ${time} - ${name} (${clinicName})`);
    
    // Send confirmation email to client
    if (email) {
      sendConfirmationEmail(booking);
    }
    
    // Send notification to clinic owner about new booking
    if (clinicEmail) {
      sendOwnerBookingNotification(booking);
    }
    
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

// Get booking details by token (for cancel page)
app.get('/api/bookings/details', async (req, res) => {
  try {
    const { token, id } = req.query;
    
    if (!token || !id) {
      return res.status(400).json({ success: false, error: 'Token and ID are required' });
    }
    
    const database = await connectDB();
    const booking = await database.collection('bookings').findOne({
      id: parseInt(id),
      cancelToken: token,
      status: { $ne: 'cancelled' }
    });
    
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found or already cancelled' });
    }
    
    // Check if cancellation is allowed (6 hours before)
    const bookingDateTime = new Date(`${booking.date}T${booking.time}`);
    const now = new Date();
    const hoursUntilBooking = (bookingDateTime - now) / (1000 * 60 * 60);
    const canCancel = hoursUntilBooking >= 6;
    
    res.json({
      success: true,
      booking: {
        id: booking.id,
        date: booking.date,
        time: booking.time,
        service: booking.service,
        name: booking.name,
        email: booking.email,
        phone: booking.phone
      },
      canCancel,
      hoursUntilBooking: Math.round(hoursUntilBooking * 10) / 10,
      message: canCancel ? null : 'Cancellation is only allowed up to 6 hours before the appointment.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cancel booking with token (secure cancel - 6-hour rule for clients, no limit for owners)
app.post('/api/bookings/cancel', async (req, res) => {
  try {
    const { token, id, owner } = req.body;
    
    if (!token || !id) {
      return res.status(400).json({ success: false, error: 'Token and ID are required' });
    }
    
    const isOwnerCancel = owner === true || owner === 'true';
    
    const database = await connectDB();
    
    // Find the booking
    const booking = await database.collection('bookings').findOne({
      id: parseInt(id),
      cancelToken: token,
      status: { $ne: 'cancelled' }
    });
    
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found or already cancelled' });
    }
    
    // Check 6-hour rule only for client cancellations, not for owner
    if (!isOwnerCancel) {
      const bookingDateTime = new Date(`${booking.date}T${booking.time}`);
      const now = new Date();
      const hoursUntilBooking = (bookingDateTime - now) / (1000 * 60 * 60);
      
      if (hoursUntilBooking < 6) {
        return res.status(400).json({ 
          success: false, 
          error: `Cannot cancel booking less than 6 hours before the appointment. Your appointment is in ${Math.round(hoursUntilBooking * 10) / 10} hours.`
        });
      }
    }
    
    // Delete the booking (this unblocks the slot)
    await database.collection('bookings').deleteOne({ id: parseInt(id) });
    
    console.log(`Booking cancelled${isOwnerCancel ? ' by owner' : ''}: ${booking.date} ${booking.time} - ${booking.name}`);
    
    // Send cancellation email to client - different template if owner cancels
    if (booking.email) {
      if (isOwnerCancel) {
        sendOwnerCancelledClientEmail(booking); // Apologetic email when owner cancels
      } else {
        sendCancellationEmail(booking); // Normal cancellation email when client cancels
      }
    }
    
    // Send notification to clinic owner only if cancelled by client
    if (!isOwnerCancel) {
      sendOwnerCancellationNotification(booking);
    }
    
    res.json({ 
      success: true, 
      message: 'Booking cancelled successfully. The time slot is now available for others.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const database = await connectDB();
    res.status(200).json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      mongodb: database ? 'connected' : 'disconnected'
    });
  } catch (err) {
    res.status(200).json({ status: 'ok', mongodb: 'reconnecting' });
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
