/**
 * Baileys WhatsApp Bridge
 * Jalankan ini 24/7 di server (Render/Fly.io/VPS), BUKAN di Supabase Edge Function.
 * Tugasnya cuma: terima pesan WA -> teruskan ke Edge Function -> kirim balik balasannya.
 *
 * Setup:
 *   npm install @whiskeysockets/baileys @hapi/boom qrcode pino dotenv
 *   node index.js
 * Buka https://<url-render-kamu>/qr di browser untuk scan QR code.
 */

require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const pino = require('pino');
const http = require('http');

const EDGE_FUNCTION_URL = process.env.EDGE_FUNCTION_URL; // contoh: https://xxxx.supabase.co/functions/v1/process-message
const EDGE_FUNCTION_SECRET = process.env.EDGE_FUNCTION_SECRET; // token internal, biar endpoint ga bisa dipanggil sembarang orang
const PORT = process.env.PORT || 3000;

let latestQrDataUrl = null; // simpan QR code terbaru sebagai gambar, buat ditampilkan di /qr
let connectionStatus = 'starting'; // starting | waiting_for_scan | connected | disconnected

// Server HTTP kecil: (1) health check biar Render tidak mematikan service, (2) tampilkan QR code
http
  .createServer((req, res) => {
    if (req.url === '/qr') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (latestQrDataUrl) {
        res.end(`<body style="text-align:center;font-family:sans-serif">
          <h3>Scan QR ini dengan WhatsApp</h3>
          <img src="${latestQrDataUrl}" />
          <p>Status: ${connectionStatus}</p>
        </body>`);
      } else {
        res.end(`<body style="font-family:sans-serif"><p>Status: ${connectionStatus}. Belum ada QR (mungkin sudah terhubung, atau masih loading).</p></body>`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`Bot status: ${connectionStatus}`);
    }
  })
  .listen(PORT, () => console.log(`Health check + QR server jalan di port ${PORT}`));

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_session');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }), // ganti 'info' kalau mau debug koneksi
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'waiting_for_scan';
      latestQrDataUrl = await QRCode.toDataURL(qr);
      console.log(`QR siap, buka https://<url-service-kamu>/qr untuk scan`);
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus, reconnect:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      latestQrDataUrl = null; // sudah connect, QR tidak relevan lagi
      console.log('✅ Bot terhubung ke WhatsApp');
    }
  });

  // Handler utama: setiap pesan masuk
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return; // abaikan pesan dari bot sendiri

    const senderJid = msg.key.remoteJid; // format: 628xxxxxxxxxx@s.whatsapp.net
    const phoneNumber = senderJid.split('@')[0];

    // Ambil teks pesan (belum handle foto/voice note di versi ini)
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      null;

    if (!text) {
      await sock.sendMessage(senderJid, {
        text: 'Maaf, saat ini aku baru bisa baca teks. Coba ketik transaksinya ya, misal: "makan siang 25rb"',
      });
      return;
    }

    console.log(`📩 Pesan dari ${phoneNumber}: ${text}`);

    try {
      const reply = await forwardToEdgeFunction(phoneNumber, text);
      await sock.sendMessage(senderJid, { text: reply });
    } catch (err) {
      console.error('Error forward ke Edge Function:', err);
      await sock.sendMessage(senderJid, {
        text: 'Waduh, ada gangguan di sistem. Coba lagi sebentar ya.',
      });
    }
  });
}

async function forwardToEdgeFunction(phoneNumber, message) {
  const res = await fetch(EDGE_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': EDGE_FUNCTION_SECRET,
    },
    body: JSON.stringify({ phone_number: phoneNumber, message }),
  });

  if (!res.ok) {
    throw new Error(`Edge Function error: ${res.status}`);
  }

  const data = await res.json();
  return data.reply_text; // Edge Function yang menentukan teks balasannya
}

startBot();
