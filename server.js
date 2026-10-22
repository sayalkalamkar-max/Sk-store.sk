const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { parse } = require('querystring');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS = path.join(ROOT, 'public', 'uploads');
const ADMIN_PASS = 'skstore2026'; // Change this later

// Ensure folders exist
['apk', 'screenshots', 'payments'].forEach(d => {
  const p = path.join(UPLOADS, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const PRODUCT_FILE = path.join(DATA_DIR, 'product.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

// Default product
if (!fs.existsSync(PRODUCT_FILE)) {
  fs.writeFileSync(PRODUCT_FILE, JSON.stringify({
    title: 'SK Store',
    price: 49,
    description: 'Premium Android App - SK Store. Fast, secure and easy to use. Download after payment confirmation.',
    screenshots: [],
    apkFile: null,
    upiId: 'yourupi@paytm',
    bankName: 'Your Bank Name',
    accountNumber: 'XXXXXXXXXXXX',
    ifsc: 'XXXX0000000',
    accountHolder: 'Your Name',
    whatsapp: '91XXXXXXXXXX'
  }, null, 2));
}
if (!fs.existsSync(ORDERS_FILE)) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify([], null, 2));
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function send(res, status, body, type = 'text/html') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)$/);
      if (!boundaryMatch) return resolve({ fields: {}, files: {} });

      const boundary = boundaryMatch[1];
      const parts = buffer.toString('binary').split('--' + boundary);
      const fields = {};
      const files = {};

      for (const part of parts) {
        if (!part || part === '--\r\n' || part === '--') continue;
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd);
        const body = part.slice(headerEnd + 4, part.lastIndexOf('\r\n'));

        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        if (!nameMatch) continue;
        const name = nameMatch[1];

        if (filenameMatch) {
          const filename = filenameMatch[1];
          if (filename) {
            files[name] = {
              filename,
              data: Buffer.from(body, 'binary')
            };
          }
        } else {
          fields[name] = body.trim();
        }
      }
      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}

function getMime(ext) {
  const map = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.apk': 'application/vnd.android.package-archive',
    '.json': 'application/json'
  };
  return map[ext] || 'application/octet-stream';
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Static files
  if (pathname.startsWith('/uploads/') || pathname.startsWith('/css/') || pathname.startsWith('/js/')) {
    const filePath = path.join(ROOT, 'public', pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': getMime(ext) });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // ========== PUBLIC ROUTES ==========
  if (pathname === '/' || pathname === '/index.html') {
    const product = readJSON(PRODUCT_FILE);
    const html = renderProductPage(product);
    return send(res, 200, html);
  }

  if (pathname === '/buy' && req.method === 'GET') {
    const product = readJSON(PRODUCT_FILE);
    return send(res, 200, renderBuyPage(product));
  }

  if (pathname === '/submit-payment' && req.method === 'POST') {
    try {
      const { fields, files } = await parseMultipart(req);
      const orders = readJSON(ORDERS_FILE) || [];
      const id = crypto.randomBytes(8).toString('hex');

      let paymentScreenshot = null;
      if (files.screenshot) {
        const ext = path.extname(files.screenshot.filename) || '.jpg';
        const fname = `pay_${id}${ext}`;
        fs.writeFileSync(path.join(UPLOADS, 'payments', fname), files.screenshot.data);
        paymentScreenshot = fname;
      }

      const order = {
        id,
        name: fields.name || 'Customer',
        phone: fields.phone || '',
        utr: fields.utr || '',
        screenshot: paymentScreenshot,
        status: 'pending',
        createdAt: new Date().toISOString(),
        downloadToken: null
      };
      orders.unshift(order);
      writeJSON(ORDERS_FILE, orders);

      return send(res, 200, renderThankYouPage(order));
    } catch (e) {
      return send(res, 500, 'Error submitting payment. Please try again.');
    }
  }

  // Download
  if (pathname.startsWith('/download/')) {
    const token = pathname.split('/download/')[1];
    const orders = readJSON(ORDERS_FILE) || [];
    const order = orders.find(o => o.downloadToken === token && o.status === 'approved');
    if (!order) return send(res, 404, 'Invalid or expired download link.');

    const product = readJSON(PRODUCT_FILE);
    if (!product.apkFile) return send(res, 404, 'App file not available yet.');

    const apkPath = path.join(UPLOADS, 'apk', product.apkFile);
    if (!fs.existsSync(apkPath)) return send(res, 404, 'File not found.');

    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': `attachment; filename="SK-Store.apk"`
    });
    fs.createReadStream(apkPath).pipe(res);
    return;
  }

  // ========== ADMIN ROUTES ==========
  if (pathname === '/admin') {
    const cookie = req.headers.cookie || '';
    if (cookie.includes('skadmin=1')) {
      const product = readJSON(PRODUCT_FILE);
      const orders = readJSON(ORDERS_FILE) || [];
      return send(res, 200, renderAdminPage(product, orders));
    }
    return send(res, 200, renderLoginPage());
  }

  if (pathname === '/admin/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const data = parse(body);
      if (data.password === ADMIN_PASS) {
        res.writeHead(302, {
          'Set-Cookie': 'skadmin=1; Path=/; HttpOnly',
          'Location': '/admin'
        });
        res.end();
      } else {
        send(res, 200, renderLoginPage('Galat password!'));
      }
    });
    return;
  }

  if (pathname === '/admin/logout') {
    res.writeHead(302, {
      'Set-Cookie': 'skadmin=; Path=/; Max-Age=0',
      'Location': '/admin'
    });
    res.end();
    return;
  }

  if (pathname === '/admin/update-product' && req.method === 'POST') {
    const cookie = req.headers.cookie || '';
    if (!cookie.includes('skadmin=1')) return send(res, 403, 'Unauthorized');

    try {
      const { fields, files } = await parseMultipart(req);
      const product = readJSON(PRODUCT_FILE);

      product.title = fields.title || product.title;
      product.price = parseInt(fields.price) || product.price;
      product.description = fields.description || product.description;
      product.upiId = fields.upiId || product.upiId;
      product.bankName = fields.bankName || product.bankName;
      product.accountNumber = fields.accountNumber || product.accountNumber;
      product.ifsc = fields.ifsc || product.ifsc;
      product.accountHolder = fields.accountHolder || product.accountHolder;
      product.whatsapp = fields.whatsapp || product.whatsapp;

      if (files.apk) {
        const fname = 'app_' + Date.now() + path.extname(files.apk.filename);
        fs.writeFileSync(path.join(UPLOADS, 'apk', fname), files.apk.data);
        product.apkFile = fname;
      }

      if (files.screenshot1 || files.screenshot2 || files.screenshot3) {
        const shots = product.screenshots || [];
        ['screenshot1', 'screenshot2', 'screenshot3'].forEach(key => {
          if (files[key]) {
            const fname = 'ss_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + path.extname(files[key].filename);
            fs.writeFileSync(path.join(UPLOADS, 'screenshots', fname), files[key].data);
            shots.push(fname);
          }
        });
        product.screenshots = shots.slice(-6); // keep last 6
      }

      writeJSON(PRODUCT_FILE, product);
      res.writeHead(302, { 'Location': '/admin?msg=updated' });
      res.end();
    } catch (e) {
      send(res, 500, 'Update failed: ' + e.message);
    }
    return;
  }

  if (pathname === '/admin/approve' && req.method === 'POST') {
    const cookie = req.headers.cookie || '';
    if (!cookie.includes('skadmin=1')) return send(res, 403, 'Unauthorized');

    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const data = parse(body);
      const orders = readJSON(ORDERS_FILE) || [];
      const order = orders.find(o => o.id === data.orderId);
      if (order) {
        order.status = 'approved';
        order.downloadToken = crypto.randomBytes(16).toString('hex');
        writeJSON(ORDERS_FILE, orders);
      }
      res.writeHead(302, { 'Location': '/admin' });
      res.end();
    });
    return;
  }

  if (pathname === '/admin/reject' && req.method === 'POST') {
    const cookie = req.headers.cookie || '';
    if (!cookie.includes('skadmin=1')) return send(res, 403, 'Unauthorized');

    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const data = parse(body);
      const orders = readJSON(ORDERS_FILE) || [];
      const order = orders.find(o => o.id === data.orderId);
      if (order) {
        order.status = 'rejected';
        writeJSON(ORDERS_FILE, orders);
      }
      res.writeHead(302, { 'Location': '/admin' });
      res.end();
    });
    return;
  }

  send(res, 404, 'Page not found');
});

// ========== HTML RENDERERS ==========
function renderProductPage(p) {
  const shots = (p.screenshots || []).map(s =>
    `<img src="/uploads/screenshots/${s}" alt="Screenshot" class="shot">`
  ).join('');

  return `<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${p.title} - Official Store</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f5f5f5; color:#222; }
    .container { max-width:480px; margin:0 auto; padding:20px; }
    .card { background:#fff; border-radius:16px; padding:24px; box-shadow:0 4px 20px rgba(0,0,0,0.08); margin-bottom:20px; }
    .logo { text-align:center; font-size:28px; font-weight:800; color:#5D4037; margin-bottom:8px; }
    .price { text-align:center; font-size:32px; font-weight:700; color:#5D4037; margin:12px 0; }
    .price span { font-size:16px; color:#888; }
    .desc { font-size:15px; line-height:1.6; color:#444; margin:16px 0; }
    .shots { display:flex; gap:10px; overflow-x:auto; padding:10px 0; }
    .shot { height:180px; border-radius:12px; object-fit:cover; }
    .buy-btn {
      display:block; width:100%; padding:16px; background:#8B4513; color:#fff;
      text-align:center; font-size:18px; font-weight:700; border:none; border-radius:12px;
      text-decoration:none; cursor:pointer; transition:0.2s;
    }
    .buy-btn:hover { background:#6D3410; }
    .footer { text-align:center; font-size:12px; color:#999; margin-top:30px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">📱 ${p.title}</div>
      <div class="price">₹${p.price} <span>only</span></div>
      <p class="desc">${p.description}</p>
      ${shots ? `<div class="shots">${shots}</div>` : ''}
      <a href="/buy" class="buy-btn">Buy Now</a>
    </div>
    <div class="footer">© SK Store • Secure Digital Delivery</div>
  </div>
</body>
</html>`;
}

function renderBuyPage(p) {
  return `<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Buy ${p.title}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f5f5f5; color:#222; }
    .container { max-width:480px; margin:0 auto; padding:20px; }
    .card { background:#fff; border-radius:16px; padding:24px; box-shadow:0 4px 20px rgba(0,0,0,0.08); margin-bottom:16px; }
    h2 { color:#5D4037; margin-bottom:12px; font-size:20px; }
    .pay-box { background:#FFF8E1; border:2px dashed #8B4513; border-radius:12px; padding:16px; margin:16px 0; text-align:center; }
    .upi { font-size:18px; font-weight:700; color:#5D4037; word-break:break-all; }
    .bank { font-size:14px; line-height:1.7; margin-top:12px; text-align:left; }
    label { display:block; margin:12px 0 4px; font-weight:600; font-size:14px; }
    input, textarea { width:100%; padding:12px; border:1px solid #ddd; border-radius:8px; font-size:15px; }
    .submit-btn {
      display:block; width:100%; padding:16px; background:#8B4513; color:#fff;
      text-align:center; font-size:17px; font-weight:700; border:none; border-radius:12px;
      margin-top:20px; cursor:pointer;
    }
    .note { font-size:13px; color:#666; margin-top:12px; line-height:1.5; }
    a.back { color:#8B4513; text-decoration:none; font-size:14px; }
  </style>
</head>
<body>
  <div class="container">
    <a href="/" class="back">← Back</a>
    <div class="card">
      <h2>Pay ₹${p.price} for ${p.title}</h2>
      
      <div class="pay-box">
        <p style="margin-bottom:8px;font-weight:600;">UPI se Payment karein:</p>
        <div class="upi">${p.upiId}</div>
        <div class="bank">
          <strong>Bank Transfer:</strong><br>
          Account Holder: ${p.accountHolder}<br>
          Account No: ${p.accountNumber}<br>
          IFSC: ${p.ifsc}<br>
          Bank: ${p.bankName}
        </div>
      </div>

      <p class="note">Payment ke baad neeche form fill karke Submit karein. Hum check karke aapko download link bhej denge.</p>

      <form action="/submit-payment" method="POST" enctype="multipart/form-data">
        <label>Aapka Naam *</label>
        <input type="text" name="name" required placeholder="Full Name">

        <label>Mobile Number *</label>
        <input type="tel" name="phone" required placeholder="10 digit number">

        <label>UTR / Transaction ID *</label>
        <input type="text" name="utr" required placeholder="UPI Transaction ID">

        <label>Payment Screenshot *</label>
        <input type="file" name="screenshot" accept="image/*" required>

        <button type="submit" class="submit-btn">Submit Payment Proof</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

function renderThankYouPage(order) {
  return `<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thank You</title>
  <style>
    body { font-family: sans-serif; background:#f5f5f5; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
    .box { background:#fff; padding:40px 30px; border-radius:16px; text-align:center; max-width:400px; box-shadow:0 4px 20px rgba(0,0,0,0.1); }
    h1 { color:#5D4037; margin-bottom:12px; }
    p { color:#555; line-height:1.6; }
    .id { background:#f0f0f0; padding:8px 12px; border-radius:8px; font-family:monospace; margin:16px 0; }
  </style>
</head>
<body>
  <div class="box">
    <h1>✅ Thank You!</h1>
    <p>Aapka payment proof receive ho gaya hai.</p>
    <div class="id">Order ID: ${order.id}</div>
    <p>Hum jaldi check karke aapko download link WhatsApp / yahan bhej denge.</p>
    <p style="margin-top:20px;font-size:13px;color:#888;">Please wait for approval (usually few minutes to 1 hour).</p>
  </div>
</body>
</html>`;
}

function renderLoginPage(error = '') {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login - SK Store</title>
  <style>
    body { font-family:sans-serif; background:#f5f5f5; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
    .box { background:#fff; padding:32px; border-radius:16px; width:320px; box-shadow:0 4px 20px rgba(0,0,0,0.1); }
    h2 { color:#5D4037; margin-bottom:20px; text-align:center; }
    input { width:100%; padding:12px; border:1px solid #ddd; border-radius:8px; margin-bottom:16px; font-size:15px; }
    button { width:100%; padding:14px; background:#8B4513; color:#fff; border:none; border-radius:8px; font-size:16px; font-weight:700; cursor:pointer; }
    .err { color:red; text-align:center; margin-bottom:12px; font-size:14px; }
  </style>
</head>
<body>
  <div class="box">
    <h2>SK Store Admin</h2>
    ${error ? `<div class="err">${error}</div>` : ''}
    <form method="POST" action="/admin/login">
      <input type="password" name="password" placeholder="Admin Password" required>
      <button type="submit">Login</button>
    </form>
  </div>
</body>
</html>`;
}

function renderAdminPage(p, orders) {
  const pending = orders.filter(o => o.status === 'pending');
  const approved = orders.filter(o => o.status === 'approved');

  const orderRows = orders.slice(0, 20).map(o => `
    <tr style="border-bottom:1px solid #eee;">
      <td style="padding:10px;font-size:13px;">${o.id.slice(0,8)}...</td>
      <td style="padding:10px;">${o.name}<br><small>${o.phone}</small></td>
      <td style="padding:10px;font-size:13px;">${o.utr}</td>
      <td style="padding:10px;">
        <span style="padding:3px 8px;border-radius:4px;font-size:12px;background:${o.status==='pending'?'#FFF3E0':o.status==='approved'?'#E8F5E9':'#FFEBEE'};">
          ${o.status}
        </span>
      </td>
      <td style="padding:10px;">
        ${o.status === 'pending' ? `
          <form method="POST" action="/admin/approve" style="display:inline;">
            <input type="hidden" name="orderId" value="${o.id}">
            <button style="background:#2E7D32;color:#fff;border:none;padding:6px 10px;border-radius:4px;cursor:pointer;">Approve</button>
          </form>
          <form method="POST" action="/admin/reject" style="display:inline;margin-left:4px;">
            <input type="hidden" name="orderId" value="${o.id}">
            <button style="background:#C62828;color:#fff;border:none;padding:6px 10px;border-radius:4px;cursor:pointer;">Reject</button>
          </form>
        ` : o.status === 'approved' ? `
          <a href="/download/${o.downloadToken}" target="_blank" style="color:#1565C0;font-size:13px;">Download Link</a>
        ` : '-'}
      </td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin - SK Store</title>
  <style>
    * { box-sizing:border-box; }
    body { font-family:sans-serif; background:#f0f0f0; margin:0; padding:20px; }
    .wrap { max-width:900px; margin:0 auto; }
    h1 { color:#5D4037; }
    .card { background:#fff; border-radius:12px; padding:20px; margin-bottom:20px; box-shadow:0 2px 10px rgba(0,0,0,0.06); }
    label { display:block; margin:10px 0 4px; font-weight:600; font-size:14px; }
    input, textarea { width:100%; padding:10px; border:1px solid #ddd; border-radius:6px; font-size:14px; }
    button.save { background:#8B4513; color:#fff; border:none; padding:12px 24px; border-radius:8px; font-weight:700; cursor:pointer; margin-top:16px; }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th { text-align:left; padding:10px; background:#fafafa; }
    .top { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
    a.logout { color:#C62828; text-decoration:none; font-size:14px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <h1>SK Store Admin</h1>
      <a href="/admin/logout" class="logout">Logout</a>
    </div>

    <div class="card">
      <h3>Product Settings</h3>
      <form method="POST" action="/admin/update-product" enctype="multipart/form-data">
        <label>App Title</label>
        <input name="title" value="${p.title}">

        <label>Price (₹)</label>
        <input name="price" type="number" value="${p.price}">

        <label>Description</label>
        <textarea name="description" rows="3">${p.description}</textarea>

        <label>UPI ID</label>
        <input name="upiId" value="${p.upiId}" placeholder="9876543210@paytm">

        <label>Account Holder Name</label>
        <input name="accountHolder" value="${p.accountHolder}">

        <label>Bank Account Number</label>
        <input name="accountNumber" value="${p.accountNumber}">

        <label>IFSC Code</label>
        <input name="ifsc" value="${p.ifsc}">

        <label>Bank Name</label>
        <input name="bankName" value="${p.bankName}">

        <label>WhatsApp Number (with country code)</label>
        <input name="whatsapp" value="${p.whatsapp}" placeholder="919876543210">

        <label>Upload APK File</label>
        <input type="file" name="apk" accept=".apk">

        <label>Add Screenshots (upto 3 at a time)</label>
        <input type="file" name="screenshot1" accept="image/*">
        <input type="file" name="screenshot2" accept="image/*" style="margin-top:6px;">
        <input type="file" name="screenshot3" accept="image/*" style="margin-top:6px;">

        <button type="submit" class="save">Save Changes</button>
      </form>
      <p style="margin-top:12px;font-size:13px;color:#666;">
        Current APK: ${p.apkFile || 'Not uploaded yet'}<br>
        Screenshots: ${(p.screenshots||[]).length}
      </p>
    </div>

    <div class="card">
      <h3>Orders (${pending.length} pending)</h3>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Customer</th>
            <th>UTR</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${orderRows || '<tr><td colspan="5" style="padding:20px;text-align:center;color:#999;">No orders yet</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

server.listen(PORT, () => {
  console.log(`SK Store running at http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
  console.log(`Default admin password: skstore2026`);
});
