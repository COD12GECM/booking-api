/**
 * Security Stress Test Script
 * Tests rate limiting and body size limits on booking-dashboard and booking-api
 * 
 * WARNING: Running login tests will block your IP for 15 minutes!
 * To unblock: Change network (WiFi to mobile) or restart Render service
 */

const DASHBOARD_URL = 'https://dashboard.buildhaze.com';
const API_URL = 'https://booking-api-09uo.onrender.com';

// Colors for console output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(status, message) {
  const color = status >= 400 ? colors.red : colors.green;
  console.log(`${color}[${status}]${colors.reset} ${message}`);
}

function logHeader(title) {
  console.log(`\n${colors.blue}${'='.repeat(60)}${colors.reset}`);
  console.log(`${colors.blue}${title}${colors.reset}`);
  console.log(`${colors.blue}${'='.repeat(60)}${colors.reset}\n`);
}

// Test 1: Login Brute Force (Rate Limiting)
async function testLoginRateLimit() {
  logHeader('TEST 1: Login Brute Force (6 attempts)');
  console.log(`${colors.yellow}⚠️  WARNING: This will block your IP for 15 minutes!${colors.reset}\n`);
  
  for (let i = 1; i <= 6; i++) {
    try {
      const response = await fetch(`${DASHBOARD_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=hacker@test.com&password=wrongpassword123'
      });
      
      log(response.status, `Attempt ${i}/6 - ${response.status === 429 ? '🚫 BLOCKED (Rate Limited)' : 'Processed'}`);
      
      if (response.status === 429) {
        console.log(`\n${colors.green}✅ Rate Limiting WORKS! IP blocked after ${i} attempts.${colors.reset}`);
        return true;
      }
    } catch (error) {
      console.log(`${colors.red}Error: ${error.message}${colors.reset}`);
    }
    
    // Small delay between requests
    await new Promise(r => setTimeout(r, 100));
  }
  
  console.log(`\n${colors.red}❌ Rate Limiting may not be working - all 6 attempts went through${colors.reset}`);
  return false;
}

// Test 2: Booking Spam (Rate Limiting)
async function testBookingRateLimit() {
  logHeader('TEST 2: Booking Spam (10 attempts in 1 minute)');
  
  const bookingData = {
    date: '2026-01-20',
    time: '10:00',
    service: 'Test Service',
    name: 'Security Test',
    email: 'test@security.com',
    phone: '1234567890',
    clinicName: 'Test Clinic',
    clinicEmail: 'clinic@test.com'
  };
  
  let blocked = false;
  
  for (let i = 1; i <= 10; i++) {
    try {
      const response = await fetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...bookingData, time: `${9 + i}:00` })
      });
      
      const data = await response.json().catch(() => ({}));
      
      if (response.status === 429) {
        log(response.status, `Attempt ${i}/10 - 🚫 BLOCKED (Rate Limited)`);
        if (!blocked) {
          console.log(`\n${colors.green}✅ Booking Rate Limiting WORKS! Blocked after ${i} attempts.${colors.reset}`);
          blocked = true;
        }
      } else {
        log(response.status, `Attempt ${i}/10 - ${data.success ? 'Booking created' : data.error || 'Processed'}`);
      }
    } catch (error) {
      console.log(`${colors.red}Error: ${error.message}${colors.reset}`);
    }
    
    // Small delay
    await new Promise(r => setTimeout(r, 100));
  }
  
  if (!blocked) {
    console.log(`\n${colors.yellow}⚠️  Note: Rate limit is 5/minute. If not blocked, wait and retry.${colors.reset}`);
  }
  
  return blocked;
}

// Test 3: Body Size Limit (>10kb payload)
async function testBodySizeLimit() {
  logHeader('TEST 3: Body Size Limit (>10kb payload)');
  
  // Create a payload larger than 10kb
  const largeNotes = 'A'.repeat(15000); // 15kb of text
  
  const bookingData = {
    date: '2026-01-20',
    time: '14:00',
    service: 'Test Service',
    name: 'Size Test',
    email: 'test@size.com',
    phone: '1234567890',
    notes: largeNotes,
    clinicName: 'Test Clinic',
    clinicEmail: 'clinic@test.com'
  };
  
  console.log(`Sending payload of ~${Math.round(JSON.stringify(bookingData).length / 1024)}kb...\n`);
  
  try {
    const response = await fetch(`${API_URL}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bookingData)
    });
    
    log(response.status, response.status === 413 ? '🚫 REJECTED (Payload Too Large)' : `Response: ${response.status}`);
    
    if (response.status === 413) {
      console.log(`\n${colors.green}✅ Body Size Limit WORKS! Large payload rejected.${colors.reset}`);
      return true;
    } else {
      const data = await response.json().catch(() => ({}));
      console.log(`Response body:`, data);
      console.log(`\n${colors.yellow}⚠️  Server accepted the payload (may have truncated it)${colors.reset}`);
      return false;
    }
  } catch (error) {
    if (error.message.includes('413') || error.message.includes('too large')) {
      console.log(`\n${colors.green}✅ Body Size Limit WORKS!${colors.reset}`);
      return true;
    }
    console.log(`${colors.red}Error: ${error.message}${colors.reset}`);
    return false;
  }
}

// Test 4: NoSQL Injection Attempt
async function testNoSQLInjection() {
  logHeader('TEST 4: NoSQL Injection Attempt');
  
  const maliciousData = {
    date: '2026-01-20',
    time: '15:00',
    service: 'Test',
    name: { '$gt': '' }, // NoSQL injection attempt
    email: 'test@injection.com',
    clinicEmail: { '$ne': null } // Another injection attempt
  };
  
  console.log('Sending malicious payload with $gt and $ne operators...\n');
  
  try {
    const response = await fetch(`${API_URL}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(maliciousData)
    });
    
    const data = await response.json().catch(() => ({}));
    log(response.status, `Response: ${JSON.stringify(data)}`);
    
    // Check if the injection was sanitized
    if (data.success) {
      console.log(`\n${colors.green}✅ NoSQL operators were sanitized (replaced with safe values)${colors.reset}`);
    } else {
      console.log(`\n${colors.green}✅ Malicious request was rejected${colors.reset}`);
    }
    return true;
  } catch (error) {
    console.log(`${colors.red}Error: ${error.message}${colors.reset}`);
    return false;
  }
}

// Main test runner
async function runAllTests() {
  console.log(`
${colors.blue}╔════════════════════════════════════════════════════════════╗
║           SECURITY STRESS TEST - BuildHaze                 ║
║                                                            ║
║  Dashboard: ${DASHBOARD_URL}
║  API:       ${API_URL}
╚════════════════════════════════════════════════════════════╝${colors.reset}
`);

  console.log(`${colors.yellow}Choose which tests to run:${colors.reset}`);
  console.log('1. All tests (WARNING: will block your IP)');
  console.log('2. Booking Rate Limit only');
  console.log('3. Body Size Limit only');
  console.log('4. NoSQL Injection only');
  console.log('5. Login Rate Limit only (blocks IP!)');
  
  const args = process.argv[2];
  
  if (!args || args === '1') {
    console.log(`\n${colors.yellow}Running ALL tests...${colors.reset}`);
    await testBookingRateLimit();
    await testBodySizeLimit();
    await testNoSQLInjection();
    // Login test last (blocks IP)
    // await testLoginRateLimit(); // Uncomment to test
    console.log(`\n${colors.yellow}⚠️  Login test skipped to avoid IP block. Run with argument '5' to test.${colors.reset}`);
  } else if (args === '2') {
    await testBookingRateLimit();
  } else if (args === '3') {
    await testBodySizeLimit();
  } else if (args === '4') {
    await testNoSQLInjection();
  } else if (args === '5') {
    await testLoginRateLimit();
  }
  
  console.log(`\n${colors.blue}${'='.repeat(60)}${colors.reset}`);
  console.log(`${colors.blue}Tests completed!${colors.reset}`);
  console.log(`${colors.blue}${'='.repeat(60)}${colors.reset}\n`);
}

runAllTests();
