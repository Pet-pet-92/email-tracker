require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const multer = require('multer');
const Papa = require('papaparse');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Serverless-optimized connection pool config
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1, // Restricts per-instance connection exhaustion on Vercel
});

pool.connect((err) => {
  if (err) {
    console.error('Error connecting to PostgreSQL:', err.stack);
  } else {
    console.log('Connected to PostgreSQL!');
  }
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

// Security sanitization to protect against Cross-Site Scripting (XSS)
function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

function generateLinks(recipients) {
  const results = [];
  recipients.forEach(person => {
    const uniqueId = crypto.randomBytes(16).toString('hex');
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const link = baseUrl + '/click/' + uniqueId;
    
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
    
    results.push({ id: uniqueId, email: person.email, name: name, link: link });
  });
  return results;
}

// Sequential, rate-limited email distribution function to prevent SMTP blocking
async function sendEmails(recipients, customSubject, customTemplate) {
  const settingsResult = await query('SELECT * FROM settings ORDER BY id DESC LIMIT 1');
  const settings = settingsResult.rows[0];
  
  if (!settings || !settings.sender_email || !settings.sender_password) {
    throw new Error('Email settings not configured.');
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
<p>Click the link below:</p>
<p><a href="{link}">Click Here</a></p>
<p>Or copy: {link}</p>
  `;

  for (const person of recipients) {
    const existingResult = await query('SELECT id, link, name FROM recipients WHERE email = $1', [person.email]);
    const existingRecipient = existingResult.rows[0];
    
    if (!existingRecipient) {
      sentEmails.push({ email: person.email, status: 'failed', error: 'Recipient not found' });
      continue;
    }
    
    let htmlContent = template.replace(/{name}/g, existingRecipient.name).replace(/{link}/g, existingRecipient.link);
    
    const mailOptions = {
      from: settings.sender_email,
      to: person.email,
      subject: subject,
      html: htmlContent
    };

    try {
      await transporter.sendMail(mailOptions);
      await query('UPDATE recipients SET sent_at = NOW() WHERE email = $1', [person.email]);
      sentEmails.push({ email: person.email, status: 'sent' });
      console.log('Email sent to', person.email);
      
      // 200ms cooldown delay to pace SMTP connections safely on serverless runs
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      console.error('Failed to send to', person.email, error.message);
      sentEmails.push({ email: person.email, status: 'failed', error: error.message });
    }
  }

  return sentEmails;
}

// ============================================
// ROUTES
// ============================================

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

app.get('/click/:id', async (req, res) => {
  const id = req.params.id;
  console.log('Looking for ID:', id);
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const ip = req.ip || req.connection.remoteAddress || 'Unknown';

  try {
    const result = await query('SELECT email, name FROM recipients WHERE id = $1', [id]);
    const row = result.rows[0];

    if (!row) {
      return res.status(404).send('Invalid or expired link');
    }

    await query(
      'INSERT INTO clicks (recipient_id, email, timestamp, user_agent, ip) VALUES ($1, $2, NOW(), $3, $4)',
      [id, row.email, userAgent, ip]
    );

    console.log('CLICK:', row.email);
    res.redirect('/clicked-link-page?email=' + encodeURIComponent(row.email) + '&name=' + encodeURIComponent(row.name));
  } catch (error) {
    console.error('Error in tracking:', error);
    res.status(500).send('Server error');
  }
});

app.get('/api/recipients', async (req, res) => {
  try {
    const result = await query('SELECT email, name, sent_at FROM recipients ORDER BY sent_at DESC');
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
    const existing = await query('SELECT * FROM recipients WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    
    const uniqueId = crypto.randomBytes(16).toString('hex');
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const link = baseUrl + '/click/' + uniqueId;

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
      'INSERT INTO recipients (id, email, name, link, sent_at) VALUES ($1, $2, $3, $4, NULL)',
      [uniqueId, email, finalName, link]
    );
    
    res.json({ success: true, message: 'Recipient added successfully!', email: email, name: finalName });
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
      return res.status(400).json({ error: 'No valid emails found in CSV.' });
    }
    
    let saved = 0;
    let errors = 0;
    
    for (const person of results) {
      try {
        const uniqueId = crypto.randomBytes(16).toString('hex');
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const link = baseUrl + '/click/' + uniqueId;

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
          'INSERT INTO recipients (id, email, name, link, sent_at) VALUES ($1, $2, $3, $4, NULL) ON CONFLICT (email) DO NOTHING',
          [uniqueId, person.email, name, link]
        );
        saved++;
      } catch (error) {
        errors++;
      }
    }
    
    res.json({ 
      success: true, 
      message: 'Imported ' + saved + ' recipients, ' + errors + ' skipped'
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Error processing CSV: ' + error.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const result = await query('SELECT * FROM settings ORDER BY id DESC LIMIT 1');
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
      SET smtp_host = $1, smtp_port = $2, smtp_secure = $3, sender_email = $4, sender_password = $5, updated_at = NOW()
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
    res.json({ success: true, message: 'Connection successful!' });
  } catch (error) {
    res.status(400).json({ error: 'Connection failed: ' + error.message });
  }
});

app.post('/api/send-emails', async (req, res) => {
  const { subject, template } = req.body;
  
  try {
    const recipientsResult = await query('SELECT email, name FROM recipients');
    const recipients = recipientsResult.rows;
    
    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No recipients to send to.' });
    }
    
    const linksResult = await query('SELECT link FROM recipients WHERE link IS NOT NULL LIMIT 1');
    let hasLinks = linksResult.rows.length > 0;
    
    if (!hasLinks) {
      const trackingData = generateLinks(recipients);
      for (const person of trackingData) {
        await query('UPDATE recipients SET link = $1 WHERE email = $2', [person.link, person.email]);
      }
    }
    
    const settingsResult = await query('SELECT * FROM settings ORDER BY id DESC LIMIT 1');
    const settings = settingsResult.rows[0];
    
    if (!settings || !settings.sender_email || !settings.sender_password) {
      return res.status(400).json({ error: 'SMTP settings not configured.' });
    }
    
    const results = await sendEmails(recipients, subject, template);
    
    const sent = results.filter(r => r.status === 'sent').length;
    const failed = results.filter(r => r.status === 'failed').length;
    
    res.json({
      success: true,
      message: 'Emails sent successfully! ' + sent + ' sent, ' + failed + ' failed.',
      results: results
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send emails: ' + error.message });
  }
});

// ============================================
// DELETION API ENDPOINTS (CORRECTED & BULK DEPLOYED)
// ============================================

app.post('/api/recipients/bulk-delete', async (req, res) => {
  const { emails } = req.body;
  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'No recipient rows selected.' });
  }
  try {
    await query('DELETE FROM clicks WHERE email = ANY($1)', [emails]);
    const deleteResult = await query('DELETE FROM recipients WHERE email = ANY($1)', [emails]);
    res.json({ success: true, message: `Successfully deleted ${deleteResult.rowCount} recipient(s).` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/recipients/all', async (req, res) => {
  try {
    await query('DELETE FROM clicks');
    await query('DELETE FROM recipients');
    res.json({ success: true, message: 'All recipients cleared successfully!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/recipients/sent', async (req, res) => {
  try {
    const sentResult = await query('SELECT email FROM recipients WHERE sent_at IS NOT NULL');
    const emails = sentResult.rows.map(r => r.email);
    if (emails.length === 0) {
      return res.json({ success: true, message: 'No sent records to clear.' });
    }
    await query('DELETE FROM clicks WHERE email = ANY($1)', [emails]);
    await query('DELETE FROM recipients WHERE sent_at IS NOT NULL');
    res.json({ success: true, message: 'Sent records wiped successfully!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/debug/recipients', async (req, res) => {
  try {
    const result = await query('SELECT id, email, link FROM recipients');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DASHBOARD VIEW LAYER
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
    let totalClicked = 0;
    let totalNotClicked = 0;
    for (let i = 0; i < rows.length; i++) {
      if (parseInt(rows[i].click_count) > 0) totalClicked++;
      else totalNotClicked++;
    }
    
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
    
    let tableRows = '';
    if (rows.length === 0) {
      tableRows = '<div class="no-results"><p>No recipients found.</p></div>';
    } else {
      tableRows = `
        <table>
          <tr><th>Status</th><th>Email</th><th>Name</th><th>Sent At</th><th>Clicks</th><th>Last Click</th></tr>
      `;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const statusText = parseInt(row.click_count) > 0 ? 'Clicked' : 'Not Clicked';
        const statusClass = parseInt(row.click_count) > 0 ? 'status-clicked' : 'status-not-clicked';
        
        // Universally safe locale date formatting strings for Vercel Serverless
        const sentAt = row.sent_at ? new Date(row.sent_at).toLocaleString() : 'Not sent yet';
        const lastClick = row.last_click ? new Date(row.last_click).toLocaleString() : '-';
        
        tableRows += `
          <tr>
            <td class="${statusClass}">${statusText}</td>
            <td><strong>${escapeHTML(row.email)}</strong></td>
            <td>${escapeHTML(row.name)}</td>
            <td>${sentAt}</td>
            <td>${row.click_count}</td>
            <td>${lastClick}</td>
          </tr>
        `;
      }
      tableRows += '</table>';
    }
    
    const html = `
<!DOCTYPE html>
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
    .tab-content { display: none; padding: 20px 0; }
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
    .send-btn { padding: 12px 40px; background: #007bff; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; font-weight: bold; }
    .send-btn:hover { background: #0056b3; }
    .send-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .delete-btn { background: #dc3545; color: white; border: none; padding: 10px 25px; border-radius: 5px; cursor: pointer; font-size: 14px; font-weight: bold; }
    .delete-btn:hover { background: #c82333; }
    .delete-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .message { margin-left: 10px; font-size: 14px; }
    .message.success { color: #28a745; }
    .message.error { color: #dc3545; }
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
          <div>
            <label for="status">Status:</label>
            <select name="status" id="status">${statusOptions}</select>
          </div>
          <div>
            <label for="date">Date:</label>
            <select name="date" id="date">${dateOptions}</select>
          </div>
          <button type="submit" class="btn">Apply Filters</button>
          <a href="/dashboard" class="btn btn-reset">Reset</a>
        </form>
      </div>
      <div class="summary">
        <div class="summary-card"><div class="number">${totalSent}</div><div class="label">Total Sent</div></div>
        <div class="summary-card"><div class="number green">${totalClicked}</div><div class="label">Clicked</div></div>
        <div class="summary-card"><div class="number red">${totalNotClicked}</div><div class="label">Not Clicked</div></div>
      </div>
      <div class="card">${tableRows}</div>
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
        <p style="font-size:12px;color:#888;margin-top:10px;">CSV must have an "email" column. <a href="#" onclick="downloadSampleCSV()">Download sample CSV</a></p>
      </div>
      <div class="card" style="border:2px solid #007bff;background:#f8f9ff;">
        <h3>Send Emails</h3>
        <p style="color:#666;font-size:14px;margin-bottom:15px;">Send emails to all recipients.</p>
        <div style="display:flex;gap:15px;flex-wrap:wrap;align-items:center;">
          <button onclick="sendEmails()" id="sendBtn" class="send-btn">Send Emails</button>
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
<p>Click the link below:</p>
<p><a href="{link}">Click Here</a></p>
<p>Or copy: {link}</p>
          </textarea>
          <p style="font-size:12px;color:#888;margin-top:5px;">Use {name} and {link} placeholders.</p>
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
          <button onclick="deleteSelectedRecipients()" id="deleteSelectedBtn" class="delete-btn">Delete Selected</button>
          <button onclick="deleteAllRecipients()" style="padding:10px 25px;background:#dc3545;color:white;border:none;border-radius:5px;cursor:pointer;font-weight:bold;opacity:0.7;">Delete All</button>
          <button onclick="deleteAllSent()" style="padding:10px 25px;background:#ff9800;color:white;border:none;border-radius:5px;cursor:pointer;font-weight:bold;">Delete Sent</button>
        </div>
        
        <div id="recipientList"><p>Loading...</p></div>
      </div>
    </div>
    
    <div id="settings-tab" class="tab-content">
      <div class="card">
        <h3>SMTP Settings</h3>
        <p style="color:#666;font-size:14px;margin-bottom:15px;">Configure your email server settings.</p>
        <form id="settingsForm" class="settings-form" onsubmit="saveSettings(event)">
          <div class="form-group">
            <label for="smtpHost">SMTP Host:</label>
            <input type="text" id="smtpHost" placeholder="smtp.gmail.com">
          </div>
          <div class="form-group">
            <label for="smtpPort">SMTP Port:</label>
            <input type="number" id="smtpPort" placeholder="587">
          </div>
          <div class="form-group">
            <label for="senderEmail">Sender Email:</label>
            <input type="email" id="senderEmail" placeholder="your-email@gmail.com">
          </div>
          <div class="form-group">
            <label for="senderPassword">Password / App Password:</label>
            <input type="password" id="senderPassword" placeholder="your-app-password">
          </div>
          <div class="form-group">
            <label for="smtpSecure">Secure Connection:</label>
            <select id="smtpSecure">
              <option value="0">No (Port 587 - TLS)</option>
              <option value="1">Yes (Port 465 - SSL)</option>
            </select>
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
    // Fixed Single Page Application (SPA) Tab System Component Router
    function showTab(tabId) {
      var contents = document.querySelectorAll('.tab-content');
      contents.forEach(content => content.classList.remove('active'));
      
      var tabs = document.querySelectorAll('.tab');
      tabs.forEach(tab => tab.classList.remove('active'));
      
      var selectedContent = document.getElementById(tabId);
      if (selectedContent) {
        selectedContent.classList.add('active');
      }
      
      tabs.forEach(tab => {
        const clickAttr = tab.getAttribute('onclick') || '';
        if (clickAttr.includes(tabId)) {
          tab.classList.add('active');
        }
      });

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
          messageEl.textContent = 'Success: ' + data.message;
          messageEl.style.color = '#28a745';
        } else {
          messageEl.textContent = 'Error: ' + data.error;
          messageEl.style.color = '#dc3545';
        }
      } catch (error) {
        messageEl.textContent = 'Error: ' + error.message;
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
          messageEl.textContent = 'Success: ' + data.message;
          messageEl.style.color = '#28a745';
        } else {
          messageEl.textContent = 'Error: ' + data.error;
          messageEl.style.color = '#dc3545';
        }
      } catch (error) {
        messageEl.textContent = 'Error: ' + error.message;
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
          statusEl.textContent = 'Success: ' + data.message;
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
          statusEl.textContent = 'Error: ' + data.error;
          statusEl.style.color = '#dc3545';
        }
      } catch (error) {
        statusEl.textContent = 'Error: ' + error.message;
        statusEl.style.color = '#dc3545';
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Emails';
      }
    }

    // ============================================
// REVISED SELECTION & COMPLETE BULK DELETIONS (FRONTEND)
// ============================================

    async function deleteSelectedRecipients() {
      var selected = getSelectedEmails();
      if (selected.length === 0) {
        alert('Please select at least one recipient.');
        return;
      }
      
      var confirmMsg = selected.length === 1 
        ? 'Delete this selected recipient record?' 
        : 'Delete all ' + selected.length + ' selected recipient records?';
        
      if (!confirm(confirmMsg)) return;
      
      var deleteBtn = document.getElementById('deleteSelectedBtn');
      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting...';
      
      try {
        var response = await fetch('/api/recipients/bulk-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emails: selected })
        });
        var data = await response.json();
        if (response.ok) {
          alert(data.message);
          loadRecipients();
        } else {
          alert('Error: ' + data.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      } finally {
        deleteBtn.disabled = false;
        deleteBtn.textContent = 'Delete Selected';
      }
    }

    async function deleteAllRecipients() {
      if (!confirm('Are you sure you want to completely clear out ALL recipients and historical track logs? This cannot be undone.')) return;
      try {
        var response = await fetch('/api/recipients/all', { method: 'DELETE' });
        var data = await response.json();
        if (response.ok) { 
          alert(data.message);
          loadRecipients(); 
        } else { 
          alert('Error: ' + data.error); 
        }
      } catch (error) { 
        alert('Error: ' + error.message); 
      }
    }

    async function deleteAllSent() {
      if (!confirm('Clear out all active campaign records that have a valid "Sent At" confirmation timestamp?')) return;
      try {
        var response = await fetch('/api/recipients/sent', { method: 'DELETE' });
        var data = await response.json();
        if (response.ok) { 
          alert(data.message);
          loadRecipients(); 
        } else { 
          alert('Error: ' + data.error); 
        }
      } catch (error) { 
        alert('Error: ' + error.message); 
      }
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

    document.addEventListener('DOMContentLoaded', function() {
      loadRecipients();
      loadSettings();
    });
  </script>
</body>
</html>
    `;
    
    res.send(html);
  } catch (error) {
    res.send('<h2>Error: ' + error.message + '</h2>');
  }
});

app.get('/clicked-link-page', (req, res) => {
  const name = req.query.name || 'there';
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Thank You!</title></head>
    <body style="font-family:Arial;text-align:center;padding:50px;">
      <h1>THIS WAS A SECURITY TEST ${escapeHTML(name)}!</h1>
      <p>You have failed The Security test.</p>
      <p>Please be more cautious.</p>
    </body>
    </html>
  `);
});

// Port listener explicitly set to support server execution
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port', PORT);
});

module.exports = app;