import { useEffect, useState, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL || '/';

function detectDeviceType() {
    const ua = navigator.userAgent;
    if (/tablet|ipad|playbook|silk/i.test(ua)) return 'tablet';
    if (/mobile|iphone|ipod|android|blackberry|mini|windows\sce|palm/i.test(ua)) return 'mobile';
    return 'desktop';
}

function getOrCreateDeviceId() {
    let id = localStorage.getItem('peerdrop_deviceId');
    if (!id) {
        id = 'pd-' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('peerdrop_deviceId', id);
    }
    return id;
}

function getOrCreateDeviceName() {
    let name = localStorage.getItem('peerdrop_deviceName');
    if (!name) {
        const adjectives = ['Swift', 'Rapid', 'Quantum', 'Cosmic', 'Neon', 'Cyber', 'Nova', 'Apex'];
        const nouns = ['Falcon', 'Comet', 'Spark', 'Pulse', 'Wave', 'Beam', 'Surge', 'Drift'];
        name = `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`;
        localStorage.setItem('peerdrop_deviceName', name);
    }
    return name;
}

export const useSocket = () => {
    const [socket, setSocket] = useState(null);
    const [peers, setPeers] = useState([]);
    const [deviceName, setDeviceNameState] = useState(getOrCreateDeviceName());
    const [connected, setConnected] = useState(false);
    const socketRef = useRef(null);
    const heartbeatRef = useRef(null);

    const deviceId = getOrCreateDeviceId();
    const deviceType = detectDeviceType();

    const joinServer = useCallback((sock, name) => {
        sock.emit('join', {
            deviceId,
            name: name || getOrCreateDeviceName(),
            type: deviceType
        });
    }, [deviceId, deviceType]);

    useEffect(() => {
        const newSocket = io(SOCKET_URL, {
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        });
        socketRef.current = newSocket;
        setSocket(newSocket);

        newSocket.on('connect', () => {
            console.log('[Socket] Connected:', newSocket.id);
            setConnected(true);
            joinServer(newSocket, getOrCreateDeviceName());

            // Start heartbeat to keep peer list fresh
            if (heartbeatRef.current) clearInterval(heartbeatRef.current);
            heartbeatRef.current = setInterval(() => {
                newSocket.emit('heartbeat');
            }, 20000);
        });

        newSocket.on('disconnect', () => {
            setConnected(false);
            if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        });

        newSocket.on('peers-update', (updatedPeers) => {
            setPeers(updatedPeers.filter(p => p.socketId !== newSocket.id));
        });

        return () => {
            if (heartbeatRef.current) clearInterval(heartbeatRef.current);
            newSocket.close();
        };
    }, []);

    const updateDeviceName = useCallback((newName) => {
        const trimmed = newName.trim();
        if (!trimmed) return;
        localStorage.setItem('peerdrop_deviceName', trimmed);
        setDeviceNameState(trimmed);
        if (socketRef.current) {
            socketRef.current.emit('update-name', { name: trimmed });
        }
    }, []);

    return { socket, peers, deviceId, deviceName, updateDeviceName, connected };
};
