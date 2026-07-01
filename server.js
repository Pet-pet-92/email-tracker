require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const Papa = require('papaparse');
const app = express();

// JSON parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuring file upload
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ============================================
// POSTGRESQL DATABASE CONNECTION
// ============================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error connecting to PostgreSQL:', err.stack);
    process.exit(1);
  } else {
    console.log('✅ Connected to PostgreSQL!');
    release();
  }
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('✅ Executed query', { text, duration, rows: res.rowCount });
  return res;
}

// ============================================
// CREATE TABLES
// ============================================

async function createTables() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS recipients (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        link TEXT,
        sent_at TIMESTAMP
      )
    `);
    console.log('✅ Recipients table ready');

    await query(`
      CREATE TABLE IF NOT EXISTS clicks (
        id SERIAL PRIMARY KEY,
        recipient_id TEXT REFERENCES recipients(id),
        email TEXT,
        timestamp TIMESTAMP,
        user_agent TEXT,
        ip TEXT
      )
    `);
    console.log('✅ Clicks table ready');

    await query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        smtp_host TEXT,
        smtp_port INTEGER,
        smtp_secure INTEGER,
        sender_email TEXT,
        sender_password TEXT,
        updated_at TIMESTAMP
      )
    `);
    console.log('✅ Settings table ready');

    const settingsCheck = await query(`SELECT COUNT(*) FROM settings`);
    if (parseInt(settingsCheck.rows[0].count) === 0) {
      await query(`
        INSERT INTO settings (smtp_host, smtp_port, smtp_secure, sender_email, sender_password, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, ['smtp.gmail.com', 587, 0, '', '']);
      console.log('✅ Default settings inserted');
    }

    console.log('✅ Database is ready!');
  } catch (err) {
    console.error('❌ Error creating tables:', err);
  }
}

createTables();

// ============================================
// GENERATE UNIQUE LINKS
// ============================================

function generateLinks(recipients) {
  const results = [];
  recipients.forEach(person => {
    const uniqueId = crypto.randomBytes(16).toString('hex');
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const link = `${baseUrl}/click/${uniqueId}`;
    
    let name = person.name;
    if (!name) {
      name = person.email.split('@')[0];
      name = name.replace(/[0-9]/g, '');
      name = name.replace(/[._-]/g, ' ');
      name = name.trim();
      name = name.split(' ').map(word => 
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      ).join(' ');
      if (!name) name = 'N/A';
    }
    
    results.push({
      id: uniqueId,
      email: person.email,
      name: name,
      link: link
    });
  });
  return results;
}

// ============================================
// SEND EMAILS
// ============================================

async function sendEmails(recipients, customSubject, customTemplate) {
  const settingsResult = await query(`SELECT * FROM settings ORDER BY id DESC LIMIT 1`);
  const settings = settingsResult.rows[0];
  
  if (!settings || !settings.sender_email || !settings.sender_password) {
    throw new Error('Email settings not configured. Please set up SMTP settings in the dashboard.');
  }
  
  const transporter = nodemailer.createTransport({
    host: settings.smtp_host,
    port: settings.smtp_port,
    secure: settings.smtp_secure == 1,
    auth: {
      user: settings.sender_email,
      pass: settings.sender_password
    }
  });

  const sentEmails = [];
  const subject = customSubject || 'Reminder to attend meeting';
  let template = customTemplate || `
<h2>Hello {name}!</h2>
<p>Click the link below to get the meetings link:</p>
<p><a href="{link}" style="background:blue;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Click Here</a></p>
<p>Or copy this link: {link}</p>
<p style="font-size:12px;color:gray;">This link is unique to you.</p>
  `;

  const sendPromises = recipients.map(async (person) => {
    const existingResult = await query(
      `SELECT id, link, name FROM recipients WHERE email = $1`,
      [person.email]
    );
    const existingRecipient = existingResult.rows[0];
    
    if (!existingRecipient) {
      console.log(`❌ Recipient not found: ${person.email}`);
      sentEmails.push({ email: person.email, status: 'failed', error: 'Recipient not found' });
      return;
    }
    
    const link = existingRecipient.link;
    const name = existingRecipient.name;
    
    let htmlContent = template
      .replace(/{name}/g, name)
      .replace(/{link}/g, link);
    
    const mailOptions = {
      from: settings.sender_email,
      to: person.email,
      subject: subject,
      html: htmlContent
    };

    try {
      await transporter.sendMail(mailOptions);
      await query(`UPDATE recipients SET sent_at = NOW() WHERE email = $1`, [person.email]);
      sentEmails.push({ email: person.email, status: 'sent' });
      console.log(`✅ Email sent to ${person.email}`);
    } catch (error) {
      console.error(`❌ Failed to send to ${person.email}:`, error.message);
      sentEmails.push({ email: person.email, status: 'failed', error: error.message });
    }
  });

  await Promise.all(sendPromises);
  return sentEmails;
}

// ============================================
// ROUTES
// ============================================

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// TRACKING
app.get('/click/:id', async (req, res) => {
  const { id } = req.params;
  console.log('🔍 Looking for ID:', id);
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const ip = req.ip || req.connection.remoteAddress || 'Unknown';

  try {
    const result = await query(`SELECT email, name FROM recipients WHERE id = $1`, [id]);
    const row = result.rows[0];

    if (!row) {
      console.log('❌ ID not found in database!');
      return res.status(404).send('Invalid or expired link');
    }

    await query(
      `INSERT INTO clicks (recipient_id, email, timestamp, user_agent, ip)
       VALUES ($1, $2, NOW(), $3, $4)`,
      [id, row.email, userAgent, ip]
    );

    console.log(`✅ CLICK: ${row.email} clicked their link!`);
    res.redirect(`/clicked-link-page?email=${encodeURIComponent(row.email)}&name=${encodeURIComponent(row.name)}`);
  } catch (error) {
    console.error('❌ Error in tracking:', error);
    res.status(500).send('Server error');
  }
});

// API ENDPOINTS
app.get('/api/recipients', async (req, res) => {
  try {
    const result = await query(`SELECT email, name, sent_at FROM recipients ORDER BY sent_at DESC`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/recipients', async (req, res) => {
  const { email, name } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  
  try {
    const existing = await query(`SELECT * FROM recipients WHERE email = $1`, [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    
    const uniqueId = crypto.randomBytes(16).toString('hex');
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const link = `${baseUrl}/click/${uniqueId}`;

    let finalName = name;
    if (!finalName) {
      finalName = email.split('@')[0];
      finalName = finalName.replace(/[0-9]/g, '');
      finalName = finalName.replace(/[._-]/g, ' ');
      finalName = finalName.trim();
      finalName = finalName.split(' ').map(word => 
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      ).join(' ');
      if (!finalName) finalName = 'N/A';
    }
    
    await query(
      `INSERT INTO recipients (id, email, name, link, sent_at)
       VALUES ($1, $2, $3, $4, NULL)`,
      [uniqueId, email, finalName, link]
    );
    
    res.json({ success: true, message: 'Recipient added successfully!', email, name: finalName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/recipients/import', upload.single('csvFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  try {
    const csvString = req.file.buffer.toString('utf8');
    const result = Papa.parse(csvString, {
      header: true,
      skipEmptyLines: true,
      trimHeaders: true,
      delimiter: ','
    });
    
    if (result.errors.length > 0) {
      const hasRealError = result.errors.some(e => e.code !== 'UndetectableDelimiter');
      if (hasRealError) {
        return res.status(400).json({ error: 'Error parsing CSV: ' + result.errors[0].message });
      }
    }
    
    const results = [];
    result.data.forEach((row) => {
      const emailKey = Object.keys(row).find(key => key.toLowerCase().trim() === 'email');
      const nameKey = Object.keys(row).find(key => key.toLowerCase().trim() === 'name' || key.toLowerCase().trim() === 'firstname');
      
      if (emailKey) {
        const email = row[emailKey];
        const name = nameKey ? row[nameKey] : '';
        if (email && email.trim()) {
          results.push({ email: email.trim(), name: name.trim() });
        }
      }
    });
    
    if (results.length === 0) {
      return res.status(400).json({ error: 'No valid emails found in CSV. Make sure there is an "email" column.' });
    }
    
    let saved = 0;
    let errors = 0;
    
    for (const person of results) {
      try {
        const uniqueId = crypto.randomBytes(16).toString('hex');
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const link = `${baseUrl}/click/${uniqueId}`;

        let name = person.name;
        if (!name) {
          name = person.email.split('@')[0];
          name = name.replace(/[0-9]/g, '');
          name = name.replace(/[._-]/g, ' ');
          name = name.trim();
          name = name.split(' ').map(word => 
            word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
          ).join(' ');
          if (!name) name = 'N/A';
        }
        
        await query(
          `INSERT INTO recipients (id, email, name, link, sent_at)
           VALUES ($1, $2, $3, $4, NULL)
           ON CONFLICT (email) DO NOTHING`,
          [uniqueId, person.email, name, link]
        );
        saved++;
      } catch (error) {
        errors++;
      }
    }
    
    res.json({ 
      success: true, 
      message: `Imported ${saved} recipients, ${errors} skipped (duplicates or errors)` 
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Error processing CSV: ' + error.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM settings ORDER BY id DESC LIMIT 1`);
    res.json(result.rows[0] || {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/settings', async (req, res) => {
  const { smtp_host, smtp_port, smtp_secure, sender_email, sender_password } = req.body;
  
  if (!smtp_host || !smtp_port || !sender_email || !sender_password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  
  try {
    await query(`
      UPDATE settings 
      SET smtp_host = $1, 
          smtp_port = $2, 
          smtp_secure = $3, 
          sender_email = $4, 
          sender_password = $5,
          updated_at = NOW()
      WHERE id = (SELECT id FROM settings ORDER BY id DESC LIMIT 1)
    `, [smtp_host, smtp_port, smtp_secure, sender_email, sender_password]);
    
    res.json({ success: true, message: 'Settings updated successfully!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/settings/test', async (req, res) => {
  const { smtp_host, smtp_port, smtp_secure, sender_email, sender_password } = req.body;
  
  try {
    const transporter = nodemailer.createTransport({
      host: smtp_host,
      port: parseInt(smtp_port),
      secure: smtp_secure == 1,
      auth: {
        user: sender_email,
        pass: sender_password
      }
    });
    
    await transporter.verify();
    res.json({ success: true, message: 'Connection successful! SMTP settings are correct.' });
  } catch (error) {
    res.status(400).json({ error: 'Connection failed: ' + error.message });
  }
});

app.post('/api/send-emails', async (req, res) => {
  const { subject, template } = req.body;
  
  try {
    const recipientsResult = await query(`SELECT email, name FROM recipients`);
    const recipients = recipientsResult.rows;
    
    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No recipients to send to. Please add recipients first.' });
    }
    
    const linksResult = await query(`SELECT link FROM recipients WHERE link IS NOT NULL LIMIT 1`);
    let hasLinks = linksResult.rows.length > 0;
    
    if (!hasLinks) {
      const trackingData = generateLinks(recipients);
      for (const person of trackingData) {
        await query(`UPDATE recipients SET link = $1 WHERE email = $2`, [person.link, person.email]);
      }
      console.log('✅ Links generated for all recipients');
    }
    
    const settingsResult = await query(`SELECT * FROM settings ORDER BY id DESC LIMIT 1`);
    const settings = settingsResult.rows[0];
    
    if (!settings || !settings.sender_email || !settings.sender_password) {
      return res.status(400).json({ error: 'SMTP settings not configured. Please set up email settings first.' });
    }
    
    const results = await sendEmails(recipients, subject, template);
    
    const sent = results.filter(r => r.status === 'sent').length;
    const failed = results.filter(r => r.status === 'failed').length;
    
    res.json({
      success: true,
      message: `Emails sent successfully! ${sent} sent, ${failed} failed.`,
      results: results
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send emails: ' + error.message });
  }
});

app.delete('/api/recipients/:email', async (req, res) => {
  const { email } = req.params;
  try {
    await query(`DELETE FROM clicks WHERE email = $1`, [email]);
    await query(`DELETE FROM recipients WHERE email = $1`, [email]);
    res.json({ success: true, message: 'Recipient deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/recipients/all', async (req, res) => {
  try {
    await query(`DELETE FROM clicks`);
    await query(`DELETE FROM recipients`);
    res.json({ success: true, message: 'All recipients deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/recipients/sent', async (req, res) => {
  try {
    const sentResult = await query(`SELECT email FROM recipients WHERE sent_at IS NOT NULL`);
    const emails = sentResult.rows.map(r => r.email);
    if (emails.length === 0) {
      return res.json({ success: true, message: 'No sent recipients to delete' });
    }
    await query(`DELETE FROM clicks WHERE email = ANY($1)`, [emails]);
    await query(`DELETE FROM recipients WHERE sent_at IS NOT NULL`);
    res.json({ success: true, message: 'Sent recipients deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/debug/recipients', async (req, res) => {
  try {
    const result = await query(`SELECT id, email, link FROM recipients`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/results', async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        r.email,
        r.name,
        r.sent_at,
        COUNT(c.id) as click_count,
        MAX(c.timestamp) as last_click
      FROM recipients r
      LEFT JOIN clicks c ON r.id = c.recipient_id
      GROUP BY r.id, r.email, r.name, r.sent_at
      ORDER BY r.sent_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DASHBOARD
// ============================================
app.get('/dashboard', async (req, res) => {
  const statusFilter = req.query.status || 'all';
  const dateFilter = req.query.date || 'all';
  
  let whereClause = '';
  let dateCondition = '';
  
  if (statusFilter === 'clicked') {
    whereClause = 'HAVING COUNT(c.id) > 0';
  } else if (statusFilter === 'not-clicked') {
    whereClause = 'HAVING COUNT(c.id) = 0';
  }
  
  if (dateFilter === 'today') {
    dateCondition = "AND DATE(r.sent_at) = CURRENT_DATE";
  } else if (dateFilter === 'yesterday') {
    dateCondition = "AND DATE(r.sent_at) = CURRENT_DATE - INTERVAL '1 day'";
  } else if (dateFilter === 'week') {
    dateCondition = "AND DATE(r.sent_at) >= CURRENT_DATE - INTERVAL '7 days'";
  }
  
  const queryText = `
    SELECT 
      r.email,
      r.name,
      r.sent_at,
      COUNT(c.id) as click_count,
      MAX(c.timestamp) as last_click
    FROM recipients r
    LEFT JOIN clicks c ON r.id = c.recipient_id
    WHERE 1=1 ${dateCondition}
    GROUP BY r.id, r.email, r.name, r.sent_at
    ${whereClause}
    ORDER BY r.sent_at DESC
  `;
  
  try {
    const rowsResult = await query(queryText);
    const rows = rowsResult.rows;
    
    const totalSent = rows.length;
    const totalClicked = rows.filter(r => parseInt(r.click_count) > 0).length;
    const totalNotClicked = rows.filter(r => parseInt(r.click_count) === 0).length;
    
    const statusOptions = `
      <option value="all" ${statusFilter === 'all' ? 'selected' : ''}>All</option>
      <option value="clicked" ${statusFilter === 'clicked' ? 'selected' : ''}>Clicked</option>
      <option value="not-clicked" ${statusFilter === 'not-clicked' ? 'selected' : ''}>Not Clicked</option>
    `;
    
    const dateOptions = `
      <option value="all" ${dateFilter === 'all' ? 'selected' : ''}>All Time</option>
      <option value="today" ${dateFilter === 'today' ? 'selected' : ''}>Today</option>
      <option value="yesterday" ${dateFilter === 'yesterday' ? 'selected' : ''}>Yesterday</option>
      <option value="week" ${dateFilter === 'week' ? 'selected' : ''}>Last 7 Days</option>
    `;
    
    let html = `<!DOCTYPE html>
<html>
<head>
  <title>Email Tracking Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; margin: 0; }
    .container { max-width: 1200px; margin: 0 auto; }
    .card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin-bottom: 20px; }
    h1 { color: #333; margin-top: 0; }
    .tabs { display: flex; gap: 5px; margin-bottom: 20px; border-bottom: 2px solid #e9ecef; flex-wrap: wrap; background: white; padding: 0 20px; border-radius: 10px 10px 0 0; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .tab { padding: 14px 24px; cursor: pointer; border: none; background: none; font-size: 16px; color: #6c757d; border-bottom: 3px solid transparent; transition: all 0.3s; }
    .tab:hover { color: #007bff; }
    .tab.active { color: #007bff; border-bottom-color: #007bff; font-weight: bold; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .filter-bar { display: flex; gap: 15px; flex-wrap: wrap; align-items: center; }
    .filter-bar label { font-weight: bold; color: #555; margin-right: 5px; }
    .filter-bar select { padding: 8px 12px; border: 1px solid #ddd; border-radius: 5px; font-size: 14px; }
    .filter-bar .btn { padding: 8px 20px; background: #007bff; color: white; border: none; border-radius: 5px; cursor: pointer; text-decoration: none; font-size: 14px; }
    .filter-bar .btn:hover { background: #0056b3; }
    .filter-bar .btn-reset { background: #6c757d; }
    .filter-bar .btn-reset:hover { background: #5a6268; }
    .summary { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 20px; }
    .summary-card { background: #f8f9fa; padding: 15px 25px; border-radius: 8px; flex: 1; text-align: center; min-width: 100px; }
    .summary-card .number { font-size: 32px; font-weight: bold; color: #007bff; }
    .summary-card .number.green { color: #28a745; }
    .summary-card .number.red { color: #dc3545; }
    .summary-card .label { color: #666; font-size: 14px; }
    .add-form { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .add-form input { padding: 10px; border: 1px solid #ddd; border-radius: 5px; font-size: 14px; flex: 1; min-width: 200px; }
    .add-form button { padding: 10px 20px; background: #28a745; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 14px; }
    .add-form button:hover { background: #218838; }
    .add-form .message { margin-left: 10px; font-size: 14px; }
    .add-form .message.success { color: #28a745; }
    .add-form .message.error { color: #dc3545; }
    .import-section { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
    .import-section input[type="file"] { padding: 8px; border: 1px solid #ddd; border-radius: 5px; }
    .import-section button { padding: 10px 20px; background: #17a2b8; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 14px; }
    .import-section button:hover { background: #138496; }
    .import-section .import-status { margin-left: 10px; font-size: 14px; }
    .import-section .import-status.success { color: #28a745; }
    .import-section .import-status.error { color: #dc3545; }
    .settings-form input, .settings-form select { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; font-size: 14px; }
    .settings-form label { display: block; font-weight: bold; margin-bottom: 5px; }
    .settings-form .form-group { margin-bottom: 15px; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f8f9fa; font-weight: 600; }
    .status-clicked { color: #28a745; font-weight: bold; }
    .status-not-clicked { color: #dc3545; font-weight: bold; }
    .no-results { text-align: center; padding: 40px; color: #999; }
    .recipient-count { color: #666; font-size: 14px; margin-top: 10px; }
    .btn-group { display: flex; gap: 10px; flex-wrap: wrap; }
    .btn-primary { padding: 10px 30px; background: #007bff; color: white; border: none; border-radius: 5px; cursor: pointer; }
    .btn-primary:hover { background: #0056b3; }
    .btn-success { padding: 10px 30px; background: #28a745; color: white; border: none; border-radius: 5px; cursor: pointer; }
    .btn-success:hover { background: #218838; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Email Campaign Manager</h1>
    <div class="tabs">
      <button class="tab active" onclick="showTab('dashboard-tab')">Dashboard</button>
      <button class="tab" onclick="showTab('manage-tab')">Manage Recipients</button>
      <button class="tab" onclick="showTab('settings-tab')">Settings</button>
    </div>
    <div id="dashboard-tab" class="tab-content active">
      <div class="card">
        <form method="GET" action="/dashboard" class="filter-bar">
          <div><label for="status">Status:</label><select name="status" id="status">${statusOptions}</select></div>
          <div><label for="date">Date:</label><select name="date" id="date">${dateOptions}</select></div>
          <button type="submit" class="btn">Apply Filters</button>
          <a href="/dashboard" class="btn btn-reset">Reset</a>
        </form>
      </div>
      <div class="summary">
        <div class="summary-card"><div class="number">${totalSent}</div><div class="label">Total Sent</div></div>
        <div class="summary-card"><div class="number green">${totalClicked}</div><div class="label">Clicked</div></div>
        <div class="summary-card"><div class="number red">${totalNotClicked}</div><div class="label">Not Clicked</div></div>
      </div>
      <div class="card">
        ${rows.length === 0 ? `
          <div class="no-results"><p>No recipients found</p><p style="font-size:14px;color:#aaa;">Go to the "Manage Recipients" tab to add emails.</p></div>
        ` : `
          <table>
            <tr><th>Status</th><th>Email</th><th>Name</th><th>Sent At</th><th>Clicks</th><th>Last Click</th></tr>
            ${rows.map(row => {
              const statusText = parseInt(row.click_count) > 0 ? 'Clicked' : 'Not Clicked';
              const statusClass = parseInt(row.click_count) > 0 ? 'status-clicked' : 'status-not-clicked';
              const sentAt = row.sent_at ? new Date(row.sent_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }) : 'Not sent yet';
              const lastClick = row.last_click ? new Date(row.last_click).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }) : '-';
              return `
                <tr>
                  <td class="${statusClass}">${statusText}</td>
                  <td><strong>${row.email}</strong></td>
                  <td>${row.name}</td>
                  <td>${sentAt}</td>
                  <td>${row.click_count}</td>
                  <td>${lastClick}</td>
                </tr>
              `;
            }).join('')}
          </table>
        `}
      </div>
    </div>
    <div id="manage-tab" class="tab-content">
      <div class="card">
        <h3>Add Recipient Manually</h3>
        <form id="addForm" class="add-form" onsubmit="addRecipient(event)">
          <input type="email" id="emailInput" placeholder="Enter email address" required>
          <input type="text" id="nameInput" placeholder="Name (optional)">
          <button type="submit">Add Recipient</button>
          <span id="addMessage" class="message"></span>
        </form>
      </div>
      <div class="card">
        <h3>Import from CSV</h3>
        <div class="import-section">
          <form id="importForm" onsubmit="importCSV(event)">
            <input type="file" id="csvFile" accept=".csv" required>
            <button type="submit">Import CSV</button>
            <span id="importStatus" class="import-status"></span>
          </form>
        </div>
        <p style="font-size:12px;color:#888;margin-top:10px;">CSV must have an "email" column. Optional: "name" column. <a href="#" onclick="downloadSampleCSV()">Download sample CSV</a></p>
      </div>
      <div class="card" style="border:2px solid #007bff;background:#f8f9ff;">
        <h3>Send Emails</h3>
        <p style="color:#666;font-size:14px;margin-bottom:15px;">Send emails to all recipients who haven't received an email yet.</p>
        <div style="display:flex;gap:15px;flex-wrap:wrap;align-items:center;">
          <button onclick="sendEmails()" id="sendBtn" style="padding:12px 40px;background:#007bff;color:white;border:none;border-radius:5px;cursor:pointer;font-size:16px;font-weight:bold;">Send Emails</button>
          <span id="sendStatus" style="font-size:14px;"></span>
        </div>
        <div id="sendProgress" style="margin-top:15px;"></div>
        <div style="margin-top:15px;padding-top:15px;border-top:1px solid #e9ecef;">
          <label style="display:block;font-weight:bold;margin-bottom:5px;font-size:14px;">Email Subject:</label>
          <input type="text" id="emailSubject" value="Reminder to attend meeting" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:5px;font-size:14px;">
        </div>
        <div style="margin-top:15px;padding-top:15px;border-top:1px solid #e9ecef;">
          <label style="display:block;font-weight:bold;margin-bottom:5px;font-size:14px;">Email Template:</label>
          <textarea id="emailTemplate" rows="6" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:5px;font-size:14px;font-family:Arial,sans-serif;">
<h2>Hello {name}!</h2>
<p>Click the link below to get the meetings link:</p>
<p><a href="{link}" style="background:blue;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Click Here</a></p>
<p>Or copy this link: {link}</p>
<p style="font-size:12px;color:gray;">This link is unique to you.</p>
          </textarea>
          <p style="font-size:12px;color:#888;margin-top:5px;">Use <strong>{name}</strong> and <strong>{link}</strong> placeholders.</p>
        </div>
      </div>
      <div class="card">
        <h3>Current Recipients</h3>
        <div style="display:flex;gap:15px;flex-wrap:wrap;align-items:center;margin-bottom:15px;padding:10px;background:#f8f9fa;border-radius:8px;">
          <button onclick="selectAllRecipients()" style="padding:6px 15px;background:#6c757d;color:white;border:none;border-radius:4px;cursor:pointer;">Select All</button>
          <button onclick="deselectAllRecipients()" style="padding:6px 15px;background:#6c757d;color:white;border:none;border-radius:4px;cursor:pointer;">Deselect All</button>
          <span style="color:#666;font-size:14px;" id="selectedCount">0 selected</span>
        </div>
        <div style="display:flex;gap:10px;margin-bottom:15px;flex-wrap:wrap;">
          <button onclick="deleteSelectedRecipients()" id="deleteSelectedBtn" style="padding:10px 25px;background:#dc3545;color:white;border:none;border-radius:5px;cursor:pointer;font-weight:bold;">🗑️ Delete Selected</button>
          <button onclick="deleteAllRecipients()" style="padding:10px 25px;background:#dc3545;color:white;border:none;border-radius:5px;cursor:pointer;font-weight:bold;opacity:0.7;">⚠️ Delete All</button>
          <button onclick="deleteAllSent()" style="padding:10px 25px;background:#ff9800;color:white;border:none;border-radius:5px;cursor:pointer;font-weight:bold;">📤 Delete Sent</button>
        </div>
        <div id="recipientList"><p>Loading...</p></div>
      </div>
    </div>
    <div id="settings-tab" class="tab-content">
      <div class="card">
        <h3>SMTP Settings</h3>
        <p style="color:#666;font-size:14px;margin-bottom:15px;">Configure your email server settings.</p>
        <form id="settingsForm" class="settings-form" onsubmit="saveSettings(event)">
          <div class="form-group"><label for="smtpHost">SMTP Host:</label><input type="text" id="smtpHost" placeholder="smtp.gmail.com"></div>
          <div class="form-group"><label for="smtpPort">SMTP Port:</label><input type="number" id="smtpPort" placeholder="587"></div>
          <div class="form-group"><label for="senderEmail">Sender Email:</label><input type="email" id="senderEmail" placeholder="your-email@gmail.com"></div>
          <div class="form-group"><label for="senderPassword">Password / App Password:</label><input type="password" id="senderPassword" placeholder="your-app-password"></div>
          <div class="form-group"><label for="smtpSecure">Use Secure Connection (SSL/TLS):</label>
            <select id="smtpSecure"><option value="0">No (Port 587 - TLS)</option><option value="1">Yes (Port 465 - SSL)</option></select>
          </div>
          <div class="btn-group">
            <button type="submit" class="btn-primary">Save Settings</button>
            <button type="button" class="btn-success" onclick="testSettings()">Test Connection</button>
          </div>
          <div id="settingsMessage" style="margin-top:15px;font-weight:bold;"></div>
        </form>
      </div>
    </div>
  </div>

  <script>
    function showTab(tabId) {
      var contents = document.querySelectorAll('.tab-content');
      for (var i = 0; i < contents.length; i++) {
        contents[i].classList.remove('active');
      }
      var tabs = document.querySelectorAll('.tab');
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.remove('active');
      }
      var selectedContent = document.getElementById(tabId);
      if (selectedContent) {
        selectedContent.classList.add('active');
      }
      var buttons = document.querySelectorAll('.tab');
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].getAttribute('onclick') && buttons[i].getAttribute('onclick').indexOf(tabId) !== -1) {
          buttons[i].classList.add('active');
        }
      }
      if (tabId === 'manage-tab') {
        loadRecipients();
      }
      if (tabId === 'settings-tab') {
        loadSettings();
      }
    }

    async function loadSettings() {
      try {
        var response = await fetch('/api/settings');
        var data = await response.json();
        if (data) {
          document.getElementById('smtpHost').value = data.smtp_host || '';
          document.getElementById('smtpPort').value = data.smtp_port || 587;
          document.getElementById('senderEmail').value = data.sender_email || '';
          document.getElementById('senderPassword').value = data.sender_password || '';
          document.getElementById('smtpSecure').value = data.smtp_secure || 0;
        }
      } catch (error) {
        console.error('Error loading settings:', error);
      }
    }

    async function saveSettings(event) {
      event.preventDefault();
      var messageEl = document.getElementById('settingsMessage');
      var settings = {
        smtp_host: document.getElementById('smtpHost').value,
        smtp_port: parseInt(document.getElementById('smtpPort').value),
        smtp_secure: parseInt(document.getElementById('smtpSecure').value),
        sender_email: document.getElementById('senderEmail').value,
        sender_password: document.getElementById('senderPassword').value
      };
      try {
        var response = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        });
        var data = await response.json();
        if (response.ok) {
          messageEl.textContent = '✅ ' + data.message;
          messageEl.style.color = '#28a745';
        } else {
          messageEl.textContent = '❌ ' + data.error;
          messageEl.style.color = '#dc3545';
        }
      } catch (error) {
        messageEl.textContent = '❌ Error: ' + error.message;
        messageEl.style.color = '#dc3545';
      }
    }

    async function testSettings() {
      var messageEl = document.getElementById('settingsMessage');
      messageEl.textContent = 'Testing connection...';
      messageEl.style.color = '#007bff';
      var settings = {
        smtp_host: document.getElementById('smtpHost').value,
        smtp_port: parseInt(document.getElementById('smtpPort').value),
        smtp_secure: parseInt(document.getElementById('smtpSecure').value),
        sender_email: document.getElementById('senderEmail').value,
        sender_password: document.getElementById('senderPassword').value
      };
      try {
        var response = await fetch('/api/settings/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        });
        var data = await response.json();
        if (response.ok) {
          messageEl.textContent = '✅ ' + data.message;
          messageEl.style.color = '#28a745';
        } else {
          messageEl.textContent = '❌ ' + data.error;
          messageEl.style.color = '#dc3545';
        }
      } catch (error) {
        messageEl.textContent = '❌ Error: ' + error.message;
        messageEl.style.color = '#dc3545';
      }
    }

    async function addRecipient(event) {
      event.preventDefault();
      var email = document.getElementById('emailInput').value;
      var name = document.getElementById('nameInput').value;
      var messageEl = document.getElementById('addMessage');
      try {
        var response = await fetch('/api/recipients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, name: name })
        });
        var data = await response.json();
        if (response.ok) {
          messageEl.textContent = data.message;
          messageEl.className = 'message success';
          document.getElementById('emailInput').value = '';
          document.getElementById('nameInput').value = '';
          loadRecipients();
        } else {
          messageEl.textContent = data.error;
          messageEl.className = 'message error';
        }
      } catch (error) {
        messageEl.textContent = 'Error: ' + error.message;
        messageEl.className = 'message error';
      }
    }

    async function importCSV(event) {
      event.preventDefault();
      var fileInput = document.getElementById('csvFile');
      var statusEl = document.getElementById('importStatus');
      if (!fileInput.files.length) {
        statusEl.textContent = 'Please select a file';
        statusEl.className = 'import-status error';
        return;
      }
      var formData = new FormData();
      formData.append('csvFile', fileInput.files[0]);
      try {
        var response = await fetch('/api/recipients/import', {
          method: 'POST',
          body: formData
        });
        var data = await response.json();
        if (response.ok) {
          statusEl.textContent = data.message;
          statusEl.className = 'import-status success';
          fileInput.value = '';
          loadRecipients();
        } else {
          statusEl.textContent = data.error;
          statusEl.className = 'import-status error';
        }
      } catch (error) {
        statusEl.textContent = 'Error: ' + error.message;
        statusEl.className = 'import-status error';
      }
    }

    async function loadRecipients() {
      var container = document.getElementById('recipientList');
      try {
        var response = await fetch('/api/recipients');
        var data = await response.json();
        if (data.length === 0) {
          container.innerHTML = '<p style="color:#999;">No recipients added yet.</p>';
          var countEl = document.getElementById('selectedCount');
          if (countEl) countEl.textContent = '0 selected';
          return;
        }
        var html = '';
        html += '<div class="recipient-count">Total: ' + data.length + ' recipients</div>';
        html += '<div style="overflow-x:auto;">';
        html += '<table style="width:100%;border-collapse:collapse;margin-top:10px;">';
        html += '<thead>';
        html += '<tr style="background:#f8f9fa;">';
        html += '<th style="padding:10px;text-align:left;border-bottom:1px solid #ddd;width:40px;">';
        html += '<input type="checkbox" id="selectAllCheckbox" onchange="toggleAllCheckboxes()">';
        html += '</th>';
        html += '<th style="padding:10px;text-align:left;border-bottom:1px solid #ddd;">Email</th>';
        html += '<th style="padding:10px;text-align:left;border-bottom:1px solid #ddd;">Name</th>';
        html += '<th style="padding:10px;text-align:left;border-bottom:1px solid #ddd;">Status</th>';
        html += '</tr>';
        html += '</thead>';
        html += '<tbody>';
        for (var i = 0; i < data.length; i++) {
          var row = data[i];
          var status = row.sent_at ? 'Sent' : 'Pending';
          var statusColor = row.sent_at ? '#28a745' : '#ff9800';
          html += '<tr style="border-bottom:1px solid #eee;">';
          html += '<td style="padding:10px;">';
          html += '<input type="checkbox" class="recipient-checkbox" value="' + row.email + '" onchange="updateSelectedCount()">';
          html += '</td>';
          html += '<td style="padding:10px;"><strong>' + row.email + '</strong></td>';
          html += '<td style="padding:10px;">' + row.name + '</td>';
          html += '<td style="padding:10px;color:' + statusColor + ';font-weight:bold;">' + status + '</td>';
          html += '</tr>';
        }
        html += '</tbody>';
        html += '</table>';
        html += '</div>';
        container.innerHTML = html;
        updateSelectedCount();
      } catch (error) {
        container.innerHTML = '<p style="color:red;">Error loading recipients</p>';
      }
    }

    function downloadSampleCSV() {
      var content = 'email,name\\nalice@example.com,Alice\\nbob@example.com,Bob\\ncharlie@example.com,Charlie';
      var blob = new Blob([content], { type: 'text/csv' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'sample_recipients.csv';
      a.click();
      URL.revokeObjectURL(url);
    }

    async function sendEmails() {
      var sendBtn = document.getElementById('sendBtn');
      var statusEl = document.getElementById('sendStatus');
      var progressEl = document.getElementById('sendProgress');
      var subject = document.getElementById('emailSubject').value;
      var template = document.getElementById('emailTemplate').value;
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending...';
      statusEl.textContent = '';
      statusEl.style.color = '#007bff';
      progressEl.innerHTML = '';
      try {
        var response = await fetch('/api/send-emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subject: subject, template: template })
        });
        var data = await response.json();
        if (response.ok) {
          statusEl.textContent = '✅ ' + data.message;
          statusEl.style.color = '#28a745';
          if (data.results) {
            var html = '<div style="margin-top:10px;background:#f8f9fa;padding:10px;border-radius:5px;max-height:200px;overflow-y:auto;">';
            html += '<table style="width:100%;font-size:13px;">';
            html += '<tr><th>Email</th><th>Status</th></tr>';
            for (var i = 0; i < data.results.length; i++) {
              var result = data.results[i];
              var color = result.status === 'sent' ? '#28a745' : '#dc3545';
              html += '<tr><td>' + result.email + '</td><td style="color:' + color + ';font-weight:bold;">' + result.status + '</td></tr>';
            }
            html += '</table></div>';
            progressEl.innerHTML = html;
          }
          loadRecipients();
          setTimeout(function() { window.location.reload(); }, 3000);
        } else {
          statusEl.textContent = '❌ ' + data.error;
          statusEl.style.color = '#dc3545';
        }
      } catch (error) {
        statusEl.textContent = '❌ Error: ' + error.message;
        statusEl.style.color = '#dc3545';
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Emails';
      }
    }

    async function deleteAllRecipients() {
      if (!confirm('Delete ALL recipients? This cannot be undone.')) return;
      try {
        var response = await fetch('/api/recipients/all', { method: 'DELETE' });
        var data = await response.json();
        if (response.ok) { loadRecipients(); }
        else { alert('Error: ' + data.error); }
      } catch (error) { alert('Error: ' + error.message); }
    }

    async function deleteAllSent() {
      if (!confirm('Delete all recipients that have been sent?')) return;
      try {
        var response = await fetch('/api/recipients/sent', { method: 'DELETE' });
        var data = await response.json();
        if (response.ok) { loadRecipients(); }
        else { alert('Error: ' + data.error); }
      } catch (error) { alert('Error: ' + error.message); }
    }

    function updateSelectedCount() {
      var checkboxes = document.querySelectorAll('.recipient-checkbox:checked');
      var count = checkboxes.length;
      var countEl = document.getElementById('selectedCount');
      if (countEl) countEl.textContent = count + ' selected';
      var deleteBtn = document.getElementById('deleteSelectedBtn');
      if (deleteBtn) {
        deleteBtn.disabled = count === 0;
        deleteBtn.style.opacity = count === 0 ? '0.5' : '1';
      }
    }

    function toggleAllCheckboxes() {
      var masterCheckbox = document.getElementById('selectAllCheckbox');
      var checkboxes = document.querySelectorAll('.recipient-checkbox');
      for (var i = 0; i < checkboxes.length; i++) {
        checkboxes[i].checked = masterCheckbox.checked;
      }
      updateSelectedCount();
    }

    function selectAllRecipients() {
      var checkboxes = document.querySelectorAll('.recipient-checkbox');
      for (var i = 0; i < checkboxes.length; i++) {
        checkboxes[i].checked = true;
      }
      var masterCheckbox = document.getElementById('selectAllCheckbox');
      if (masterCheckbox) masterCheckbox.checked = true;
      updateSelectedCount();
    }

    function deselectAllRecipients() {
      var checkboxes = document.querySelectorAll('.recipient-checkbox');
      for (var i = 0; i < checkboxes.length; i++) {
        checkboxes[i].checked = false;
      }
      var masterCheckbox = document.getElementById('selectAllCheckbox');
      if (masterCheckbox) masterCheckbox.checked = false;
      updateSelectedCount();
    }

    function getSelectedEmails() {
      var checkboxes = document.querySelectorAll('.recipient-checkbox:checked');
      var emails = [];
      for (var i = 0; i < checkboxes.length; i++) {
        emails.push(checkboxes[i].value);
      }
      return emails;
    }

    async function deleteSelectedRecipients() {
      var selected = getSelectedEmails();
      if (selected.length === 0) {
        alert('Please select at least one recipient to delete.');
        return;
      }
      if (!confirm('Delete ' + selected.length + ' selected recipient(s)? This cannot be undone.')) return;
      var deleteBtn = document.getElementById('deleteSelectedBtn');
      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting...';
      try {
        var deleted = 0;
        var failed = 0;
        var errorMessages = [];
        for (var i = 0; i < selected.length; i++) {
          var email = selected[i];
          try {
            var response = await fetch('/api/recipients/' + encodeURIComponent(email), { method: 'DELETE' });
            var data = await response.json();
            if (response.ok) { deleted++; } 
            else { 
              failed++; 
              errorMessages.push(email + ': ' + (data.error || 'Unknown error'));
            }
          } catch (error) {
            failed++;
            errorMessages.push(email + ': ' + error.message);
          }
        }
        if (failed > 0) {
          alert('⚠️ Deleted ' + deleted + ' recipient(s). ' + failed + ' failed.\n\nErrors:\n' + errorMessages.join('\n'));
        } else {
          alert('✅ Deleted ' + deleted + ' recipient(s) successfully.');
        }
        loadRecipients();
      } catch (error) {
        alert('❌ Error: ' + error.message);
      } finally {
        deleteBtn.disabled = false;
        deleteBtn.textContent = '🗑️ Delete Selected';
      }
    }

    document.addEventListener('DOMContentLoaded', function() {
      loadRecipients();
      loadSettings();
    });
  </script>
</body>
</html>`;

    res.send(html);
  } catch (error) {
    res.send(`<h2>Error: ${error.message}</h2>`);
  }
});

// ============================================
// CLICKED LINK PAGE
// ============================================
app.get('/clicked-link-page', (req, res) => {
  const email = req.query.email || 'Guest';
  const name = req.query.name || 'there';
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Thank You!</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          margin: 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .container {
          background: white;
          padding: 50px 60px;
          border-radius: 20px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          text-align: center;
          max-width: 500px;
          animation: fadeIn 0.8s ease-in;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-30px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .checkmark { font-size: 80px; color: #28a745; margin-bottom: 10px; }
        h1 { color: #333; margin-bottom: 10px; }
        p { color: #666; line-height: 1.6; font-size: 16px; }
        .btn { display: inline-block; margin-top: 20px; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 50px; font-weight: bold; }
        .btn:hover { background: #5a67d8; }
        .footer { margin-top: 20px; font-size: 12px; color: #aaa; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="checkmark">✅</div>
        <h1>THIS WAS A SECURITY TEST ${name}!</h1>
        <p>You have failed The Security test.</p>
        <p>Please be more cautious.</p>
        <a href="#" class="btn">View Meeting Details</a>
        <p class="footer">You're receiving this because you confirmed your attendance.</p>
      </div>
    </body>
    </html>
  `);
});

// ============================================
// START THE SERVER
// ============================================
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`📋 JSON data: http://localhost:${PORT}/results`);
    console.log('\n📧 To send emails, use the "Send Emails" button in the dashboard.');
  });
}

module.exports = app;