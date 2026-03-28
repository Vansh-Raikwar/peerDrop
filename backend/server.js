const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000
});

const PORT = process.env.PORT || 5000;

// ─── Serve built frontend (cross-network mode) ─────────────────────────────
const FRONTEND_DIST = path.join(__dirname, '../frontend/dist');
app.use(express.static(FRONTEND_DIST));

// ─── Peer storage ──────────────────────────────────────────────────────────
const peers = new Map();

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return 'localhost';
}
const localIp = getLocalIp();

// ─── REST endpoints ────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', peers: peers.size, localIp, port: PORT });
});

// Config endpoint — frontend fetches this to know the public URL
app.get('/api/config', (req, res) => {
    const publicUrl = process.env.PUBLIC_URL || `http://${localIp}:${PORT}`;
    res.json({ publicUrl, localIp, port: PORT });
});

// SPA fallback — serve index.html for all non-API, non-socket routes
app.get('*', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
});

// ─── Stale peer cleanup ────────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, peer] of peers.entries()) {
        if (now - peer.lastSeen > 90000) {
            peers.delete(id);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[Cleanup] Removed ${cleaned} stale peer(s)`);
        io.emit('peers-update', Array.from(peers.values()));
    }
}, 30000);

// ─── Socket.io ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[+] Connected: ${socket.id}`);

    // Send server config so the client knows the public URL for QR codes
    const publicUrl = process.env.PUBLIC_URL || `http://${localIp}:${PORT}`;
    socket.emit('server-info', { localIp, port: PORT, publicUrl });

    socket.on('join', (data) => {
        const peerInfo = {
            socketId: socket.id,
            deviceId: data.deviceId || uuidv4(),
            name: data.name || `Device-${socket.id.substring(0, 4)}`,
            type: data.type || 'desktop',
            online: true,
            lastSeen: Date.now()
        };
        peers.set(socket.id, peerInfo);
        io.emit('peers-update', Array.from(peers.values()));
        console.log(`[*] Joined: ${peerInfo.name}`);
    });

    socket.on('update-name', ({ name }) => {
        const peer = peers.get(socket.id);
        if (peer) {
            peer.name = name;
            peer.lastSeen = Date.now();
            peers.set(socket.id, peer);
            io.emit('peers-update', Array.from(peers.values()));
        }
    });

    socket.on('heartbeat', () => {
        const peer = peers.get(socket.id);
        if (peer) { peer.lastSeen = Date.now(); peers.set(socket.id, peer); }
    });

    // ── WebRTC Signaling relay ─────────────────────────────────────────────
    socket.on('signal-offer',    (d) => io.to(d.to).emit('signal-offer',    { ...d, from: socket.id }));
    socket.on('signal-answer',   (d) => io.to(d.to).emit('signal-answer',   { ...d, from: socket.id }));
    socket.on('ice-candidate',   (d) => io.to(d.to).emit('ice-candidate',   { ...d, from: socket.id }));

    // ── Transfer handshake relay ────────────────────────────────────────────
    socket.on('request-connection', (d) => io.to(d.to).emit('connection-request',  { ...d, from: socket.id }));
    socket.on('respond-connection', (d) => io.to(d.to).emit('connection-response', { ...d, from: socket.id }));

    // ── Resume relay ────────────────────────────────────────────────────────
    socket.on('resume-request',  (d) => io.to(d.to).emit('resume-request',  { ...d, from: socket.id }));
    socket.on('resume-response', (d) => io.to(d.to).emit('resume-response', { ...d, from: socket.id }));

    socket.on('disconnect', (reason) => {
        console.log(`[-] Disconnected: ${socket.id} (${reason})`);
        peers.delete(socket.id);
        io.emit('peers-update', Array.from(peers.values()));
    });
});

server.listen(PORT, '0.0.0.0', () => {
    const publicUrl = process.env.PUBLIC_URL || `http://${localIp}:${PORT}`;
    console.log(`\n✅  PeerDrop is running`);
    console.log(`    Local:   http://localhost:${PORT}`);
    console.log(`    Network: http://${localIp}:${PORT}`);
    if (process.env.PUBLIC_URL) {
        console.log(`    Public:  ${publicUrl}  ← share this link`);
    } else {
        console.log(`\n    ℹ️  Cross-network: run  npx ngrok http ${PORT}`);
        console.log(`       Then set PUBLIC_URL=<ngrok-url> in backend/.env\n`);
    }
});
