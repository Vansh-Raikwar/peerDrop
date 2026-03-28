import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSocket } from './hooks/useSocket';
import WebRTCManager from './utils/WebRTCManager';
import {
    Monitor, Laptop, Smartphone, Tablet, HardDrive,
    Share2, Shield, Download, Upload, Check, X,
    AlertCircle, Sun, Moon, Clock, History, Link, Copy,
    Pause, Play, RefreshCw, Eye, FileText, Music, Video,
    Image, Archive, File, Wifi, WifiOff, Edit2, QrCode,
    Trash2, ChevronRight, Info, Zap
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { generateECDHKeyPair, exportPublicKey, importPublicKey, deriveAESKey } from './utils/crypto';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getFileEmoji(type = '', name = '') {
    if (type.startsWith('image/')) return '🖼️';
    if (type.startsWith('video/')) return '🎬';
    if (type.startsWith('audio/')) return '🎵';
    if (type === 'application/pdf') return '📄';
    if (type.includes('zip') || type.includes('compressed') || name.endsWith('.zip')) return '🗜️';
    if (type.includes('text') || name.match(/\.(md|txt|log|csv|json|xml|html|css|js|ts|py|java|go)$/)) return '📝';
    return '📁';
}

function getFileIconClass(type = '') {
    if (type.startsWith('image/')) return 'file-icon-img';
    if (type.startsWith('video/')) return 'file-icon-vid';
    if (type.startsWith('audio/')) return 'file-icon-aud';
    if (type.includes('text') || type.includes('json') || type.includes('xml')) return 'file-icon-doc';
    if (type.includes('zip') || type.includes('compressed')) return 'file-icon-zip';
    return 'file-icon-generic';
}

function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`;
}

function getDeviceIcon(type) {
    if (type === 'mobile') return <Smartphone size={18} />;
    if (type === 'tablet') return <Tablet size={18} />;
    return <Laptop size={18} />;
}

function getStatusLabel(transfer) {
    if (transfer.status === 'completed') return 'completed';
    if (transfer.paused) return 'paused';
    return transfer.status || 'pending';
}

function isPreviewable(type = '') {
    return type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/') ||
        type === 'application/pdf' || type.includes('text') || type.includes('json');
}

function genTransferId() {
    return Math.random().toString(36).substr(2, 12);
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
    const { socket, peers, deviceName, updateDeviceName, connected } = useSocket();

    // UI state
    const [theme, setTheme] = useState(() => localStorage.getItem('peerdrop_theme') || 'dark');
    const [publicUrl, setPublicUrl] = useState(`${window.location.protocol}//${window.location.host}`);
    const [showHistory, setShowHistory] = useState(false);
    const [showQR, setShowQR] = useState(false);
    const [showPreview, setShowPreview] = useState(null); // { url, metadata }
    const [editingName, setEditingName] = useState(false);
    const [nameInput, setNameInput] = useState(deviceName);
    const [dragOver, setDragOver] = useState(false);

    // Transfer state
    const [selectedPeer, setSelectedPeer] = useState(null);
    const [incomingRequest, setIncomingRequest] = useState(null);
    const [transfers, setTransfers] = useState([]);
    const [historyLogs, setHistoryLogs] = useState([]);

    // Refs for RTC
    const fileInputRef = useRef(null);
    const rtcManagers = useRef(new Map());
    const ecdhPrivateKeys = useRef(new Map());
    const aesKeys = useRef(new Map());
    const pendingFiles = useRef(new Map()); // peerId → [{ file, transferId }]

    // ─── Theme ──────────────────────────────────────────────────────────────

    useEffect(() => {
        document.documentElement.className = theme;
    }, [theme]);

    const toggleTheme = () => {
        const next = theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        localStorage.setItem('peerdrop_theme', next);
    };

    // ─── Init ────────────────────────────────────────────────────────────────

    useEffect(() => {
        const history = JSON.parse(localStorage.getItem('peerdrop_history') || '[]');
        setHistoryLogs(history);
    }, []);

    // ─── Socket events ───────────────────────────────────────────────────────

    useEffect(() => {
        if (!socket) return;

        socket.on('server-info', ({ localIp, port, publicUrl: serverPublicUrl }) => {
            if (serverPublicUrl) {
                // Server told us the canonical public URL (e.g. ngrok)
                setPublicUrl(serverPublicUrl);
            } else if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                // Fallback: use LAN IP + current port
                const proto = window.location.protocol;
                const p = window.location.port || (proto === 'https:' ? '443' : '80');
                setPublicUrl(`${proto}//${localIp}:${p}`);
            }
            // else: we're already on the public URL (deployed), keep window.location.host
        });

        socket.on('connection-request', ({ from, metadata }) => {
            const peer = peers.find(p => p.socketId === from);
            setIncomingRequest({ from, metadata, peerName: peer?.name || 'Unknown Device' });
        });

        socket.on('connection-response', async ({ accepted, from, publicKey }) => {
            if (!accepted) {
                toast.error('Connection rejected by peer.');
                updateTransferStatus(from, 'error');
                return;
            }

            // ECDH key derivation
            const myPrivateKey = ecdhPrivateKeys.current.get(from);
            if (myPrivateKey && publicKey) {
                const peerPubKey = await importPublicKey(publicKey);
                const sharedKey = await deriveAESKey(myPrivateKey, peerPubKey);
                aesKeys.current.set(from, sharedKey);
            }

            // Create/get manager and connect
            const manager = getOrCreateManager(from);
            
            // Now enqueue all pending files for this peer
            const pending = pendingFiles.current.get(from) || [];
            pendingFiles.current.delete(from);
            for (const { file, transferId } of pending) {
                manager.prepareFile(file, transferId);
            }

            updateTransferMeta(from, 'status', 'connecting');
            await manager.initConnection(true);
            toast.success('Peer accepted! Establishing connection…');
        });

        socket.on('signal-offer', async ({ offer, from }) => {
            const manager = getOrCreateManager(from);
            await manager.initConnection(false);
            await manager.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await manager.peerConnection.createAnswer();
            await manager.peerConnection.setLocalDescription(answer);
            socket.emit('signal-answer', { to: from, answer, from: socket.id });
        });

        socket.on('signal-answer', async ({ answer, from }) => {
            const manager = rtcManagers.current.get(from);
            if (manager?.peerConnection) {
                await manager.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            }
        });

        socket.on('ice-candidate', async ({ candidate, from }) => {
            const manager = rtcManagers.current.get(from);
            if (manager?.peerConnection) {
                try {
                    await manager.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (e) {
                    console.error('[ICE] Failed to add candidate', e);
                }
            }
        });

        socket.on('resume-request', ({ from, transferId }) => {
            const transfer = transfers.find(t => t.id === transferId);
            const manager = rtcManagers.current.get(from);
            const offset = manager?.getReceivedBytes() || 0;

            if (transfer) {
                socket.emit('resume-response', { to: from, from: socket.id, accepted: true, transferId, offset });
            } else {
                socket.emit('resume-response', { to: from, from: socket.id, accepted: false });
            }
        });

        socket.on('resume-response', async ({ accepted, from, offset }) => {
            if (!accepted) {
                toast.error('Peer rejected resume. Transfer expired.');
                updateTransferMeta(from, 'status', 'error');
                return;
            }

            const manager = rtcManagers.current.get(from);
            if (!manager) return;

            manager.offset = offset;
            manager.bytesTransferred = offset;
            manager.paused = false;
            updateTransferMeta(from, 'status', 'connecting');
            await manager.initConnection(true);
        });

        return () => {
            socket.off('server-info');
            socket.off('connection-request');
            socket.off('connection-response');
            socket.off('signal-offer');
            socket.off('signal-answer');
            socket.off('ice-candidate');
            socket.off('resume-request');
            socket.off('resume-response');
        };
    }, [socket, peers, transfers]);

    // Auto-select peer from share link
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const peerQuery = params.get('peer');
        if (peerQuery && peers.length > 0) {
            const target = peers.find(p => p.socketId === peerQuery);
            if (target) {
                setSelectedPeer(target);
                toast.info(`Auto-selected: ${target.name}`, { toastId: 'auto-select' });
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        }
    }, [peers]);

    // ─── RTC Manager factory ─────────────────────────────────────────────────

    const getOrCreateManager = useCallback((peerId) => {
        if (rtcManagers.current.has(peerId)) {
            return rtcManagers.current.get(peerId);
        }

        const manager = new WebRTCManager(socket, peerId, {
            getEncryptionKey: () => aesKeys.current.get(peerId),

            onProgress: (progress) => {
                setTransfers(prev => prev.map(t =>
                    t.peerId === peerId && t.status !== 'completed'
                        ? { ...t, progress }
                        : t
                ));
            },

            onFileStart: (metadata) => {
                // Update existing receiving transfer OR add new one
                setTransfers(prev => {
                    const existing = prev.find(t => t.peerId === peerId && t.id === metadata.transferId);
                    if (existing) {
                        return prev.map(t => t.id === metadata.transferId
                            ? { ...t, status: 'receiving', fileName: metadata.name, fileSize: metadata.size, fileType: metadata.type }
                            : t
                        );
                    }
                    return [...prev, {
                        id: metadata.transferId || genTransferId(),
                        peerId,
                        peerName: peers.find(p => p.socketId === peerId)?.name || 'Unknown',
                        fileName: metadata.name,
                        fileSize: metadata.size,
                        fileType: metadata.type,
                        progress: 0,
                        status: 'receiving',
                        direction: 'receiving',
                        paused: false
                    }];
                });
            },

            onComplete: (result) => {
                if (result && result.url) {
                    // Received a file
                    const transferId = result.transferId || result.metadata?.transferId;
                    setTransfers(prev => prev.map(t =>
                        (t.id === transferId || (t.peerId === peerId && t.status === 'receiving'))
                            ? { ...t, status: 'completed', progress: 100, receivedFile: result }
                            : t
                    ));
                    toast.success(`📥 ${result.metadata.name} received!`);
                    _addToHistory({
                        fileName: result.metadata.name,
                        fileSize: result.metadata.size,
                        fileType: result.metadata.type,
                        peerId,
                        peerName: peers.find(p => p.socketId === peerId)?.name || 'Unknown',
                        type: 'received'
                    });
                } else {
                    // Sent a file — transferId is the direct string
                    setTransfers(prev => prev.map(t =>
                        t.id === result
                            ? { ...t, status: 'completed', progress: 100 }
                            : t
                    ));
                    const t = transfers.find(tx => tx.id === result);
                    if (t) {
                        toast.success(`📤 ${t.fileName} sent!`);
                        _addToHistory({
                            fileName: t.fileName,
                            fileSize: t.fileSize,
                            fileType: t.fileType,
                            peerId,
                            peerName: t.peerName,
                            type: 'sent'
                        });
                    }
                }
            },

            onStatus: (status) => {
                setTransfers(prev => prev.map(t =>
                    t.peerId === peerId && t.status !== 'completed'
                        ? { ...t, status }
                        : t
                ));
            },

            onSpeed: ({ speed, eta }) => {
                setTransfers(prev => prev.map(t =>
                    t.peerId === peerId && t.status !== 'completed'
                        ? { ...t, speed, eta }
                        : t
                ));
            }
        });

        rtcManagers.current.set(peerId, manager);
        return manager;
    }, [socket, peers]);

    // ─── Transfer helpers ─────────────────────────────────────────────────────

    const updateTransferMeta = (peerId, key, value) => {
        setTransfers(prev => prev.map(t =>
            t.peerId === peerId && t.status !== 'completed'
                ? { ...t, [key]: value }
                : t
        ));
    };

    const updateTransferStatus = (peerId, status) => updateTransferMeta(peerId, 'status', status);

    const _addToHistory = (entry) => {
        setHistoryLogs(prev => {
            const log = {
                id: genTransferId(),
                timestamp: new Date().toISOString(),
                ...entry
            };
            const updated = [log, ...prev].slice(0, 100);
            localStorage.setItem('peerdrop_history', JSON.stringify(updated));
            return updated;
        });
    };

    // ─── Request connection (sender initiates) ────────────────────────────────

    const requestConnectionForFiles = async (files, peer) => {
        if (!peer) { toast.warning('Select a device first!'); return; }

        // ECDH key gen
        const myKeyPair = await generateECDHKeyPair();
        const myPubKey = await exportPublicKey(myKeyPair.publicKey);
        ecdhPrivateKeys.current.set(peer.socketId, myKeyPair.privateKey);

        // Create a transfer entry per file
        const fileEntries = Array.from(files).map(file => ({
            file,
            transferId: genTransferId()
        }));

        pendingFiles.current.set(peer.socketId, fileEntries);

        // Add to transfer list
        const newTransfers = fileEntries.map(({ file, transferId }) => ({
            id: transferId,
            peerId: peer.socketId,
            peerName: peer.name,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            progress: 0,
            status: 'pending',
            direction: 'sending',
            paused: false,
            file
        }));

        setTransfers(prev => [...prev, ...newTransfers]);

        // Send only one connection-request per peer with the first file's metadata
        socket.emit('request-connection', {
            to: peer.socketId,
            from: socket.id,
            metadata: {
                fileName: fileEntries.map(e => e.file.name).join(', '),
                fileSize: fileEntries.reduce((a, e) => a + e.file.size, 0),
                fileCount: fileEntries.length,
                publicKey: myPubKey
            }
        });

        // Update all pending to "awaiting"
        setTransfers(prev => prev.map(t =>
            fileEntries.find(e => e.transferId === t.id)
                ? { ...t, status: 'awaiting' }
                : t
        ));
    };

    // ─── Respond to incoming request ──────────────────────────────────────────

    const respondToRequest = async (accepted) => {
        const req = incomingRequest;
        setIncomingRequest(null);

        if (!accepted) {
            socket.emit('respond-connection', { to: req.from, accepted: false, from: socket.id });
            return;
        }

        // ECDH
        const myKeyPair = await generateECDHKeyPair();
        const myPubKey = await exportPublicKey(myKeyPair.publicKey);
        const peerPubKey = await importPublicKey(req.metadata.publicKey);
        const sharedKey = await deriveAESKey(myKeyPair.privateKey, peerPubKey);
        aesKeys.current.set(req.from, sharedKey);

        socket.emit('respond-connection', {
            to: req.from,
            accepted: true,
            from: socket.id,
            publicKey: myPubKey
        });

        // Pre-create manager for receiving
        getOrCreateManager(req.from);
    };

    // ─── Pause / Resume / Cancel ──────────────────────────────────────────────

    const togglePause = (transfer) => {
        const manager = rtcManagers.current.get(transfer.peerId);
        if (!manager) return;

        if (transfer.paused) {
            manager.resume();
            setTransfers(prev => prev.map(t => t.id === transfer.id ? { ...t, paused: false } : t));
        } else {
            manager.pause();
            setTransfers(prev => prev.map(t => t.id === transfer.id ? { ...t, paused: true } : t));
        }
    };

    const cancelTransfer = (transfer) => {
        const manager = rtcManagers.current.get(transfer.peerId);
        if (manager) manager.cancel();
        setTransfers(prev => prev.filter(t => t.id !== transfer.id));
    };

    const retryTransfer = (transfer) => {
        socket.emit('resume-request', {
            to: transfer.peerId,
            from: socket.id,
            transferId: transfer.id
        });
        updateTransferMeta(transfer.peerId, 'status', 'connecting');
    };

    const removeTransfer = (id) => {
        setTransfers(prev => prev.filter(t => t.id !== id));
    };

    // ─── File Drop / Select ───────────────────────────────────────────────────

    const handleDrop = async (e) => {
        e.preventDefault();
        setDragOver(false);

        if (!selectedPeer) { toast.warning('Select a device first!'); return; }

        const items = e.dataTransfer.items;
        const files = e.dataTransfer.files;

        if (items && items.length > 0) {
            const firstEntry = items[0]?.webkitGetAsEntry?.();
            if (firstEntry?.isDirectory) {
                toast.info('Zipping folder…');
                try {
                    const JSZip = (await import('jszip')).default;
                    const zip = new JSZip();

                    const addEntry = async (entry, path = '') => {
                        if (entry.isFile) {
                            const f = await new Promise(res => entry.file(res));
                            zip.file(path + f.name, f);
                        } else if (entry.isDirectory) {
                            const reader = entry.createReader();
                            const entries = await new Promise(res => reader.readEntries(res));
                            for (const child of entries) {
                                await addEntry(child, path + entry.name + '/');
                            }
                        }
                    };

                    await addEntry(firstEntry);
                    const blob = await zip.generateAsync({ type: 'blob' });
                    const zipFile = new File([blob], `${firstEntry.name}.zip`, { type: 'application/zip' });
                    await requestConnectionForFiles([zipFile], selectedPeer);
                } catch (err) {
                    toast.error('Failed to zip folder: ' + err.message);
                }
                return;
            }
        }

        if (files.length > 0) {
            await requestConnectionForFiles(files, selectedPeer);
        }
    };

    const handleFileSelect = async (e) => {
        const files = e.target.files;
        if (!selectedPeer) { toast.warning('Select a device first!'); return; }
        if (files.length > 0) {
            await requestConnectionForFiles(files, selectedPeer);
        }
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    // ─── Download completed file ──────────────────────────────────────────────

    const downloadFile = (receivedFile) => {
        const a = document.createElement('a');
        a.href = receivedFile.url;
        a.download = receivedFile.metadata.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    // ─── Share URL ────────────────────────────────────────────────────────────

    const shareUrl = `${publicUrl}/?peer=${socket?.id}`;

    const copyShareLink = () => {
        navigator.clipboard.writeText(shareUrl).then(() => {
            toast.success('Share link copied!');
        });
    };

    // ─── Device name edit ─────────────────────────────────────────────────────

    const submitNameEdit = () => {
        if (nameInput.trim()) {
            updateDeviceName(nameInput.trim());
            toast.success(`Device renamed to "${nameInput.trim()}"`);
        }
        setEditingName(false);
    };

    // ─── Clear history ────────────────────────────────────────────────────────

    const clearHistory = () => {
        localStorage.removeItem('peerdrop_history');
        setHistoryLogs([]);
        toast.info('History cleared.');
    };

    // ─── Render helpers ───────────────────────────────────────────────────────

    const getTransferColorClass = (t) => {
        if (t.status === 'completed') return 'completed';
        if (t.paused) return 'paused';
        if (t.status === 'receiving') return 'receiving';
        if (t.status === 'error' || t.status === 'disconnected') return 'error';
        return '';
    };

    const activeTransfers = transfers.filter(t => t.status !== 'completed');
    const completedTransfers = transfers.filter(t => t.status === 'completed');

    // ─── JSX ─────────────────────────────────────────────────────────────────

    return (
        <div className="app-container fade-in">

            {/* ── Header ─────────────────────────────────────────────────── */}
            <header className="header">
                <div className="logo">
                    <span className="logo-icon">🔗</span>
                    PeerDrop
                </div>

                <div className="header-actions">
                    {/* Device name badge */}
                    <div
                        className="device-badge"
                        onClick={() => { setEditingName(true); setNameInput(deviceName); }}
                        title="Click to rename your device"
                    >
                        <span className={`badge-dot ${connected ? '' : 'offline'}`} />
                        {editingName ? (
                            <div className="name-edit-container" onClick={e => e.stopPropagation()}>
                                <input
                                    className="name-input"
                                    value={nameInput}
                                    onChange={e => setNameInput(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') submitNameEdit(); if (e.key === 'Escape') setEditingName(false); }}
                                    autoFocus
                                    maxLength={24}
                                />
                                <button
                                    className="icon-btn"
                                    style={{ width: 28, height: 28 }}
                                    onClick={submitNameEdit}
                                    title="Save"
                                >
                                    <Check size={14} />
                                </button>
                                <button
                                    className="icon-btn"
                                    style={{ width: 28, height: 28 }}
                                    onClick={() => setEditingName(false)}
                                    title="Cancel"
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        ) : (
                            <>
                                <Laptop size={13} />
                                <span>{deviceName}</span>
                                <Edit2 size={11} style={{ opacity: 0.5 }} />
                            </>
                        )}
                    </div>

                    {/* Encryption badge */}
                    <div className="encryption-badge" title="All transfers are end-to-end encrypted with AES-256-GCM">
                        <Shield size={11} /> E2E Encrypted
                    </div>

                    {/* History */}
                    <button
                        className="icon-btn"
                        onClick={() => setShowHistory(true)}
                        title="Transfer History"
                    >
                        <History size={17} />
                    </button>

                    {/* QR Code */}
                    <button
                        className="icon-btn"
                        onClick={() => setShowQR(true)}
                        title="Share Link / QR Code"
                    >
                        <QrCode size={17} />
                    </button>

                    {/* Theme toggle */}
                    <button
                        className="icon-btn"
                        onClick={toggleTheme}
                        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
                    >
                        {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
                    </button>
                </div>
            </header>

            {/* ── Dashboard ──────────────────────────────────────────────── */}
            <main className="dashboard-grid">

                {/* Left: Drop zone + Transfers */}
                <section>
                    {/* Network status */}
                    <div className="network-status-bar" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
                        {connected ? <Wifi size={13} color="var(--success)" /> : <WifiOff size={13} color="var(--danger)" />}
                        <span>{connected ? 'Connected to signaling server' : 'Reconnecting…'}</span>
                        {connected && (
                        <>
                            <span style={{ color: 'var(--border-strong)' }}>•</span>
                            <span className="network-ip" style={{ fontSize: '0.7rem' }}>{publicUrl.replace(/https?:\/\//, '')}</span>
                        </>
                    )}
                    </div>

                    {/* Drop Zone */}
                    <div
                        className={`drop-zone ${selectedPeer ? 'active' : ''} ${dragOver ? 'drag-over' : ''}`}
                        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={handleDrop}
                        onClick={() => fileInputRef.current?.click()}
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            style={{ display: 'none' }}
                            onChange={handleFileSelect}
                            multiple
                        />

                        <div className="drop-icon">
                            {dragOver ? <Download size={32} /> : <Upload size={32} />}
                        </div>

                        {selectedPeer ? (
                            <>
                                <h2>Send to {selectedPeer.name}</h2>
                                <p>Drop files or folders here, or click to browse</p>
                                <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                    <Shield size={12} color="var(--success)" />
                                    <span>AES-256-GCM encrypted · Direct P2P · No server storage</span>
                                </div>
                            </>
                        ) : (
                            <>
                                <h2>Select a device to start</h2>
                                <p>Choose a device from the panel on the right, then drag & drop files here</p>
                                <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                    <Zap size={12} color="var(--primary-light)" />
                                    <span>Unlimited file size · All file types · Fully encrypted</span>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Active Transfers */}
                    {activeTransfers.length > 0 && (
                        <div className="transfers-section">
                            <div className="panel-title" style={{ marginTop: '1.75rem' }}>
                                <Share2 size={14} />
                                Active Transfers
                                <span className="peer-count-badge">{activeTransfers.length}</span>
                            </div>
                            {activeTransfers.map(transfer => (
                                <TransferCard
                                    key={transfer.id}
                                    transfer={transfer}
                                    onPauseResume={() => togglePause(transfer)}
                                    onCancel={() => cancelTransfer(transfer)}
                                    onRetry={() => retryTransfer(transfer)}
                                    onRemove={() => removeTransfer(transfer.id)}
                                    onDownload={() => downloadFile(transfer.receivedFile)}
                                    onPreview={() => setShowPreview({ url: transfer.receivedFile?.url, metadata: transfer.receivedFile?.metadata })}
                                />
                            ))}
                        </div>
                    )}

                    {/* Completed Transfers */}
                    {completedTransfers.length > 0 && (
                        <div className="transfers-section">
                            <div className="panel-title" style={{ marginTop: '1.75rem' }}>
                                <Check size={14} />
                                Completed
                                <span className="peer-count-badge">{completedTransfers.length}</span>
                            </div>
                            {completedTransfers.map(transfer => (
                                <TransferCard
                                    key={transfer.id}
                                    transfer={transfer}
                                    onRemove={() => removeTransfer(transfer.id)}
                                    onDownload={() => downloadFile(transfer.receivedFile)}
                                    onPreview={() => setShowPreview({ url: transfer.receivedFile?.url, metadata: transfer.receivedFile?.metadata })}
                                />
                            ))}
                        </div>
                    )}

                    {transfers.length === 0 && (
                        <div className="transfers-section">
                            <div className="transfers-empty" style={{ marginTop: '1.5rem' }}>
                                <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>📂</div>
                                No active transfers. Select a peer and drop a file to begin.
                            </div>
                        </div>
                    )}
                </section>

                {/* Right: Peers list */}
                <aside className="peers-panel">
                    <div className="peers-header">
                        <div className="panel-title" style={{ margin: 0 }}>
                            <Monitor size={14} />
                            Online Devices
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <span className="peer-count-badge">{peers.length}</span>
                            <button
                                className="icon-btn"
                                onClick={copyShareLink}
                                title="Copy share link"
                                style={{ width: 30, height: 30 }}
                            >
                                <Link size={14} />
                            </button>
                        </div>
                    </div>

                    {peers.length === 0 ? (
                        <div className="no-peers">
                            <div className="no-peers-icon">📡</div>
                            <p style={{ fontWeight: 600, marginBottom: '0.4rem', color: 'var(--text)' }}>No devices found</p>
                            <p style={{ fontSize: '0.8rem' }}>
                                Open PeerDrop on another device on this network, or share your link.
                            </p>
                            <button
                                style={{ marginTop: '1rem', width: '100%', background: 'var(--bg-elevated)', color: 'var(--primary-light)', border: '1px solid var(--border)', fontSize: '0.82rem', padding: '0.6rem' }}
                                onClick={() => setShowQR(true)}
                            >
                                <QrCode size={14} /> Share QR Code
                            </button>
                        </div>
                    ) : (
                        peers.map(peer => (
                            <div
                                key={peer.socketId}
                                className={`peer-item ${selectedPeer?.socketId === peer.socketId ? 'selected' : ''}`}
                                onClick={() => setSelectedPeer(selectedPeer?.socketId === peer.socketId ? null : peer)}
                            >
                                <div className="peer-avatar" style={{
                                    background: `hsl(${peer.socketId.charCodeAt(0) * 37 % 360}, 65%, 55%)`
                                }}>
                                    {peer.name.charAt(0).toUpperCase()}
                                    <div className="peer-status-dot" />
                                </div>
                                <div className="peer-info">
                                    <div className="peer-name">{peer.name}</div>
                                    <div className="peer-meta">
                                        {getDeviceIcon(peer.type)}
                                        &nbsp;{peer.type || 'desktop'} · {peer.socketId.substring(0, 6)}
                                    </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                    <button
                                        className="peer-send-btn"
                                        onClick={e => { e.stopPropagation(); setSelectedPeer(peer); fileInputRef.current?.click(); }}
                                        title={`Send file to ${peer.name}`}
                                    >
                                        Send
                                    </button>
                                    <button
                                        className="icon-btn"
                                        style={{ width: 28, height: 28, opacity: 0.7 }}
                                        onClick={e => {
                                            e.stopPropagation();
                                            const url = `${publicUrl}/?peer=${peer.socketId}`;
                                            navigator.clipboard.writeText(url);
                                            toast.success('Peer link copied!');
                                        }}
                                        title="Copy peer link"
                                    >
                                        <Copy size={12} />
                                    </button>
                                </div>
                            </div>
                        ))
                    )}

                    {/* Encryption info */}
                    <div style={{ marginTop: '1.25rem', padding: '0.875rem', background: 'rgba(99, 102, 241, 0.06)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                        <Shield size={12} style={{ flexShrink: 0, marginTop: '2px', color: 'var(--success)' }} />
                        <span>Files are transferred <strong style={{ color: 'var(--text)' }}>end-to-end encrypted</strong> using ECDH key exchange + AES-256-GCM. Your files never touch the server.</span>
                    </div>
                </aside>
            </main>

            {/* ── Incoming Request Popup ──────────────────────────────────── */}
            {incomingRequest && (
                <div className="incoming-popup fade-in">
                    <div className="incoming-header">
                        <div className="incoming-shield">
                            <Shield size={20} />
                        </div>
                        <div>
                            <div className="incoming-title">Incoming File Request</div>
                            <div className="incoming-sub">from {incomingRequest.peerName}</div>
                        </div>
                    </div>

                    <div className="incoming-file-info">
                        <div className="incoming-filename">
                            {incomingRequest.metadata.fileCount > 1
                                ? `${incomingRequest.metadata.fileCount} files`
                                : incomingRequest.metadata.fileName}
                        </div>
                        <div className="incoming-filesize">
                            {formatFileSize(incomingRequest.metadata.fileSize)}
                            {incomingRequest.metadata.fileCount > 1 && ` · ${incomingRequest.metadata.fileCount} files`}
                        </div>
                    </div>

                    <div className="incoming-actions">
                        <button
                            onClick={() => respondToRequest(true)}
                            style={{ background: 'var(--success)' }}
                        >
                            <Check size={15} /> Accept
                        </button>
                        <button
                            className="secondary"
                            onClick={() => respondToRequest(false)}
                        >
                            <X size={15} /> Decline
                        </button>
                    </div>
                </div>
            )}

            {/* ── History Modal ───────────────────────────────────────────── */}
            {showHistory && (
                <div className="modal-overlay" onClick={() => setShowHistory(false)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <div className="modal-title">
                                <History size={18} /> Transfer History
                            </div>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                {historyLogs.length > 0 && (
                                    <button className="btn-sm cancel" onClick={clearHistory}>
                                        <Trash2 size={12} /> Clear
                                    </button>
                                )}
                                <button className="icon-btn" onClick={() => setShowHistory(false)}>
                                    <X size={18} />
                                </button>
                            </div>
                        </div>
                        <div className="modal-body">
                            {historyLogs.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-muted)' }}>
                                    <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>📋</div>
                                    <p>No transfers yet.</p>
                                </div>
                            ) : (
                                historyLogs.map(log => (
                                    <div key={log.id} className="history-item">
                                        <div className={`history-icon ${log.type}`}>
                                            {log.type === 'sent' ? <Upload size={16} /> : <Download size={16} />}
                                        </div>
                                        <div className="history-info">
                                            <div className="history-name">{log.fileName}</div>
                                            <div className="history-meta">
                                                {log.type === 'sent' ? 'To' : 'From'}: {log.peerName} · {new Date(log.timestamp).toLocaleString()}
                                            </div>
                                        </div>
                                        <div className="history-size">{formatFileSize(log.fileSize)}</div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ── QR Code Modal ───────────────────────────────────────────── */}
            {showQR && (
                <div className="modal-overlay" onClick={() => setShowQR(false)}>
                    <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <div className="modal-title">
                                <QrCode size={18} /> Share & Connect
                            </div>
                            <button className="icon-btn" onClick={() => setShowQR(false)}>
                                <X size={18} />
                            </button>
                        </div>
                        <div className="modal-body">
                            <div className="qr-container">
                                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                                    Scan this QR code on another device on the same network to connect directly.
                                </p>
                                <div className="qr-box">
                                    <QRCodeSVG value={shareUrl} size={200} level="M" />
                                </div>
                                <div className="qr-url">{shareUrl}</div>
                                <div style={{ display: 'flex', gap: '0.75rem' }}>
                                    <button
                                        className="full-width"
                                        onClick={copyShareLink}
                                    >
                                        <Copy size={15} /> Copy Link
                                    </button>
                                    <button
                                        className="full-width secondary"
                                        onClick={async () => {
                                            if (navigator.share) {
                                                await navigator.share({ title: 'PeerDrop', url: shareUrl });
                                            } else {
                                                copyShareLink();
                                            }
                                        }}
                                    >
                                        <Share2 size={15} /> Share
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ── File Preview Modal ──────────────────────────────────────── */}
            {showPreview && (
                <div className="modal-overlay preview-modal" onClick={() => setShowPreview(null)}>
                    <div className="modal" style={{ maxWidth: 780 }} onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <div className="modal-title">
                                <Eye size={18} />
                                {showPreview.metadata?.name || 'Preview'}
                            </div>
                            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                    {formatFileSize(showPreview.metadata?.size)}
                                </span>
                                <button className="icon-btn" onClick={() => setShowPreview(null)}>
                                    <X size={18} />
                                </button>
                            </div>
                        </div>
                        <div className="modal-body">
                            <FilePreview url={showPreview.url} metadata={showPreview.metadata} />
                        </div>
                    </div>
                </div>
            )}

            <ToastContainer
                position="bottom-left"
                theme={theme}
                toastStyle={{ fontSize: '0.85rem' }}
                autoClose={3500}
            />
        </div>
    );
}

// ─── TransferCard component ───────────────────────────────────────────────────

function TransferCard({ transfer, onPauseResume, onCancel, onRetry, onRemove, onDownload, onPreview }) {
    const isCompleted = transfer.status === 'completed';
    const isActive = transfer.status === 'transferring' || transfer.status === 'receiving' || transfer.status === 'connected';
    const isError = transfer.status === 'disconnected' || transfer.status === 'error';

    return (
        <div className={`transfer-card fade-in ${transfer.direction === 'receiving' ? 'receiving' : ''} ${isCompleted ? 'completed' : ''} ${transfer.paused ? 'paused' : ''} ${isError ? 'error' : ''}`}>
            <div className="transfer-header">
                {/* File icon */}
                <div className={`transfer-icon ${getFileIconClass(transfer.fileType)}`}>
                    {getFileEmoji(transfer.fileType, transfer.fileName)}
                </div>

                <div className="transfer-details">
                    <div className="transfer-name" title={transfer.fileName}>{transfer.fileName}</div>
                    <div className="transfer-meta">
                        <span className="meta-tag">
                            {transfer.direction === 'receiving' ? <Download size={10} /> : <Upload size={10} />}
                            {transfer.direction === 'receiving' ? 'From' : 'To'}: {transfer.peerName}
                        </span>
                        {transfer.fileSize && (
                            <span className="meta-tag">· {formatFileSize(transfer.fileSize)}</span>
                        )}
                        <span className={`status-badge ${getStatusLabel(transfer)}`}>
                            {transfer.paused ? 'Paused' : transfer.status}
                        </span>
                    </div>
                </div>

                {/* Actions */}
                <div className="transfer-actions">
                    {isCompleted && (
                        <>
                            {transfer.receivedFile && isPreviewable(transfer.fileType) && (
                                <button className="btn-sm preview" onClick={onPreview} title="Preview file">
                                    <Eye size={11} />
                                </button>
                            )}
                            {transfer.receivedFile && (
                                <button className="btn-sm download" onClick={onDownload} title="Save file">
                                    <Download size={11} />
                                </button>
                            )}
                            <button className="btn-sm cancel" onClick={onRemove} title="Dismiss">
                                <X size={11} />
                            </button>
                        </>
                    )}

                    {isActive && !isCompleted && (
                        <>
                            {onPauseResume && (
                                <button
                                    className={`btn-sm ${transfer.paused ? 'resume' : 'pause'}`}
                                    onClick={onPauseResume}
                                    title={transfer.paused ? 'Resume' : 'Pause'}
                                >
                                    {transfer.paused ? <Play size={11} /> : <Pause size={11} />}
                                </button>
                            )}
                            {onCancel && (
                                <button className="btn-sm cancel" onClick={onCancel} title="Cancel">
                                    <X size={11} />
                                </button>
                            )}
                        </>
                    )}

                    {isError && onRetry && (
                        <button className="btn-sm retry" onClick={onRetry} title="Retry">
                            <RefreshCw size={11} /> Retry
                        </button>
                    )}

                    {!isCompleted && !isActive && !isError && (
                        <button className="btn-sm cancel" onClick={onRemove} title="Remove">
                            <X size={11} />
                        </button>
                    )}
                </div>
            </div>

            {/* Progress bar */}
            {!isCompleted && (
                <>
                    <div className="progress-bar">
                        <div
                            className={`progress-fill ${transfer.direction === 'receiving' ? 'receiving' : ''} ${transfer.paused ? 'paused' : ''} ${isActive && !transfer.paused ? 'active' : ''}`}
                            style={{ width: `${transfer.progress || 0}%` }}
                        />
                    </div>
                    <div className="progress-stats">
                        <span>{Math.round(transfer.progress || 0)}%</span>
                        <span>
                            {transfer.speed && `${transfer.speed}`}
                            {transfer.eta && ` · ${transfer.eta} left`}
                        </span>
                    </div>
                </>
            )}

            {/* Completed — download area */}
            {isCompleted && transfer.receivedFile && (
                <div className="preview-area">
                    {transfer.fileType?.startsWith('image/') && (
                        <img
                            src={transfer.receivedFile.url}
                            alt="preview"
                            className="preview-thumb"
                            style={{ cursor: 'pointer' }}
                            onClick={onPreview}
                        />
                    )}
                    <div className="preview-info">
                        <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{transfer.fileName}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                            {formatFileSize(transfer.fileSize)}
                        </div>
                        <div className="preview-actions">
                            {isPreviewable(transfer.fileType) && (
                                <button className="btn-sm preview" onClick={onPreview}>
                                    <Eye size={11} /> Preview
                                </button>
                            )}
                            <button className="btn-sm download" onClick={onDownload}>
                                <Download size={11} /> Save
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Completed — sent file */}
            {isCompleted && !transfer.receivedFile && (
                <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--success)' }}>
                    <Check size={14} />
                    <span>Transfer complete · {formatFileSize(transfer.fileSize)}</span>
                </div>
            )}
        </div>
    );
}

// ─── FilePreview component ────────────────────────────────────────────────────

function FilePreview({ url, metadata }) {
    const [textContent, setTextContent] = useState(null);

    useEffect(() => {
        if (!url || !metadata) return;
        const type = metadata.type || '';
        if (type.includes('text') || type.includes('json') || type.includes('xml') || type.includes('javascript')) {
            fetch(url)
                .then(r => r.text())
                .then(t => setTextContent(t.substring(0, 10000)))
                .catch(() => {});
        }
    }, [url, metadata]);

    if (!url || !metadata) return null;
    const type = metadata.type || '';

    if (type.startsWith('image/')) {
        return <img src={url} alt={metadata.name} className="preview-media" />;
    }
    if (type.startsWith('video/')) {
        return <video src={url} controls className="preview-media" />;
    }
    if (type.startsWith('audio/')) {
        return (
            <div style={{ padding: '1.5rem', textAlign: 'center' }}>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🎵</div>
                <p style={{ fontWeight: 600, marginBottom: '1rem' }}>{metadata.name}</p>
                <audio src={url} controls className="preview-audio" />
            </div>
        );
    }
    if (type === 'application/pdf') {
        return <iframe src={url} title={metadata.name} className="preview-media" style={{ border: 'none', height: '60vh' }} />;
    }
    if (textContent !== null) {
        return <pre className="preview-text">{textContent}</pre>;
    }

    return (
        <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>{getFileEmoji(type, metadata.name)}</div>
            <p style={{ fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>{metadata.name}</p>
            <p>Preview not available for this file type.</p>
        </div>
    );
}

export default App;
