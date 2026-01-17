const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

// MongoDB Connection - MUST be set in environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = 'noreply@brevosend.com'; // Brevo's default sender - no verification needed

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

// Send confirmation email via Brevo
async function sendConfirmationEmail(booking) {
  if (!BREVO_API_KEY) {
    console.log('⚠️ Skipping email - BREVO_API_KEY not configured');
    return false;
  }

  // Use clinic info stored in the booking (from the website that created it)
  const CLINIC_NAME = booking.clinicName || 'Clinic';
  const CLINIC_EMAIL = booking.clinicEmail || '';
  const CLINIC_PHONE = booking.clinicPhone || '';
  const CLINIC_ADDRESS = booking.clinicAddress || '';
  const WEBSITE_URL = booking.websiteUrl || '';

  const cancelUrl = `${WEBSITE_URL}/pages/cancel-booking?token=${booking.cancelToken}&id=${booking.id}`;
  
  // Format date nicely
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
  <title>Booking Confirmation</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #f8f9fa;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8f9fa; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); padding: 48px 40px; text-align: center;">
              <div style="width: 80px; height: 80px; background: rgba(255,255,255,0.1); border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center;">
                <span style="font-size: 40px;">✨</span>
              </div>
              <h1 style="color: #ffffff; margin: 0 0 8px; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">Booking Confirmed!</h1>
              <p style="color: rgba(255,255,255,0.8); margin: 0; font-size: 16px;">Your appointment has been scheduled</p>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="padding: 40px 40px 24px;">
              <p style="color: #1a1a2e; font-size: 18px; margin: 0; line-height: 1.6;">
                Dear <strong>${booking.name}</strong>,
              </p>
              <p style="color: #64748b; font-size: 16px; margin: 16px 0 0; line-height: 1.6;">
                Thank you for choosing ${CLINIC_NAME}. We're excited to meet you and help you achieve your aesthetic goals.
              </p>
            </td>
          </tr>
          
          <!-- Booking Details Card -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); border-radius: 12px; border: 1px solid #e2e8f0;">
                <tr>
                  <td style="padding: 24px;">
                    <h2 style="color: #1a1a2e; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 20px; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0;">Appointment Details</h2>
                    
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0;">
                          <table width="100%">
                            <tr>
                              <td width="40" valign="top">
                                <span style="font-size: 20px;">📅</span>
                              </td>
                              <td>
                                <p style="color: #64748b; font-size: 12px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.5px;">Date</p>
                                <p style="color: #1a1a2e; font-size: 16px; font-weight: 600; margin: 0;">${formattedDate}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0;">
                          <table width="100%">
                            <tr>
                              <td width="40" valign="top">
                                <span style="font-size: 20px;">🕐</span>
                              </td>
                              <td>
                                <p style="color: #64748b; font-size: 12px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.5px;">Time</p>
                                <p style="color: #1a1a2e; font-size: 16px; font-weight: 600; margin: 0;">${booking.time}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0;">
                          <table width="100%">
                            <tr>
                              <td width="40" valign="top">
                                <span style="font-size: 20px;">💆</span>
                              </td>
                              <td>
                                <p style="color: #64748b; font-size: 12px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.5px;">Service</p>
                                <p style="color: #1a1a2e; font-size: 16px; font-weight: 600; margin: 0;">${booking.service}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 12px 0;">
                          <table width="100%">
                            <tr>
                              <td width="40" valign="top">
                                <span style="font-size: 20px;">📍</span>
                              </td>
                              <td>
                                <p style="color: #64748b; font-size: 12px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.5px;">Location</p>
                                <p style="color: #1a1a2e; font-size: 16px; font-weight: 600; margin: 0;">${CLINIC_ADDRESS}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Booking Reference -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background: #1a1a2e; border-radius: 12px;">
                <tr>
                  <td style="padding: 20px 24px; text-align: center;">
                    <p style="color: rgba(255,255,255,0.7); font-size: 12px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 1px;">Booking Reference</p>
                    <p style="color: #ffffff; font-size: 24px; font-weight: 700; margin: 0; letter-spacing: 2px;">#${booking.id}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- What to Bring -->
          <tr>
            <td style="padding: 0 40px 32px;">
              <h3 style="color: #1a1a2e; font-size: 16px; font-weight: 600; margin: 0 0 16px;">📋 What to Bring</h3>
              <ul style="color: #64748b; font-size: 14px; margin: 0; padding-left: 20px; line-height: 1.8;">
                <li>Valid photo ID</li>
                <li>List of current medications</li>
                <li>Any relevant medical records</li>
                <li>Questions you'd like to discuss</li>
              </ul>
            </td>
          </tr>
          
          <!-- Cancel Button -->
          <tr>
            <td style="padding: 0 40px 40px; text-align: center;">
              <p style="color: #64748b; font-size: 14px; margin: 0 0 16px;">Need to reschedule? You can cancel up to 6 hours before your appointment.</p>
              <a href="${cancelUrl}" style="display: inline-block; background: #ef4444; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 14px; font-weight: 600;">Cancel Booking</a>
            </td>
          </tr>
          
          <!-- Divider -->
          <tr>
            <td style="padding: 0 40px;">
              <div style="height: 1px; background: #e2e8f0;"></div>
            </td>
          </tr>
          
          <!-- Contact Info -->
          <tr>
            <td style="padding: 32px 40px;">
              <h3 style="color: #1a1a2e; font-size: 16px; font-weight: 600; margin: 0 0 16px;">📞 Contact Us</h3>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding: 8px 0;">
                    <span style="color: #64748b; font-size: 14px;">📧 Email: </span>
                    <a href="mailto:${CLINIC_EMAIL}" style="color: #3b82f6; text-decoration: none; font-size: 14px;">${CLINIC_EMAIL}</a>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 8px 0;">
                    <span style="color: #64748b; font-size: 14px;">📱 Phone: </span>
                    <a href="tel:${CLINIC_PHONE}" style="color: #3b82f6; text-decoration: none; font-size: 14px;">${CLINIC_PHONE}</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background: #f8fafc; padding: 24px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
              <p style="color: #94a3b8; font-size: 12px; margin: 0 0 8px;">© ${new Date().getFullYear()} ${CLINIC_NAME}. All rights reserved.</p>
              <p style="color: #94a3b8; font-size: 12px; margin: 0;">${CLINIC_ADDRESS}</p>
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
        subject: `✨ Booking Confirmed - ${formattedDate} at ${booking.time}`,
        htmlContent: emailHtml
      })
    });

    if (response.ok) {
      console.log(`📧 Confirmation email sent to ${booking.email}`);
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

// Send cancellation notification to clinic owner
async function sendOwnerCancellationNotification(booking) {
  if (!BREVO_API_KEY) {
    console.log('⚠️ Skipping owner notification - BREVO_API_KEY not configured');
    return false;
  }

  // Use clinic info stored in the booking
  const CLINIC_NAME = booking.clinicName || 'Clinic';
  const CLINIC_EMAIL = booking.clinicEmail || '';
  
  // Skip if no clinic email configured
  if (!CLINIC_EMAIL) {
    console.log('⚠️ Skipping owner notification - no clinic email in booking');
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
<body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #f8f9fa;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8f9fa; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 40px; text-align: center;">
              <div style="width: 64px; height: 64px; background: rgba(255,255,255,0.2); border-radius: 50%; margin: 0 auto 16px;">
                <span style="font-size: 32px; line-height: 64px;">🚨</span>
              </div>
              <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 600;">Booking Cancelled</h1>
              <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0; font-size: 14px;">A client has cancelled their appointment</p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 32px 40px;">
              <h2 style="color: #1a1a2e; font-size: 18px; margin: 0 0 20px; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px;">📋 Cancelled Appointment Details</h2>
              
              <table width="100%" cellpadding="0" cellspacing="0" style="background: #fef2f2; border-radius: 12px; border: 1px solid #fecaca;">
                <tr>
                  <td style="padding: 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding: 8px 0; border-bottom: 1px solid #fecaca;">
                          <span style="color: #991b1b; font-size: 12px; text-transform: uppercase;">Date & Time</span><br>
                          <span style="color: #1a1a2e; font-size: 16px; font-weight: 600;">${formattedDate} at ${booking.time}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; border-bottom: 1px solid #fecaca;">
                          <span style="color: #991b1b; font-size: 12px; text-transform: uppercase;">Service</span><br>
                          <span style="color: #1a1a2e; font-size: 16px; font-weight: 600;">${booking.service}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0;">
                          <span style="color: #991b1b; font-size: 12px; text-transform: uppercase;">Booking ID</span><br>
                          <span style="color: #1a1a2e; font-size: 16px; font-weight: 600;">#${booking.id}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <h2 style="color: #1a1a2e; font-size: 18px; margin: 24px 0 20px; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px;">👤 Client Information</h2>
              
              <table width="100%" cellpadding="0" cellspacing="0" style="background: #f8fafc; border-radius: 12px; border: 1px solid #e2e8f0;">
                <tr>
                  <td style="padding: 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                          <span style="color: #64748b; font-size: 12px; text-transform: uppercase;">Name</span><br>
                          <span style="color: #1a1a2e; font-size: 16px; font-weight: 600;">${booking.name}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                          <span style="color: #64748b; font-size: 12px; text-transform: uppercase;">Email</span><br>
                          <a href="mailto:${booking.email}" style="color: #3b82f6; font-size: 16px; text-decoration: none;">${booking.email}</a>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0;">
                          <span style="color: #64748b; font-size: 12px; text-transform: uppercase;">Phone</span><br>
                          <a href="tel:${booking.phone}" style="color: #3b82f6; font-size: 16px; text-decoration: none;">${booking.phone || 'Not provided'}</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 16px; margin-top: 24px;">
                <p style="color: #92400e; font-size: 14px; margin: 0;">
                  <strong>⏰ Time Slot Released:</strong> This time slot (${booking.time} on ${formattedDate}) is now available for new bookings.
                </p>
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background: #f8fafc; padding: 20px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
              <p style="color: #94a3b8; font-size: 12px; margin: 0;">This is an automated notification from ${CLINIC_NAME} Booking System</p>
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
          name: `${CLINIC_NAME} Booking System`,
          email: BREVO_SENDER_EMAIL
        },
        to: [{
          email: CLINIC_EMAIL,
          name: CLINIC_NAME
        }],
        subject: `🚨 Booking Cancelled - ${booking.name} (${formattedDate} at ${booking.time})`,
        htmlContent: emailHtml
      })
    });

    if (response.ok) {
      console.log(`📧 Owner notification sent to ${CLINIC_EMAIL}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('❌ Owner notification error:', error.message);
    return false;
  }
}

// Send cancellation confirmation email
async function sendCancellationEmail(booking) {
  if (!BREVO_API_KEY) {
    console.log('⚠️ Skipping email - BREVO_API_KEY not configured');
    return false;
  }

  // Use clinic info stored in the booking
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
<body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #f8f9fa;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8f9fa; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #64748b 0%, #475569 100%); padding: 48px 40px; text-align: center;">
              <div style="width: 80px; height: 80px; background: rgba(255,255,255,0.1); border-radius: 50%; margin: 0 auto 20px;">
                <span style="font-size: 40px; line-height: 80px;">📅</span>
              </div>
              <h1 style="color: #ffffff; margin: 0 0 8px; font-size: 28px; font-weight: 600;">Booking Cancelled</h1>
              <p style="color: rgba(255,255,255,0.8); margin: 0; font-size: 16px;">Your appointment has been cancelled</p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #1a1a2e; font-size: 18px; margin: 0 0 16px;">Dear <strong>${booking.name}</strong>,</p>
              <p style="color: #64748b; font-size: 16px; margin: 0 0 24px; line-height: 1.6;">Your appointment scheduled for <strong>${formattedDate}</strong> at <strong>${booking.time}</strong> has been successfully cancelled.</p>
              
              <table width="100%" cellpadding="0" cellspacing="0" style="background: #f8fafc; border-radius: 12px; border: 1px solid #e2e8f0;">
                <tr>
                  <td style="padding: 20px; text-align: center;">
                    <p style="color: #64748b; font-size: 12px; margin: 0 0 8px; text-transform: uppercase;">Cancelled Booking</p>
                    <p style="color: #1a1a2e; font-size: 20px; font-weight: 700; margin: 0;">#${booking.id}</p>
                  </td>
                </tr>
              </table>
              
              <p style="color: #64748b; font-size: 16px; margin: 24px 0; line-height: 1.6;">We're sorry to see you go! If you'd like to reschedule, please visit our website or contact us.</p>
              
              <div style="text-align: center;">
                <a href="${WEBSITE_URL}/pages/booking" style="display: inline-block; background: #1a1a2e; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 14px; font-weight: 600;">Book New Appointment</a>
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background: #f8fafc; padding: 24px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
              <p style="color: #94a3b8; font-size: 12px; margin: 0;">© ${new Date().getFullYear()} ${CLINIC_NAME}</p>
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
      console.log(`📧 Cancellation email sent to ${booking.email}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('❌ Email sending error:', error.message);
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
    
    // Send confirmation email
    if (email) {
      sendConfirmationEmail(booking);
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

// Cancel booking with token (secure cancel with 6-hour rule)
app.post('/api/bookings/cancel', async (req, res) => {
  try {
    const { token, id } = req.body;
    
    if (!token || !id) {
      return res.status(400).json({ success: false, error: 'Token and ID are required' });
    }
    
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
    
    // Check 6-hour rule
    const bookingDateTime = new Date(`${booking.date}T${booking.time}`);
    const now = new Date();
    const hoursUntilBooking = (bookingDateTime - now) / (1000 * 60 * 60);
    
    if (hoursUntilBooking < 6) {
      return res.status(400).json({ 
        success: false, 
        error: `Cannot cancel booking less than 6 hours before the appointment. Your appointment is in ${Math.round(hoursUntilBooking * 10) / 10} hours.`
      });
    }
    
    // Delete the booking (this unblocks the slot)
    await database.collection('bookings').deleteOne({ id: parseInt(id) });
    
    console.log(`🗑️ Booking cancelled: ${booking.date} ${booking.time} - ${booking.name}`);
    
    // Send cancellation email to client
    if (booking.email) {
      sendCancellationEmail(booking);
    }
    
    // Send notification to clinic owner
    sendOwnerCancellationNotification(booking);
    
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
