require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const multer = require('multer');
const Papa = require('papaparse');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-this-in-production';

// Serverless-optimized connection pool config
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
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

// AUTHENTICATION MIDDLEWARE
function authenticateToken(req, res, next) {
  const token = req.cookies.token;

  if (!token) {
    if (req.path === '/dashboard') {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'Access denied. Please log in.' });
  }

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;
    next();
  } catch (error) {
    res.clearCookie('token');
    if (req.path === '/dashboard') return res.redirect('/login');
    return res.status(403).json({ error: 'Invalid or expired session token.' });
  }
}

// ============================================
// FIXED: GENERATE LINKS FUNCTION
// ============================================
function generateLinks(recipients, baseUrl) {
  const results = [];
  recipients.forEach(person => {
    const uniqueId = crypto.randomBytes(16).toString('hex');
    const base = baseUrl || 'https://email-tracker-rose.vercel.app';
    const link = base + '/click/' + uniqueId;

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

// ============================================
// EXPORT FUNCTIONS
// ============================================

// Helper function to get export data
async function getExportData(userId) {
  const result = await query(`
    SELECT 
      r.email,
      r.name,
      r.sent_at,
      COUNT(c.id) as click_count,
      MAX(c.timestamp) as last_click
    FROM recipients r
    LEFT JOIN clicks c ON r.id = c.recipient_id
    WHERE r.user_id = $1
    GROUP BY r.id, r.email, r.name, r.sent_at
    ORDER BY r.sent_at DESC
  `, [userId]);
  return result.rows;
}

// EXPORT CSV
app.get('/api/export/csv', authenticateToken, async (req, res) => {
  try {
    const rows = await getExportData(req.user.id);

    let csv = 'Email,Name,Sent At,Clicks,Last Click\n';

    rows.forEach(row => {
      const sentAt = row.sent_at ? new Date(row.sent_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }) : 'Not sent';
      const lastClick = row.last_click ? new Date(row.last_click).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }) : 'Never';
      csv += `"${row.email}","${row.name || ''}","${sentAt}",${row.click_count},"${lastClick}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=recipients_export.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// EXPORT EXCEL (XLSX)
app.get('/api/export/excel', authenticateToken, async (req, res) => {
  try {
    const rows = await getExportData(req.user.id);

    const excelData = rows.map(row => ({
      'Email': row.email,
      'Name': row.name || '',
      'Sent At': row.sent_at ? new Date(row.sent_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }) : 'Not sent',
      'Clicks': row.click_count,
      'Last Click': row.last_click ? new Date(row.last_click).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }) : 'Never'
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(excelData);
    XLSX.utils.book_append_sheet(wb, ws, 'Recipients');

    const colWidths = [
      { wch: 30 },
      { wch: 20 },
      { wch: 25 },
      { wch: 10 },
      { wch: 25 }
    ];
    ws['!cols'] = colWidths;

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=recipients_export.xlsx');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// EXPORT PDF
app.get('/api/export/pdf', authenticateToken, async (req, res) => {
  try {
    const rows = await getExportData(req.user.id);

    const doc = new PDFDocument({ margin: 30 });
    const buffers = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfData = Buffer.concat(buffers);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=recipients_export.pdf');
      res.send(pdfData);
    });

    // Title
    doc.fontSize(20).text('Recipients Export', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text('Generated: ' + new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }), { align: 'center' });
    doc.moveDown();
    doc.text('Total Recipients: ' + rows.length, { align: 'center' });
    doc.moveDown(2);

    // Table headers
    const tableTop = doc.y;
    const col1 = 30;
    const col2 = 180;
    const col3 = 330;
    const col4 = 460;
    const col5 = 520;

    doc.fontSize(10).font('Helvetica-Bold');
    doc.text('Email', col1, tableTop);
    doc.text('Name', col2, tableTop);
    doc.text('Sent At', col3, tableTop);
    doc.text('Clicks', col4, tableTop);
    doc.text('Last Click', col5, tableTop);

    doc.moveTo(30, tableTop + 15).lineTo(580, tableTop + 15).stroke();

    let y = tableTop + 25;
    doc.font('Helvetica');

    rows.forEach((row, index) => {
      if (y > 750) {
        doc.addPage();
        y = 50;
        doc.font('Helvetica-Bold');
        doc.text('Email', col1, y);
        doc.text('Name', col2, y);
        doc.text('Sent At', col3, y);
        doc.text('Clicks', col4, y);
        doc.text('Last Click', col5, y);
        doc.moveTo(30, y + 15).lineTo(580, y + 15).stroke();
        y += 25;
        doc.font('Helvetica');
      }

      const sentAt = row.sent_at ? new Date(row.sent_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }) : 'Not sent';
      const lastClick = row.last_click ? new Date(row.last_click).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }) : 'Never';

      doc.text(row.email, col1, y);
      doc.text(row.name || '', col2, y);
      doc.text(sentAt, col3, y);
      doc.text(String(row.click_count), col4, y);
      doc.text(lastClick, col5, y);

      y += 18;
    });

    doc.moveDown(2);
    doc.fontSize(8).text('Generated by Email Tracker System', { align: 'center' });

    doc.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// FIXED: SEND EMAILS WITH ATTACHMENTS
// ============================================
async function sendEmails(recipients, customSubject, customTemplate, userId, attachments) {
  const settingsResult = await query('SELECT * FROM settings WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [userId]);
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

  // Process attachments
  let attachmentObjects = [];
  if (attachments && attachments.length > 0) {
    console.log('Processing ' + attachments.length + ' attachments');

    for (const att of attachments) {
      try {
        let content = att.content;

        // If content is a data URL, extract the base64 data
        if (typeof content === 'string' && content.includes(';base64,')) {
          const base64Data = content.split(';base64,')[1];
          content = Buffer.from(base64Data, 'base64');
        } else if (typeof content === 'string') {
          // Try to decode as base64
          content = Buffer.from(content, 'base64');
        }

        // Verify the content is valid
        if (content && content.length > 0) {
          attachmentObjects.push({
            filename: att.filename || 'attachment',
            content: content,
            contentType: att.contentType || 'application/octet-stream'
          });
          console.log('Added attachment: ' + att.filename);
        } else {
          console.log('Skipping invalid attachment: ' + att.filename);
        }
      } catch (error) {
        console.log('Error processing attachment ' + att.filename + ':', error.message);
      }
    }
  }

  for (const person of recipients) {
    const existingResult = await query('SELECT id, link, name FROM recipients WHERE email = $1 AND user_id = $2', [person.email, userId]);
    const existingRecipient = existingResult.rows[0];

    if (!existingRecipient) {
      sentEmails.push({ email: person.email, status: 'failed', error: 'Recipient not found' });
      continue;
    }

    const link = existingRecipient.link;
    const name = existingRecipient.name;

    console.log('Sending to', person.email, 'Link:', link);

    let htmlContent = template
      .replace(/{name}/g, name)
      .replace(/{link}/g, link);

    const mailOptions = {
      from: settings.sender_email,
      to: person.email,
      subject: subject,
      html: htmlContent
    };

    if (attachmentObjects.length > 0) {
      mailOptions.attachments = attachmentObjects;
      console.log('Sending ' + attachmentObjects.length + ' attachments to ' + person.email);
    }

    try {
      await transporter.sendMail(mailOptions);
      await query('UPDATE recipients SET sent_at = NOW() WHERE email = $1 AND user_id = $2', [person.email, userId]);
      sentEmails.push({ email: person.email, status: 'sent' });
      console.log('Email sent to', person.email);

      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      console.error('Failed to send to', person.email, error.message);
      sentEmails.push({ email: person.email, status: 'failed', error: error.message });
    }
  }

  return sentEmails;
}

// ============================================
// AUTH VIEWS & API ENDPOINTS
// ============================================

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Login - Email Tracker</title>
      <style>
        body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f5f5f5; margin: 0; }
        .auth-card { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); width: 100%; max-width: 400px; }
        h2 { margin-top: 0; color: #333; text-align: center; }
        input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
        button { width: 100%; padding: 12px; background: #007bff; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 16px; transition: background 0.2s; }
        button:hover { background: #0056b3; }
        .toggle-link { text-align: center; margin-top: 20px; font-size: 14px; color: #666; }
        .toggle-link a { color: #007bff; text-decoration: none; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="auth-card">
        <h2>Login to Campaign</h2>
        <form action="/api/auth/login" method="POST">
          <input type="email" name="email" placeholder="Email Address" required>
          <input type="password" name="password" placeholder="Password" required>
          <button type="submit">Sign In</button>
        </form>
        <div class="toggle-link">Don't have an account? <a href="/register">Register here</a></div>
      </div>
    </body>
    </html>
  `);
});

app.get('/register', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Register - Email Tracker</title>
      <style>
        body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f5f5f5; margin: 0; }
        .auth-card { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); width: 100%; max-width: 400px; }
        h2 { margin-top: 0; color: #333; text-align: center; }
        input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
        button { width: 100%; padding: 12px; background: #28a745; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 16px; transition: background 0.2s; }
        button:hover { background: #218838; }
        .toggle-link { text-align: center; margin-top: 20px; font-size: 14px; color: #666; }
        .toggle-link a { color: #007bff; text-decoration: none; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="auth-card">
        <h2>Create Account</h2>
        <form action="/api/auth/register" method="POST">
          <input type="text" name="username" placeholder="Username" required>
          <input type="email" name="email" placeholder="Email Address" required>
          <input type="password" name="password" placeholder="Password" required>
          <button type="submit">Sign Up</button>
        </form>
        <div class="toggle-link">Already have an account? <a href="/login">Login here</a></div>
      </div>
    </body>
    </html>
  `);
});

app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [username, email, passwordHash]
    );

    await query(
      'INSERT INTO settings (user_id, smtp_host, smtp_port, smtp_secure, sender_email, sender_password) VALUES ($1, $2, $3, $4, $5, $6)',
      [result.rows[0].id, 'smtp.gmail.com', 587, 0, 'placeholder@gmail.com', 'password']
    );

    res.send('<body style="font-family:Arial;text-align:center;padding:50px;"><h3>Registration successful! <a href="/login">Click here to login</a></h3></body>');
  } catch (error) {
    res.status(400).send('Registration failed: ' + error.message);
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(400).send('<body style="font-family:Arial;text-align:center;padding:50px;"><h3>Invalid credentials. <a href="/login">Try again</a></h3></body>');
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });

    res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'strict' });
    res.redirect('/dashboard');
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/login');
});

// ============================================
// CORE ISOLATED API ENDPOINTS
// ============================================

app.get('/click/:id', async (req, res) => {
  const id = req.params.id;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const ip = req.ip || req.connection.remoteAddress || 'Unknown';

  try {
    const result = await query('SELECT email, name, user_id FROM recipients WHERE id = $1', [id]);
    const row = result.rows[0];

    if (!row) {
      return res.status(404).send('Invalid tracking node execution asset.');
    }

    await query(
      'INSERT INTO clicks (recipient_id, user_id, email, timestamp, user_agent, ip) VALUES ($1, $2, $3, NOW(), $4, $5)',
      [id, row.user_id, row.email, userAgent, ip]
    );

   /* res.redirect('/clicked-link-page?email=' + encodeURIComponent(row.email) + '&name=' + encodeURIComponent(row.name));*/
    
res.redirect('https://prepared-purple-zmobzvzj-dp2t09e24sra.edgeone.dev');
  } catch (error) {
    console.error('Error in tracking:', error);
    res.status(500).send('Server error');
  }
});

app.get('/api/recipients', authenticateToken, async (req, res) => {
  try {
    const result = await query('SELECT email, name, sent_at FROM recipients WHERE user_id = $1 ORDER BY sent_at DESC', [req.user.id]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/recipients', authenticateToken, async (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const existing = await query('SELECT * FROM recipients WHERE email = $1 AND user_id = $2', [email, req.user.id]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email already exists in your account records.' });
    }

    const uniqueId = crypto.randomBytes(16).toString('hex');
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const link = baseUrl + '/click/' + uniqueId;

    let finalName = name;
    if (!finalName) {
      finalName = email.split('@')[0].replace(/[0-9]/g, '').replace(/[._-]/g, ' ').trim();
      finalName = finalName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      if (!finalName) finalName = 'N/A';
    }

    await query(
      'INSERT INTO recipients (id, user_id, email, name, link, sent_at) VALUES ($1, $2, $3, $4, $5, NULL)',
      [uniqueId, req.user.id, email, finalName, link]
    );

    res.json({ success: true, message: 'Recipient added successfully!', email: email, name: finalName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/recipients/import', authenticateToken, upload.single('csvFile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const csvString = req.file.buffer.toString('utf8');
    const result = Papa.parse(csvString, { header: true, skipEmptyLines: true, trimHeaders: true });

    const results = [];
    result.data.forEach((row) => {
      const emailKey = Object.keys(row).find(key => key.toLowerCase().trim() === 'email');
      const nameKey = Object.keys(row).find(key => key.toLowerCase().trim() === 'name');
      if (emailKey && row[emailKey]) {
        results.push({ email: row[emailKey].trim(), name: nameKey ? row[nameKey].trim() : '' });
      }
    });

    if (results.length === 0) return res.status(400).json({ error: 'No valid emails found.' });

    let saved = 0;
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

    for (const person of results) {
      const uniqueId = crypto.randomBytes(16).toString('hex');
      const link = baseUrl + '/click/' + uniqueId;
      let name = person.name || person.email.split('@')[0].replace(/[._-]/g, ' ');

      await query(
        'INSERT INTO recipients (id, user_id, email, name, link, sent_at) VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (email, user_id) DO NOTHING',
        [uniqueId, req.user.id, person.email, name, link]
      );
      saved++;
    }
    res.json({ success: true, message: 'Imported ' + saved + ' records successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/settings', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM settings WHERE user_id = $1', [req.user.id]);

    if (result.rows.length === 0) {
      return res.json({ smtp_host: '', smtp_port: '', sender_email: '', smtp_secure: 0 });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch your settings profile.' });
  }
});

app.post('/api/settings', authenticateToken, async (req, res) => {
  const { smtp_host, smtp_port, sender_email, sender_password, smtp_secure } = req.body;
  try {
    await pool.query(
      `INSERT INTO settings (user_id, smtp_host, smtp_port, sender_email, sender_password, smtp_secure)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id)
       DO UPDATE SET
          smtp_host = EXCLUDED.smtp_host,
          smtp_port = EXCLUDED.smtp_port,
          sender_email = EXCLUDED.sender_email,
          sender_password = EXCLUDED.sender_password,
          smtp_secure = EXCLUDED.smtp_secure`,
      [req.user.id, smtp_host, parseInt(smtp_port), sender_email, sender_password, parseInt(smtp_secure)]
    );
    res.json({ success: true, message: 'Configuration parameters saved securely.' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update settings: ' + error.message });
  }
});

app.post('/api/settings/test', authenticateToken, async (req, res) => {
  const { smtp_host, smtp_port, smtp_secure, sender_email, sender_password } = req.body;

  if (!smtp_host || !smtp_port || !sender_email || !sender_password) {
    return res.status(400).json({ error: 'All fields are required to test connection.' });
  }

  const transporter = nodemailer.createTransport({
    host: smtp_host,
    port: parseInt(smtp_port),
    secure: parseInt(smtp_secure) === 1,
    auth: {
      user: sender_email,
      pass: sender_password
    },
    connectTimeout: 5000
  });

  try {
    await transporter.verify();
    res.json({ success: true, message: 'SMTP Endpoint Connection Successful! Your credentials are valid.' });
  } catch (error) {
    console.error('SMTP Test Error:', error.message);
    res.status(500).json({ error: 'Connection Failed: ' + error.message });
  }
});

// ============================================
// FIXED: SEND EMAILS WITH ATTACHMENTS SUPPORT
// ============================================
app.post('/api/send-emails', authenticateToken, async (req, res) => {
  const { subject, template, attachments } = req.body;
  try {
    const recipientsResult = await query('SELECT email, name FROM recipients WHERE user_id = $1', [req.user.id]);
    if (recipientsResult.rows.length === 0) return res.status(400).json({ error: 'No recipients found.' });

    const results = await sendEmails(recipientsResult.rows, subject, template, req.user.id, attachments);
    res.json({ success: true, message: 'Emails dispatched.', results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DELETION API ENDPOINTS (ISOLATED)
// ============================================

app.post('/api/recipients/bulk-delete', authenticateToken, async (req, res) => {
  const { emails } = req.body;
  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'No data selected.' });
  }
  try {
    await query('DELETE FROM clicks WHERE email = ANY($1) AND user_id = $2', [emails, req.user.id]);
    const result = await query('DELETE FROM recipients WHERE email = ANY($1) AND user_id = $2', [emails, req.user.id]);
    res.json({ success: true, message: 'Successfully deleted ' + result.rowCount + ' recipient(s).' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/recipients/all', authenticateToken, async (req, res) => {
  try {
    await query('DELETE FROM clicks WHERE user_id = $1', [req.user.id]);
    await query('DELETE FROM recipients WHERE user_id = $1', [req.user.id]);
    res.json({ success: true, message: 'All list entries cleared.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/recipients/sent', authenticateToken, async (req, res) => {
  try {
    const sentResult = await query('SELECT email FROM recipients WHERE sent_at IS NOT NULL AND user_id = $1', [req.user.id]);
    const emails = sentResult.rows.map(r => r.email);
    if (emails.length === 0) return res.json({ success: true, message: 'No records to clear.' });

    await query('DELETE FROM clicks WHERE email = ANY($1) AND user_id = $2', [emails, req.user.id]);
    await query('DELETE FROM recipients WHERE sent_at IS NOT NULL AND user_id = $1', [req.user.id]);
    res.json({ success: true, message: 'Sent metrics wiped.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DASHBOARD VIEW LAYER (AUTHENTICATED)
// ============================================
app.get('/dashboard', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const statusFilter = req.query.status || 'all';
  const dateFilter = req.query.date || 'all';

  let whereClause = '';
  let dateCondition = '';

  if (statusFilter === 'clicked') whereClause = 'HAVING COUNT(c.id) > 0';
  else if (statusFilter === 'not-clicked') whereClause = 'HAVING COUNT(c.id) = 0';

  if (dateFilter === 'today') dateCondition = "AND DATE(r.sent_at) = CURRENT_DATE";
  else if (dateFilter === 'yesterday') dateCondition = "AND DATE(r.sent_at) = CURRENT_DATE - INTERVAL '1 day'";
  else if (dateFilter === 'week') dateCondition = "AND DATE(r.sent_at) >= CURRENT_DATE - INTERVAL '7 days'";

  const queryText = `
    SELECT r.email, r.name, r.sent_at, COUNT(c.id) as click_count, MAX(c.timestamp) as last_click
    FROM recipients r
    LEFT JOIN clicks c ON r.id = c.recipient_id
    WHERE r.user_id = $1 ${dateCondition}
    GROUP BY r.id, r.email, r.name, r.sent_at
    ${whereClause}
    ORDER BY r.sent_at DESC
  `;

  try {
    const rowsResult = await query(queryText, [userId]);
    const rows = rowsResult.rows;

    const totalSent = rows.length;
    let totalClicked = 0;
    let totalNotClicked = 0;
    rows.forEach(r => { if (parseInt(r.click_count) > 0) totalClicked++; else totalNotClicked++; });

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

    let tableRows = rows.length === 0
      ? '<div class="no-results"><p>No recipients found.</p></div>'
      : '<table><tr><th>Status</th><th>Email</th><th>Name</th><th>Sent At</th><th>Clicks</th><th>Last Click</th></tr>';

    if (rows.length > 0) {
      rows.forEach(row => {
        const sentAt = row.sent_at ? new Date(row.sent_at).toLocaleString() : 'Not sent yet';
        const lastClick = row.last_click ? new Date(row.last_click).toLocaleString() : '-';
        tableRows += `
          <tr>
            <td class="${parseInt(row.click_count) > 0 ? 'status-clicked' : 'status-not-clicked'}">${parseInt(row.click_count) > 0 ? 'Clicked' : 'Not Clicked'}</td>
            <td><strong>${escapeHTML(row.email)}</strong></td>
            <td>${escapeHTML(row.name)}</td>
            <td>${sentAt}</td>
            <td>${row.click_count}</td>
            <td>${lastClick}</td>
          </tr>`;
      });
      tableRows += '</table>';
    }

    res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; margin: 0; }
    .container { max-width: 1200px; margin: 0 auto; }
    .header-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .tabs { display: flex; gap: 5px; margin-bottom: 20px; border-bottom: 2px solid #e9ecef; background: white; padding: 0 20px; border-radius: 10px 10px 0 0; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .tab { padding: 14px 24px; cursor: pointer; border: none; background: none; font-size: 16px; color: #6c757d; border-bottom: 3px solid transparent; }
    .tab.active { color: #007bff; border-bottom-color: #007bff; font-weight: bold; }
    .tab-content { display: none; padding: 20px 0; }
    .tab-content.active { display: block; }
    .filter-bar { display: flex; gap: 15px; flex-wrap: wrap; align-items: center; }
    .filter-bar select { padding: 8px 12px; border: 1px solid #ddd; border-radius: 5px; }
    .btn { padding: 8px 20px; background: #007bff; color: white; border: none; border-radius: 5px; cursor: pointer; text-decoration: none; font-size: 14px; }
    .summary { display: flex; gap: 20px; margin-bottom: 20px; }
    .summary-card { background: #f8f9fa; padding: 15px 25px; border-radius: 8px; flex: 1; text-align: center; }
    .summary-card .number { font-size: 32px; font-weight: bold; color: #007bff; }
    .summary-card .number.green { color: #28a745; }
    .summary-card .number.red { color: #dc3545; }
    .add-form input { padding: 10px; border: 1px solid #ddd; border-radius: 5px; margin-right: 10px; }
    .settings-form input { width: 100%; padding: 10px; margin-bottom: 15px; border: 1px solid #ddd; border-radius: 5px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f8f9fa; }
    .status-clicked { color: #28a745; font-weight: bold; }
    .status-not-clicked { color: #dc3545; font-weight: bold; }
    .delete-btn { background: #dc3545; color: white; border: none; padding: 10px 25px; border-radius: 5px; cursor: pointer; }
    .btn-group { display: flex; gap: 10px; flex-wrap: wrap; }
    .export-section { background: #e8f5e9; padding: 10px; border-radius: 8px; margin-bottom: 15px; }
    .attachment-section { margin-top: 15px; padding-top: 15px; border-top: 1px solid #e9ecef; }
    .attachment-item { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
    .attachment-item input[type="file"] { flex: 1; }
    .attachment-item button { padding: 4px 10px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .attachment-item button:hover { background: #c82333; }

    /* Animated Toast Notification Container */
    #toast-container {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .toast {
      background: #333;
      color: white;
      padding: 12px 24px;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      font-size: 14px;
      font-weight: bold;
      opacity: 0;
      transform: translateY(20px);
      animation: slideIn 0.3s forwards, fadeOut 0.3s 4s forwards;
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 250px;
    }
    .toast.success { background: #28a745; border-left: 5px solid #1e7e34; }
    .toast.error { background: #dc3545; border-left: 5px solid #bd2130; }
    .toast.info { background: #007bff; border-left: 5px solid #0056b3; }

    @keyframes slideIn {
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fadeOut {
      to { opacity: 0; transform: translateY(-20px); pointer-events: none; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <h1>Campaign Hub</h1>
      <a href="/api/auth/logout" class="btn" style="background:#dc3545; font-weight:bold;">Logout Account</a>
    </div>
    <div class="tabs">
      <button class="tab active" onclick="showTab('dashboard-tab')">Dashboard</button>
      <button class="tab" onclick="showTab('manage-tab')">Manage Recipients</button>
      <button class="tab" onclick="showTab('settings-tab')">Settings</button>
    </div>

    <div id="dashboard-tab" class="tab-content active">
      <div class="card">
        <form method="GET" action="/dashboard" class="filter-bar">
          <select name="status">${statusOptions}</select>
          <select name="date">${dateOptions}</select>
          <button type="submit" class="btn">Apply Filters</button>
        </form>
      </div>
      <div class="summary">
        <div class="summary-card"><div class="number">${totalSent}</div><div>Total Sent</div></div>
        <div class="summary-card"><div class="number green">${totalClicked}</div><div>Clicked</div></div>
        <div class="summary-card"><div class="number red">${totalNotClicked}</div><div>Not Clicked</div></div>
      </div>
      <div class="card">${tableRows}</div>
    </div>

    <div id="manage-tab" class="tab-content">
      <div class="card">
        <h3>Add Recipient Manually</h3>
        <form class="add-form" onsubmit="addRecipient(event)">
          <input type="email" id="emailInput" placeholder="Email Address" required>
          <input type="text" id="nameInput" placeholder="Name">
          <button type="submit" class="btn" style="background:#28a745;">Add</button>
          <span id="addMessage"></span>
        </form>
      </div>
      <div class="card">
        <h3>Import via CSV File</h3>
        <form onsubmit="importCSV(event)">
          <input type="file" id="csvFile" accept=".csv" required>
          <button type="submit" class="btn">Upload List</button>
          <span id="importStatus"></span>
        </form>
      </div>
      <div class="card" style="background:#f8f9ff; border: 1px solid #007bff;">
        <h3>Execute Campaign Broadcast</h3>
        <input type="text" id="emailSubject" value="Reminder to attend meeting" style="width:100%; padding:10px; margin-bottom:10px;">
        <textarea id="emailTemplate" rows="4" style="width:100%; padding:10px;"><h2>Hello {name}!</h2><p><a href="{link}">Click Here</a></p></textarea>

        <div class="attachment-section">
          <h4>Attachments</h4>
          <div id="attachmentList">
            <div class="attachment-item">
              <input type="file" id="attachmentInput" multiple>
              <button type="button" class="btn" onclick="addAttachment()">Add File</button>
            </div>
          </div>
          <div id="attachedFiles" style="margin-top:10px;"></div>
        </div>

        <button onclick="sendEmails()" id="sendBtn" class="btn" style="margin-top:10px; width:200px;">Send Emails</button>
        <span id="sendStatus"></span>
        <div id="sendProgress"></div>
      </div>
      <div class="card">
        <h3>Recipients Actions</h3>
        <div class="btn-group" style="margin-bottom:15px;">
          <button onclick="selectAllRecipients()" class="btn" style="background:#6c757d;">Select All</button>
          <button onclick="deselectAllRecipients()" class="btn" style="background:#6c757d;">Clear Selection</button>
          <button onclick="deleteSelectedRecipients()" id="deleteSelectedBtn" class="delete-btn">Delete Selected</button>
          <button onclick="deleteAllRecipients()" class="delete-btn" style="opacity:0.6;">Wipe All Data</button>
          <button onclick="deleteAllSent()" class="btn" style="background:#ff9800;">Wipe Sent Entries</button>
        </div>

        <div class="export-section">
          <strong>Export Data:</strong>
          <div class="btn-group">
            <button onclick="exportData('csv')" class="btn" style="background:#28a745;">CSV</button>
            <button onclick="exportData('excel')" class="btn" style="background:#007bff;">Excel</button>
            <button onclick="exportData('pdf')" class="btn" style="background:#dc3545;">PDF</button>
          </div>
        </div>

        <div id="recipientList">Loading list...</div>
      </div>
    </div>

    <div id="settings-tab" class="tab-content">
      <div class="card">
        <h3>User SMTP Settings Profile</h3>
        <form class="settings-form" onsubmit="saveSettings(event)">
          <input type="text" id="smtpHost" placeholder="SMTP Host">
          <input type="number" id="smtpPort" placeholder="SMTP Port">
          <input type="email" id="senderEmail" placeholder="Sender Email Address">
          <input type="password" id="senderPassword" placeholder="App Password">
          <select id="smtpSecure" style="width:100%; padding:10px; margin-bottom:15px;"><option value="0">TLS (587)</option><option value="1">SSL (465)</option></select>
          <button type="submit" class="btn">Save Configuration</button>
          <button type="button" class="btn" style="background:#28a745;" onclick="testSettings()">Test Endpoint Connection</button>
          <div id="settingsMessage" style="margin-top:10px; font-weight:bold;"></div>
        </form>
      </div>
    </div>
  </div>

  <script>
    var attachments = [];

    function showTab(tabId) {
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      var target = document.getElementById(tabId);
      if (target) target.classList.add('active');
      document.querySelectorAll('.tab').forEach(t => {
        if(t.getAttribute('onclick').includes(tabId)) t.classList.add('active');
      });
      if (tabId === 'manage-tab') loadRecipients();
      if (tabId === 'settings-tab') loadSettings();
    }

    function addAttachment() {
      var input = document.getElementById('attachmentInput');
      if (input.files.length === 0) return;

      var container = document.getElementById('attachedFiles');

      for (var i = 0; i < input.files.length; i++) {
        var file = input.files[i];
        var reader = new FileReader();

        reader.onload = function(e) {
          var fileData = e.target.result;

          attachments.push({
            filename: file.name,
            content: fileData,
            contentType: file.type || 'application/octet-stream'
          });

          var div = document.createElement('div');
          div.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:5px 10px;background:#f8f9fa;margin:5px 0;border-radius:4px;';
          div.innerHTML = '<span>' + file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)</span><button onclick="this.parentElement.remove(); removeAttachment(\\'' + file.name + '\\')" style="background:#dc3545;color:white;border:none;border-radius:4px;cursor:pointer;padding:2px 10px;">X</button>';
          container.appendChild(div);
        };

        reader.readAsDataURL(file);
      }
      input.value = '';
    }

    function removeAttachment(filename) {
      attachments = attachments.filter(function(a) { return a.filename !== filename; });
    }

    function getAttachments() {
      return attachments;
    }

    function exportData(format) {
      window.location.href = '/api/export/' + format;
    }

    function showNotification(message, type) {
      var container = document.getElementById('toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
      }

      var toast = document.createElement('div');
      toast.className = 'toast ' + (type || 'info');
      toast.innerText = message;

      container.appendChild(toast);
      setTimeout(function() { toast.remove(); }, 4500);
    }

    async function loadSettings() {
      var r = await fetch('/api/settings');
      var d = await r.json();
      if(d) {
        document.getElementById('smtpHost').value = d.smtp_host || '';
        document.getElementById('smtpPort').value = d.smtp_port || '';
        document.getElementById('senderEmail').value = d.sender_email || '';
        document.getElementById('senderPassword').value = d.sender_password || '';
        document.getElementById('smtpSecure').value = d.smtp_secure || 0;
      }
    }

    async function saveSettings(e) {
      e.preventDefault();
      var payload = {
        smtp_host: document.getElementById('smtpHost').value,
        smtp_port: document.getElementById('smtpPort').value,
        sender_email: document.getElementById('senderEmail').value,
        sender_password: document.getElementById('senderPassword').value,
        smtp_secure: document.getElementById('smtpSecure').value
      };

      var r = await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      var d = await r.json();
      if (r.ok) {
        showNotification(d.message, 'success');
      } else {
        showNotification(d.error || 'Failed to update settings', 'error');
      }
    }

    async function testSettings() {
      var msg = document.getElementById('settingsMessage');
      msg.textContent = 'Testing connection parameters...';
      var payload = {
        smtp_host: document.getElementById('smtpHost').value,
        smtp_port: document.getElementById('smtpPort').value,
        sender_email: document.getElementById('senderEmail').value,
        sender_password: document.getElementById('senderPassword').value,
        smtp_secure: document.getElementById('smtpSecure').value
      };
      var r = await fetch('/api/settings/test', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      var d = await r.json();
      msg.textContent = r.ok ? d.message : d.error;
      msg.style.color = r.ok ? '#28a745' : '#dc3545';
    }

    async function addRecipient(e) {
      e.preventDefault();
      var email = document.getElementById('emailInput').value;
      var name = document.getElementById('nameInput').value;
      var r = await fetch('/api/recipients', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email, name}) });
      var d = await r.json();
      document.getElementById('addMessage').textContent = d.message || d.error;
      if(r.ok) { document.getElementById('emailInput').value = ''; document.getElementById('nameInput').value = ''; loadRecipients(); }
    }

    async function importCSV(e) {
      e.preventDefault();
      var fd = new FormData();
      fd.append('csvFile', document.getElementById('csvFile').files[0]);
      var r = await fetch('/api/recipients/import', { method:'POST', body:fd });
      var d = await r.json();
      document.getElementById('importStatus').textContent = d.message || d.error;
      if(r.ok) loadRecipients();
    }

    async function loadRecipients() {
      var container = document.getElementById('recipientList');
      var r = await fetch('/api/recipients');
      var d = await r.json();
      if(!d || d.length === 0) { container.innerHTML = '<p>List completely empty.</p>'; return; }

      var html = '<table><tr><th><input type="checkbox" id="masterCheck" onchange="toggleAll()"></th><th>Email</th><th>Name</th><th>Status</th></tr>';

      d.forEach(function(row) {
        var statusText = row.sent_at ? 'Sent' : 'Pending';
        var statusColor = row.sent_at ? '#28a745' : '#ff9800';

        html += '<tr>';
        html += '<td><input type="checkbox" class="rec-check" value="' + row.email + '"></td>';
        html += '<td>' + row.email + '</td>';
        html += '<td>' + row.name + '</td>';
        html += '<td style="color:' + statusColor + '">' + statusText + '</td>';
        html += '</tr>';
      });

      html += '</table>';
      container.innerHTML = html;
    }

    function toggleAll() {
      var m = document.getElementById('masterCheck').checked;
      document.querySelectorAll('.rec-check').forEach(c => c.checked = m);
    }
    function selectAllRecipients() { document.querySelectorAll('.rec-check').forEach(c => c.checked = true); }
    function deselectAllRecipients() { document.querySelectorAll('.rec-check').forEach(c => c.checked = false); }

    function getSelected() {
      var arr = [];
      document.querySelectorAll('.rec-check:checked').forEach(c => arr.push(c.value));
      return arr;
    }

    async function deleteSelectedRecipients() {
      var items = getSelected();
      if(items.length === 0) return alert('Select items to drop.');
      if(!confirm('Drop selected targets?')) return;
      var r = await fetch('/api/recipients/bulk-delete', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({emails:items}) });
      if(r.ok) loadRecipients();
    }

    async function deleteAllRecipients() {
      if(!confirm('Clear entire profile collection database?')) return;
      await fetch('/api/recipients/all', { method:'DELETE' });
      loadRecipients();
    }

    async function deleteAllSent() {
      if(!confirm('Clear sent profile records?')) return;
      await fetch('/api/recipients/sent', { method:'DELETE' });
      loadRecipients();
    }

    async function sendEmails() {
      var btn = document.getElementById('sendBtn');
      btn.disabled = true;
      btn.textContent = 'Processing...';

      var attachmentData = attachments.map(function(att) {
        return {
          filename: att.filename,
          content: att.content,
          contentType: att.contentType
        };
      });

      var payload = {
        subject: document.getElementById('emailSubject').value,
        template: document.getElementById('emailTemplate').value,
        attachments: attachmentData
      };

      var r = await fetch('/api/send-emails', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload)
      });

      var result = await r.json();
      if (r.ok) {
        alert('Broadcast processing complete.');
        window.location.reload();
      } else {
        alert('Error: ' + (result.error || 'Unknown error'));
      }
      btn.disabled = false;
      btn.textContent = 'Send Emails';
    }

    document.addEventListener('DOMContentLoaded', function() {
      loadRecipients();
      loadSettings();
    });
  </script>
</body>
</html>
    `);
  } catch (error) {
    res.send('<h2>Error loading secure dashboard asset layout: ' + error.message + '</h2>');
  }
});

app.get('/clicked-link-page', (req, res) => {
  const email = req.query.email || 'Guest';
  const name = req.query.name || 'there';
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Thank You</title></head>
    <body style="font-family:Arial;text-align:center;padding:50px;">
      <h1>THIS WAS A SECURITY TEST ${name}!</h1>
      <p>You have failed The Security test.</p>
      <p>Please be more cautious.</p>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('Multi-tenant tracker listening on port', PORT); });

module.exports = app;
