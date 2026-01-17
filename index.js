const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

// MongoDB Connection - MUST be set in environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = 'bookingsbuildhaze@gmail.com'; // Must be verified in Brevo

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
<body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #e8eef3;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #e8eef3; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background: #e8eef3; border-radius: 32px; overflow: hidden; box-shadow: 20px 20px 60px #c5c9cd, -20px -20px 60px #ffffff;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 50px 40px 40px; text-align: center;">
              <div style="width: 80px; height: 80px; background: #e8eef3; border-radius: 50%; margin: 0 auto 24px; box-shadow: 8px 8px 16px #c5c9cd, -8px -8px 16px #ffffff; display: inline-block;">
                <table width="80" height="80"><tr><td align="center" valign="middle" style="font-size: 36px; color: #10b981;">&#10003;</td></tr></table>
              </div>
              <h1 style="color: #1e293b; margin: 0 0 8px; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">Booking Confirmed</h1>
              <p style="color: #64748b; margin: 0; font-size: 15px; font-weight: 400;">Your appointment has been scheduled</p>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <p style="color: #1e293b; font-size: 16px; margin: 0; line-height: 1.6;">
                Dear <strong>${booking.name}</strong>,
              </p>
              <p style="color: #64748b; font-size: 15px; margin: 12px 0 0; line-height: 1.7;">
                Thank you for choosing ${CLINIC_NAME}. We look forward to seeing you.
              </p>
            </td>
          </tr>
          
          <!-- Appointment Card - Neumorphic -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: #e8eef3; border-radius: 20px; box-shadow: inset 6px 6px 12px #c5c9cd, inset -6px -6px 12px #ffffff;">
                <tr>
                  <td style="padding: 28px;">
                    <p style="color: #94a3b8; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 20px;">Appointment Details</p>
                    
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="40" valign="top" style="padding: 14px 0;">
                          <div style="width: 36px; height: 36px; background: #e8eef3; border-radius: 10px; box-shadow: 4px 4px 8px #c5c9cd, -4px -4px 8px #ffffff; text-align: center; line-height: 36px; font-size: 16px;">&#128197;</div>
                        </td>
                        <td style="padding: 14px 0 14px 16px; border-bottom: 1px solid rgba(148,163,184,0.2);">
                          <p style="color: #94a3b8; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Date</p>
                          <p style="color: #1e293b; font-size: 16px; font-weight: 600; margin: 0;">${formattedDate}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="40" valign="top" style="padding: 14px 0;">
                          <div style="width: 36px; height: 36px; background: #e8eef3; border-radius: 10px; box-shadow: 4px 4px 8px #c5c9cd, -4px -4px 8px #ffffff; text-align: center; line-height: 36px; font-size: 16px;">&#9200;</div>
                        </td>
                        <td style="padding: 14px 0 14px 16px; border-bottom: 1px solid rgba(148,163,184,0.2);">
                          <p style="color: #94a3b8; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Time</p>
                          <p style="color: #1e293b; font-size: 16px; font-weight: 600; margin: 0;">${booking.time}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="40" valign="top" style="padding: 14px 0;">
                          <div style="width: 36px; height: 36px; background: #e8eef3; border-radius: 10px; box-shadow: 4px 4px 8px #c5c9cd, -4px -4px 8px #ffffff; text-align: center; line-height: 36px; font-size: 16px;">&#9733;</div>
                        </td>
                        <td style="padding: 14px 0 14px 16px; border-bottom: 1px solid rgba(148,163,184,0.2);">
                          <p style="color: #94a3b8; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Service</p>
                          <p style="color: #1e293b; font-size: 16px; font-weight: 600; margin: 0;">${booking.service}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="40" valign="top" style="padding: 14px 0;">
                          <div style="width: 36px; height: 36px; background: #e8eef3; border-radius: 10px; box-shadow: 4px 4px 8px #c5c9cd, -4px -4px 8px #ffffff; text-align: center; line-height: 36px; font-size: 16px;">&#128205;</div>
                        </td>
                        <td style="padding: 14px 0 14px 16px;">
                          <p style="color: #94a3b8; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Location</p>
                          <p style="color: #1e293b; font-size: 16px; font-weight: 600; margin: 0;">${CLINIC_ADDRESS}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Reference Number - Neumorphic -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%); border-radius: 16px; box-shadow: 8px 8px 16px #c5c9cd, -8px -8px 16px #ffffff;">
                <tr>
                  <td style="padding: 24px; text-align: center;">
                    <p style="color: #047857; font-size: 11px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 2px; font-weight: 700;">Booking Reference</p>
                    <p style="color: #065f46; font-size: 24px; font-weight: 700; margin: 0; letter-spacing: 1px;">#${booking.id}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Cancel Section -->
          <tr>
            <td style="padding: 0 40px 40px; text-align: center;">
              <p style="color: #64748b; font-size: 13px; margin: 0 0 20px; line-height: 1.6;">Need to reschedule? Cancel up to 6 hours before your appointment.</p>
              <a href="${cancelUrl}" style="display: inline-block; background: #e8eef3; color: #dc2626; text-decoration: none; padding: 14px 32px; border-radius: 12px; font-size: 14px; font-weight: 600; box-shadow: 6px 6px 12px #c5c9cd, -6px -6px 12px #ffffff;">Cancel Booking</a>
            </td>
          </tr>
          
          <!-- Contact -->
          <tr>
            <td style="padding: 24px 40px; border-top: 1px solid rgba(148,163,184,0.3);">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="color: #94a3b8; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 12px;">Contact Us</p>
                    <p style="color: #475569; font-size: 14px; margin: 0 0 6px;">
                      <a href="mailto:${CLINIC_EMAIL}" style="color: #3b82f6; text-decoration: none;">${CLINIC_EMAIL}</a>
                    </p>
                    <p style="color: #475569; font-size: 14px; margin: 0;">
                      <a href="tel:${CLINIC_PHONE}" style="color: #3b82f6; text-decoration: none;">${CLINIC_PHONE}</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 40px; text-align: center;">
              <p style="color: #94a3b8; font-size: 12px; margin: 0;">${new Date().getFullYear()} ${CLINIC_NAME}. All rights reserved.</p>
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
<body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #e8eef3;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #e8eef3; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background: #e8eef3; border-radius: 32px; overflow: hidden; box-shadow: 20px 20px 60px #c5c9cd, -20px -20px 60px #ffffff;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 50px 40px 40px; text-align: center;">
              <div style="width: 80px; height: 80px; background: #e8eef3; border-radius: 50%; margin: 0 auto 24px; box-shadow: 8px 8px 16px #c5c9cd, -8px -8px 16px #ffffff; display: inline-block;">
                <table width="80" height="80"><tr><td align="center" valign="middle" style="font-size: 36px; color: #10b981;">&#43;</td></tr></table>
              </div>
              <h1 style="color: #1e293b; margin: 0 0 8px; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">New Booking</h1>
              <p style="color: #64748b; margin: 0; font-size: 15px; font-weight: 400;">A new appointment has been scheduled</p>
            </td>
          </tr>
          
          <!-- Appointment Details - Neumorphic -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%); border-radius: 20px; box-shadow: 8px 8px 16px #c5c9cd, -8px -8px 16px #ffffff;">
                <tr>
                  <td style="padding: 28px;">
                    <p style="color: #047857; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 20px;">Appointment Details</p>
                    
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="40" valign="top" style="padding: 12px 0;">
                          <div style="width: 36px; height: 36px; background: rgba(255,255,255,0.6); border-radius: 10px; text-align: center; line-height: 36px; font-size: 16px;">&#128197;</div>
                        </td>
                        <td style="padding: 12px 0 12px 16px; border-bottom: 1px solid rgba(5,150,105,0.2);">
                          <p style="color: #047857; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Date & Time</p>
                          <p style="color: #065f46; font-size: 16px; font-weight: 600; margin: 0;">${formattedDate} at ${booking.time}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="40" valign="top" style="padding: 12px 0;">
                          <div style="width: 36px; height: 36px; background: rgba(255,255,255,0.6); border-radius: 10px; text-align: center; line-height: 36px; font-size: 16px;">&#9733;</div>
                        </td>
                        <td style="padding: 12px 0 12px 16px; border-bottom: 1px solid rgba(5,150,105,0.2);">
                          <p style="color: #047857; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Service</p>
                          <p style="color: #065f46; font-size: 16px; font-weight: 600; margin: 0;">${booking.service}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="40" valign="top" style="padding: 12px 0;">
                          <div style="width: 36px; height: 36px; background: rgba(255,255,255,0.6); border-radius: 10px; text-align: center; line-height: 36px; font-size: 16px;">&#35;</div>
                        </td>
                        <td style="padding: 12px 0 12px 16px;">
                          <p style="color: #047857; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Reference</p>
                          <p style="color: #065f46; font-size: 18px; font-weight: 700; margin: 0;">#${booking.id}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Client Information - Neumorphic Inset -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: #e8eef3; border-radius: 20px; box-shadow: inset 6px 6px 12px #c5c9cd, inset -6px -6px 12px #ffffff;">
                <tr>
                  <td style="padding: 28px;">
                    <p style="color: #94a3b8; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 20px;">Client Information</p>
                    
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="40" valign="top" style="padding: 12px 0;">
                          <div style="width: 36px; height: 36px; background: #e8eef3; border-radius: 10px; box-shadow: 4px 4px 8px #c5c9cd, -4px -4px 8px #ffffff; text-align: center; line-height: 36px; font-size: 16px;">&#128100;</div>
                        </td>
                        <td style="padding: 12px 0 12px 16px; border-bottom: 1px solid rgba(148,163,184,0.2);">
                          <p style="color: #94a3b8; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Name</p>
                          <p style="color: #1e293b; font-size: 16px; font-weight: 600; margin: 0;">${booking.name}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="40" valign="top" style="padding: 12px 0;">
                          <div style="width: 36px; height: 36px; background: #e8eef3; border-radius: 10px; box-shadow: 4px 4px 8px #c5c9cd, -4px -4px 8px #ffffff; text-align: center; line-height: 36px; font-size: 16px;">&#9993;</div>
                        </td>
                        <td style="padding: 12px 0 12px 16px; border-bottom: 1px solid rgba(148,163,184,0.2);">
                          <p style="color: #94a3b8; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Email</p>
                          <p style="margin: 0;"><a href="mailto:${booking.email}" style="color: #3b82f6; font-size: 16px; text-decoration: none;">${booking.email}</a></p>
                        </td>
                      </tr>
                      <tr>
                        <td width="40" valign="top" style="padding: 12px 0;">
                          <div style="width: 36px; height: 36px; background: #e8eef3; border-radius: 10px; box-shadow: 4px 4px 8px #c5c9cd, -4px -4px 8px #ffffff; text-align: center; line-height: 36px; font-size: 16px;">&#9742;</div>
                        </td>
                        <td style="padding: 12px 0 12px 16px;${booking.notes ? ' border-bottom: 1px solid rgba(148,163,184,0.2);' : ''}">
                          <p style="color: #94a3b8; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Phone</p>
                          <p style="margin: 0;"><a href="tel:${booking.phone}" style="color: #3b82f6; font-size: 16px; text-decoration: none;">${booking.phone || 'Not provided'}</a></p>
                        </td>
                      </tr>
                      ${booking.notes ? `<tr>
                        <td width="40" valign="top" style="padding: 12px 0;">
                          <div style="width: 36px; height: 36px; background: #e8eef3; border-radius: 10px; box-shadow: 4px 4px 8px #c5c9cd, -4px -4px 8px #ffffff; text-align: center; line-height: 36px; font-size: 16px;">&#128221;</div>
                        </td>
                        <td style="padding: 12px 0 12px 16px;">
                          <p style="color: #94a3b8; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Notes</p>
                          <p style="color: #475569; font-size: 14px; margin: 0; line-height: 1.5;">${booking.notes}</p>
                        </td>
                      </tr>` : ''}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Owner Cancel Button - Neumorphic -->
          <tr>
            <td style="padding: 0 40px 40px; text-align: center;">
              <p style="color: #64748b; font-size: 13px; margin: 0 0 20px;">Need to cancel this booking?</p>
              <a href="${ownerCancelUrl}" style="display: inline-block; background: #e8eef3; color: #dc2626; text-decoration: none; padding: 14px 32px; border-radius: 12px; font-size: 14px; font-weight: 600; box-shadow: 6px 6px 12px #c5c9cd, -6px -6px 12px #ffffff;">Cancel This Booking</a>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 40px; text-align: center;">
              <p style="color: #94a3b8; font-size: 12px; margin: 0;">${CLINIC_NAME} Booking System</p>
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
<body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #e8eef3;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #e8eef3; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background: #e8eef3; border-radius: 32px; overflow: hidden; box-shadow: 20px 20px 60px #c5c9cd, -20px -20px 60px #ffffff;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 50px 40px 40px; text-align: center;">
              <div style="width: 80px; height: 80px; background: #e8eef3; border-radius: 50%; margin: 0 auto 24px; box-shadow: 8px 8px 16px #c5c9cd, -8px -8px 16px #ffffff; display: inline-block;">
                <table width="80" height="80"><tr><td align="center" valign="middle" style="font-size: 36px; color: #dc2626;">&#10005;</td></tr></table>
              </div>
              <h1 style="color: #1e293b; margin: 0 0 8px; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">Booking Cancelled</h1>
              <p style="color: #64748b; margin: 0; font-size: 15px; font-weight: 400;">An appointment has been cancelled</p>
            </td>
          </tr>
          
          <!-- Cancelled Appointment Details - Neumorphic -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%); border-radius: 20px; box-shadow: 8px 8px 16px #c5c9cd, -8px -8px 16px #ffffff;">
                <tr>
                  <td style="padding: 28px;">
                    <p style="color: #991b1b; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 20px;">Cancelled Appointment</p>
                    
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="40" valign="top" style="padding: 12px 0;">
                          <div style="width: 36px; height: 36px; background: rgba(255,255,255,0.6); border-radius: 10px; text-align: center; line-height: 36px; font-size: 16px;">&#128197;</div>
                        </td>
                        <td style="padding: 12px 0 12px 16px; border-bottom: 1px solid rgba(153,27,27,0.2);">
                          <p style="color: #991b1b; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Date & Time</p>
                          <p style="color: #7f1d1d; font-size: 16px; font-weight: 600; margin: 0;">${formattedDate} at ${booking.time}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="40" valign="top" style="padding: 12px 0;">
                          <div style="width: 36px; height: 36px; background: rgba(255,255,255,0.6); border-radius: 10px; text-align: center; line-height: 36px; font-size: 16px;">&#9733;</div>
                        </td>
                        <td style="padding: 12px 0 12px 16px; border-bottom: 1px solid rgba(153,27,27,0.2);">
                          <p style="color: #991b1b; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Service</p>
                          <p style="color: #7f1d1d; font-size: 16px; font-weight: 600; margin: 0;">${booking.service}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="40" valign="top" style="padding: 12px 0;">
                          <div style="width: 36px; height: 36px; background: rgba(255,255,255,0.6); border-radius: 10px; text-align: center; line-height: 36px; font-size: 16px;">&#35;</div>
                        </td>
                        <td style="padding: 12px 0 12px 16px;">
                          <p style="color: #991b1b; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Reference</p>
                          <p style="color: #dc2626; font-size: 18px; font-weight: 700; margin: 0;">#${booking.id}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Client Information - Neumorphic Inset -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: #e8eef3; border-radius: 20px; box-shadow: inset 6px 6px 12px #c5c9cd, inset -6px -6px 12px #ffffff;">
                <tr>
                  <td style="padding: 28px;">
                    <p style="color: #94a3b8; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 20px;">Client Information</p>
                    
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="40" valign="top" style="padding: 12px 0;">
                          <div style="width: 36px; height: 36px; background: #e8eef3; border-radius: 10px; box-shadow: 4px 4px 8px #c5c9cd, -4px -4px 8px #ffffff; text-align: center; line-height: 36px; font-size: 16px;">&#128100;</div>
                        </td>
                        <td style="padding: 12px 0 12px 16px; border-bottom: 1px solid rgba(148,163,184,0.2);">
                          <p style="color: #94a3b8; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Name</p>
                          <p style="color: #1e293b; font-size: 16px; font-weight: 600; margin: 0;">${booking.name}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="40" valign="top" style="padding: 12px 0;">
                          <div style="width: 36px; height: 36px; background: #e8eef3; border-radius: 10px; box-shadow: 4px 4px 8px #c5c9cd, -4px -4px 8px #ffffff; text-align: center; line-height: 36px; font-size: 16px;">&#9993;</div>
                        </td>
                        <td style="padding: 12px 0 12px 16px; border-bottom: 1px solid rgba(148,163,184,0.2);">
                          <p style="color: #94a3b8; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Email</p>
                          <p style="margin: 0;"><a href="mailto:${booking.email}" style="color: #3b82f6; font-size: 16px; text-decoration: none;">${booking.email}</a></p>
                        </td>
                      </tr>
                      <tr>
                        <td width="40" valign="top" style="padding: 12px 0;">
                          <div style="width: 36px; height: 36px; background: #e8eef3; border-radius: 10px; box-shadow: 4px 4px 8px #c5c9cd, -4px -4px 8px #ffffff; text-align: center; line-height: 36px; font-size: 16px;">&#9742;</div>
                        </td>
                        <td style="padding: 12px 0 12px 16px;">
                          <p style="color: #94a3b8; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px;">Phone</p>
                          <p style="margin: 0;"><a href="tel:${booking.phone}" style="color: #3b82f6; font-size: 16px; text-decoration: none;">${booking.phone || 'Not provided'}</a></p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Slot Released Notice - Neumorphic -->
          <tr>
            <td style="padding: 0 40px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 16px; box-shadow: 6px 6px 12px #c5c9cd, -6px -6px 12px #ffffff;">
                <tr>
                  <td style="padding: 20px 24px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="40" valign="middle">
                          <div style="width: 36px; height: 36px; background: rgba(255,255,255,0.6); border-radius: 10px; text-align: center; line-height: 36px; font-size: 18px;">&#9888;</div>
                        </td>
                        <td style="padding-left: 16px;">
                          <p style="color: #92400e; font-size: 14px; font-weight: 600; margin: 0 0 4px;">Time Slot Released</p>
                          <p style="color: #a16207; font-size: 13px; margin: 0;">${booking.time} on ${formattedDate} is now available.</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 40px; text-align: center;">
              <p style="color: #94a3b8; font-size: 12px; margin: 0;">${CLINIC_NAME} Booking System</p>
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
<body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #e8eef3;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #e8eef3; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background: #e8eef3; border-radius: 32px; overflow: hidden; box-shadow: 20px 20px 60px #c5c9cd, -20px -20px 60px #ffffff;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 50px 40px 40px; text-align: center;">
              <div style="width: 80px; height: 80px; background: #e8eef3; border-radius: 50%; margin: 0 auto 24px; box-shadow: 8px 8px 16px #c5c9cd, -8px -8px 16px #ffffff; display: inline-block;">
                <table width="80" height="80"><tr><td align="center" valign="middle" style="font-size: 36px; color: #64748b;">&#10005;</td></tr></table>
              </div>
              <h1 style="color: #1e293b; margin: 0 0 8px; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">Booking Cancelled</h1>
              <p style="color: #64748b; margin: 0; font-size: 15px; font-weight: 400;">Your appointment has been cancelled</p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <p style="color: #1e293b; font-size: 16px; margin: 0 0 12px;">Dear <strong>${booking.name}</strong>,</p>
              <p style="color: #64748b; font-size: 15px; margin: 0; line-height: 1.7;">Your appointment scheduled for <strong style="color: #1e293b;">${formattedDate}</strong> at <strong style="color: #1e293b;">${booking.time}</strong> has been successfully cancelled.</p>
            </td>
          </tr>
          
          <!-- Cancelled Reference - Neumorphic Inset -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: #e8eef3; border-radius: 16px; box-shadow: inset 6px 6px 12px #c5c9cd, inset -6px -6px 12px #ffffff;">
                <tr>
                  <td style="padding: 24px; text-align: center;">
                    <p style="color: #94a3b8; font-size: 11px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 2px; font-weight: 700;">Cancelled Booking</p>
                    <p style="color: #64748b; font-size: 22px; font-weight: 600; margin: 0;">#${booking.id}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Message -->
          <tr>
            <td style="padding: 0 40px 32px; text-align: center;">
              <p style="color: #64748b; font-size: 15px; margin: 0; line-height: 1.7;">We hope to see you again soon.</p>
            </td>
          </tr>
          
          <!-- Book Again Button - Neumorphic -->
          <tr>
            <td style="padding: 0 40px 40px; text-align: center;">
              <a href="${WEBSITE_URL}/pages/booking" style="display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 12px; font-size: 14px; font-weight: 600; box-shadow: 6px 6px 12px #c5c9cd, -6px -6px 12px #ffffff;">Book New Appointment</a>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 40px; text-align: center;">
              <p style="color: #94a3b8; font-size: 12px; margin: 0;">${new Date().getFullYear()} ${CLINIC_NAME}. All rights reserved.</p>
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

// Create a booking
app.post('/api/bookings', async (req, res) => {
  try {
    const { 
      date, time, service, name, email, phone, timezone, notes, slotsPerHour,
      // Website/Clinic info - sent from each website
      clinicName, clinicEmail, clinicPhone, clinicAddress, websiteUrl
    } = req.body;
    
    if (!date || !time) {
      return res.status(400).json({ success: false, error: 'Date and time are required' });
    }
    
    const database = await connectDB();
    const maxSlots = slotsPerHour || 1;
    
    // Count existing bookings for this slot
    const existingCount = await database.collection('bookings').countDocuments({ date, time, status: { $ne: 'cancelled' } });
    
    if (existingCount >= maxSlots) {
      return res.status(409).json({ 
        success: false, 
        error: 'This time slot is fully booked. Please choose another time.' 
      });
    }
    
    // Generate unique cancel token
    const cancelToken = generateCancelToken();
    
    // Create booking with clinic info from the website
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
      cancelToken,
      status: 'confirmed',
      // Store clinic/website info with the booking
      clinicName: clinicName || 'Clinic',
      clinicEmail: clinicEmail || '', // Owner's email for notifications
      clinicPhone: clinicPhone || '',
      clinicAddress: clinicAddress || '',
      websiteUrl: websiteUrl || '',
      createdAt: new Date().toISOString()
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
    
    // Send cancellation email to client
    if (booking.email) {
      sendCancellationEmail(booking);
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
