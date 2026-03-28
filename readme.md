# PeerDrop - Secure P2P File Sharing

🔄 A peer-to-peer file sharing application that transfers files directly between browsers using WebRTC. **No files are ever stored on the server.**

## Features

- ✅ **Direct P2P Transfer** - Files go directly between browsers via WebRTC DataChannels
- ✅ **End-to-End Encryption** - AES-256-GCM encryption with ECDH key exchange
- ✅ **No Server Storage** - Server only handles signaling; zero file data passes through it
- ✅ **Unlimited File Size** - Chunk-based streaming with 64KB chunks
- ✅ **All File Types** - Binary-safe transfer without corruption
- ✅ **Folder Sharing** - Drag-and-drop folders with preserved structure
- ✅ **Resumable Transfers** - Resume from last chunk after reconnection
- ✅ **Real-time Progress** - Percentage, speed, and ETA display
- ✅ **Pause/Resume** - Manual transfer control
- ✅ **Multiple Simultaneous Transfers** - Transfer to multiple peers at once
- ✅ **Local Discovery** - Find devices on the same network
- ✅ **QR Code Connect** - Quick connection via QR code scan
- ✅ **Share Links** - Temporary session links for quick connection
- ✅ **Dark Mode** - Beautiful dark/light theme toggle
- ✅ **File Preview** - Preview images/videos before download
- ✅ **Transfer History** - Metadata-only history (no files stored)
- ✅ **Dynamic Chunk Sizing** - Adapts chunk size based on network speed
- ✅ **STUN/TURN Support** - Works across different networks

## Architecture