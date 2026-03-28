import { encryptChunk, decryptChunk } from './crypto';

const INITIAL_CHUNK_SIZE = 64 * 1024;   // 64 KB
const MAX_CHUNK_SIZE = 512 * 1024;       // 512 KB
const MIN_CHUNK_SIZE = 16 * 1024;        // 16 KB
const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024; // 4 MB back-pressure threshold

const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
    },
    {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
    },
    {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
    }
];

class WebRTCManager {
    constructor(socket, peerId, options) {
        this.socket = socket;
        this.peerId = peerId;
        this.options = options;
        this.onProgress = options.onProgress || (() => {});
        this.onComplete = options.onComplete || (() => {});
        this.onStatus = options.onStatus || (() => {});
        this.onSpeed = options.onSpeed || (() => {});
        this.onFileStart = options.onFileStart || (() => {});

        this.peerConnection = null;
        this.dataChannel = null;

        // Sender state
        this.fileQueue = [];          // Queue of files to send
        this.currentFile = null;
        this.currentFileMetadata = null;
        this.offset = 0;
        this.chunkSize = INITIAL_CHUNK_SIZE;
        this.paused = false;
        this.sending = false;

        // Receiver state
        this.receivedChunks = [];
        this.fileMetadata = null;
        this.receivedBytes = 0;

        // Stats
        this.startTime = 0;
        this.bytesTransferred = 0;
        this.lastSpeedCheck = { time: 0, bytes: 0 };
    }

    // ─── Connection Setup ─────────────────────────────────────────────────────

    async initConnection(isInitiator = false) {
        // Close any existing connection cleanly
        if (this.peerConnection) {
            this.peerConnection.onicecandidate = null;
            this.peerConnection.ondatachannel = null;
            this.peerConnection.close();
            this.peerConnection = null;
        }

        this.peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('ice-candidate', {
                    to: this.peerId,
                    candidate: event.candidate,
                    from: this.socket.id
                });
            }
        };

        this.peerConnection.onconnectionstatechange = () => {
            const state = this.peerConnection?.connectionState;
            console.log(`[RTC] Connection state → ${state}`);
            if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                this.onStatus('disconnected');
            }
        };

        if (isInitiator) {
            this.dataChannel = this.peerConnection.createDataChannel('fileTransfer', {
                ordered: true,
                maxRetransmits: undefined
            });
            this.dataChannel.binaryType = 'arraybuffer';
            this._setupDataChannel();

            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);
            this.socket.emit('signal-offer', {
                to: this.peerId,
                offer,
                from: this.socket.id
            });
        } else {
            this.peerConnection.ondatachannel = (event) => {
                this.dataChannel = event.channel;
                this.dataChannel.binaryType = 'arraybuffer';
                this._setupDataChannel();
            };
        }
    }

    _setupDataChannel() {
        this.dataChannel.onopen = () => {
            console.log('[DC] Data channel open');
            this.onStatus('connected');

            // If we have files queued (sender side), kick off sending
            if (this.fileQueue.length > 0 && !this.currentFile) {
                this._sendNextFile();
            }
        };

        this.dataChannel.onclose = () => {
            console.log('[DC] Data channel closed');
            this.onStatus('disconnected');
        };

        this.dataChannel.onerror = (err) => {
            console.error('[DC] Data channel error', err);
            this.onStatus('error');
        };

        // Back-pressure: resume sending when buffer drains
        this.dataChannel.bufferedAmountLowThreshold = MAX_BUFFERED_AMOUNT / 2;
        this.dataChannel.onbufferedamountlow = () => {
            if (this.sending && !this.paused) {
                this._readAndSendChunk();
            }
        };

        this.dataChannel.onmessage = (event) => {
            this._handleIncomingMessage(event.data);
        };
    }

    // ─── Sender ───────────────────────────────────────────────────────────────

    /**
     * Queue a file for sending. Kicks off immediately if channel is open and idle.
     */
    enqueueFile(file, transferId) {
        this.fileQueue.push({ file, transferId });
        if (this.dataChannel?.readyState === 'open' && !this.currentFile) {
            this._sendNextFile();
        }
    }

    /**
     * Legacy method for setting a single file before channel opens.
     */
    prepareFile(file, transferId) {
        this.fileQueue.push({ file, transferId: transferId || 'single' });
    }

    _sendNextFile() {
        if (this.fileQueue.length === 0) {
            this.currentFile = null;
            return;
        }

        const { file, transferId } = this.fileQueue.shift();
        this.currentFile = file;
        this.currentFileMetadata = {
            transferId,
            name: file.name,
            size: file.size,
            type: file.type || 'application/octet-stream'
        };
        this.offset = 0;
        this.chunkSize = INITIAL_CHUNK_SIZE;
        this.paused = false;
        this.sending = true;
        this.startTime = Date.now();
        this.bytesTransferred = 0;
        this.lastSpeedCheck = { time: Date.now(), bytes: 0 };

        // Tell receiver about this file
        this._send(JSON.stringify({ type: 'metadata', metadata: this.currentFileMetadata }));
        this._readAndSendChunk();
    }

    _readAndSendChunk() {
        if (!this.currentFile) return;
        if (this.paused) return;
        if (this.offset >= this.currentFile.size) return;
        if (this.dataChannel?.bufferedAmount > MAX_BUFFERED_AMOUNT) {
            // Wait for bufferedamountlow event
            return;
        }

        const slice = this.currentFile.slice(this.offset, this.offset + this.chunkSize);
        const reader = new FileReader();

        reader.onload = async (e) => {
            if (this.paused || !this.currentFile) return;

            const chunk = e.target.result;
            const aesKey = this.options.getEncryptionKey();

            try {
                let payload;
                if (aesKey) {
                    payload = await encryptChunk(aesKey, chunk);
                } else {
                    payload = chunk;
                }
                this._send(payload);
            } catch (err) {
                console.error('[RTC] Encryption failed', err);
                return;
            }

            this.offset += slice.size;
            this.bytesTransferred += slice.size;
            this._adjustChunkSize();
            this._emitProgress();

            if (this.offset >= this.currentFile.size) {
                // Finished this file
                this._send(JSON.stringify({ type: 'complete', transferId: this.currentFileMetadata.transferId }));
                this.onComplete(this.currentFileMetadata.transferId);
                this.currentFile = null;
                this.sending = false;

                // Wait a tick, then send next file if queued
                setTimeout(() => this._sendNextFile(), 100);
            } else {
                // Continue without blocking microtask queue unnecessarily
                if (this.dataChannel?.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
                    this._readAndSendChunk();
                }
                // else: wait for bufferedamountlow
            }
        };

        reader.readAsArrayBuffer(slice);
    }

    _send(data) {
        if (this.dataChannel?.readyState === 'open') {
            this.dataChannel.send(data);
        }
    }

    pause() {
        this.paused = true;
        this._send(JSON.stringify({ type: 'control', action: 'pause' }));
    }

    resume() {
        this.paused = false;
        this._send(JSON.stringify({ type: 'control', action: 'resume' }));
        if (this.currentFile) {
            this._readAndSendChunk();
        }
    }

    cancel() {
        this.paused = true;
        this.currentFile = null;
        this.fileQueue = [];
        this._send(JSON.stringify({ type: 'control', action: 'cancel' }));
    }

    // ─── Receiver ────────────────────────────────────────────────────────────

    _handleIncomingMessage(data) {
        if (typeof data === 'string') {
            try {
                const msg = JSON.parse(data);
                this._handleControlMessage(msg);
            } catch (e) {
                console.error('[DC] Failed to parse control message', e);
            }
        } else if (data instanceof ArrayBuffer) {
            this._handleBinaryChunk(data);
        }
    }

    _handleControlMessage(msg) {
        switch (msg.type) {
            case 'metadata':
                this.fileMetadata = msg.metadata;
                this.receivedChunks = [];
                this.receivedBytes = 0;
                this.startTime = Date.now();
                this.bytesTransferred = 0;
                this.lastSpeedCheck = { time: Date.now(), bytes: 0 };
                this.onStatus('receiving');
                this.onFileStart(msg.metadata);
                break;

            case 'complete':
                this._assembleFile(msg.transferId);
                break;

            case 'control':
                if (msg.action === 'pause') this.paused = true;
                if (msg.action === 'resume') {
                    this.paused = false;
                    // Sender-side: if we're receiver, nothing to do
                }
                if (msg.action === 'cancel') {
                    this.receivedChunks = [];
                    this.fileMetadata = null;
                    this.onStatus('cancelled');
                }
                break;

            default:
                console.warn('[DC] Unknown control message type', msg.type);
        }
    }

    async _handleBinaryChunk(buffer) {
        const aesKey = this.options.getEncryptionKey();
        let chunk = buffer;

        if (aesKey) {
            try {
                chunk = await decryptChunk(aesKey, buffer);
            } catch (err) {
                console.error('[RTC] Decryption failed', err);
                return;
            }
        }

        this.receivedChunks.push(chunk);
        this.receivedBytes += chunk.byteLength;
        this.bytesTransferred = this.receivedBytes;

        const progress = this.fileMetadata
            ? Math.min((this.receivedBytes / this.fileMetadata.size) * 100, 100)
            : 0;

        this.onProgress(progress);
        this._emitSpeed();
    }

    _assembleFile(transferId) {
        if (!this.fileMetadata) return;
        const blob = new Blob(this.receivedChunks, { type: this.fileMetadata.type });
        const url = URL.createObjectURL(blob);
        this.onComplete({ url, blob, metadata: this.fileMetadata, transferId });
        // Reset for next file
        this.receivedChunks = [];
        this.receivedBytes = 0;
    }

    // Resume from disconnection: re-establish RTC from a given byte offset
    getReceivedBytes() {
        return this.receivedBytes;
    }

    // ─── Stats ────────────────────────────────────────────────────────────────

    _adjustChunkSize() {
        const elapsed = (Date.now() - this.startTime) / 1000;
        if (elapsed < 0.5) return; // Not enough data yet
        const speed = this.bytesTransferred / elapsed;

        if (speed > 5 * 1024 * 1024) {
            this.chunkSize = Math.min(Math.floor(this.chunkSize * 1.5), MAX_CHUNK_SIZE);
        } else if (speed < 1 * 1024 * 1024) {
            this.chunkSize = Math.max(Math.floor(this.chunkSize / 1.5), MIN_CHUNK_SIZE);
        }
    }

    _emitProgress() {
        if (!this.currentFile) return;
        const progress = Math.min((this.offset / this.currentFile.size) * 100, 100);
        this.onProgress(progress);
        this._emitSpeed();
    }

    _emitSpeed() {
        const now = Date.now();
        const elapsed = (now - this.startTime) / 1000;
        if (elapsed < 0.1) return;

        const speed = this.bytesTransferred / elapsed;
        const totalSize = this.currentFile?.size || this.fileMetadata?.size || 0;
        const remaining = totalSize - this.bytesTransferred;
        const eta = speed > 0 ? remaining / speed : 0;

        this.onSpeed({
            speed: _formatSpeed(speed),
            eta: _formatETA(eta),
            speedRaw: speed
        });
    }

    destroy() {
        if (this.dataChannel) {
            this.dataChannel.onopen = null;
            this.dataChannel.onclose = null;
            this.dataChannel.onmessage = null;
            this.dataChannel.onerror = null;
            this.dataChannel.onbufferedamountlow = null;
            this.dataChannel.close();
        }
        if (this.peerConnection) {
            this.peerConnection.onicecandidate = null;
            this.peerConnection.ondatachannel = null;
            this.peerConnection.onconnectionstatechange = null;
            this.peerConnection.close();
        }
    }
}

function _formatSpeed(bytes) {
    if (!bytes || bytes < 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function _formatETA(seconds) {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    if (m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

export default WebRTCManager;
