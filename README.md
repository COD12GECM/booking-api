# Booking API v2.0

Simple booking API for slot management with Shopify integration.

## Features
- ✅ 1 booking per slot (configurable)
- ✅ Slot availability checking
- ✅ CORS enabled for Shopify
- ✅ Simple JSON file storage

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Health check |
| GET | `/api/bookings` | Get booking counts by date-time |
| POST | `/api/bookings` | Create a booking |
| GET | `/api/bookings/all` | Get all bookings (admin) |
| DELETE | `/api/bookings/:id` | Delete a booking |
| GET | `/api/config` | Get slot configuration |
| POST | `/api/config` | Update slot configuration |

## Deploy to Render

1. Push to GitHub
2. Create new Web Service on Render
3. Connect to your repo
4. Build Command: `npm install`
5. Start Command: `npm start`

## Local Development

```bash
npm install
npm start
```

Server runs on http://localhost:3001
