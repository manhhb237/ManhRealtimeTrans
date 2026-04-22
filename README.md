# Manh's Realtime Translator

Real-time Multi-language Voice & Text Chat Room — Desktop application with Vietnamese ↔ Japanese live translation.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Desktop App (pywebview)                            │
│  ┌───────────────────┐  ┌────────────────────────┐  │
│  │  Frontend (HTML/JS)│  │  Python Backend        │  │
│  │  - Chat UI         │  │  - Soniox WebSocket    │  │
│  │  - Firebase JS SDK │◄►│  - Firebase Admin SDK  │  │
│  │  - Mic Capture     │  │  - edge-tts Engine     │  │
│  │  - Audio Playback  │  │  - Presence Manager    │  │
│  └───────────────────┘  └────────────────────────┘  │
└─────────────────────────────────────────────────────┘
         │                        │
         ▼                        ▼
  Firebase RTDB              Soniox STT API
  (Messages, Rooms,          (Real-time Translation
   Presence)                  vi ↔ ja)
```

## Features

- **Real-time Voice Translation**: Speak Vietnamese, hear Japanese (and vice versa)
- **Soniox Two-way Translation**: Uses `stt-rt-v4` model with endpoint detection
- **Text-to-Speech**: Microsoft Edge TTS for natural voice playback
- **Chat Rooms**: Public and Private rooms with password protection
- **Discord-style UI**: Dark theme with smooth animations
- **Presence Management**: Firebase `onDisconnect()` for user tracking
- **Cost Optimization**: Auto-disconnect Soniox when < 2 users or 30 min idle

## Prerequisites

- Python 3.10+
- [Soniox API Key](https://console.soniox.com)
- [Firebase Project](https://console.firebase.google.com) with Realtime Database enabled

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/ManhRealtimeTrans.git
cd ManhRealtimeTrans
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

### 3. Configure API keys

Copy `config.example.json` to `config.json`:

```bash
cp config.example.json config.json
```

Edit `config.json` with your credentials:

```json
{
    "soniox_api_key": "YOUR_SONIOX_API_KEY",
    "firebase_service_account": "serviceAccountKey.json",
    "firebase_config": {
        "apiKey": "YOUR_FIREBASE_API_KEY",
        "authDomain": "your-project.firebaseapp.com",
        "databaseURL": "https://your-project-default-rtdb.firebaseio.com",
        "projectId": "your-project-id",
        "storageBucket": "your-project.appspot.com",
        "messagingSenderId": "123456789",
        "appId": "1:123456789:web:abcdef"
    }
}
```

### 4. Add Firebase Service Account

Download your service account key from Firebase Console:
1. Go to **Project Settings** → **Service Accounts**
2. Click **Generate new private key**
3. Save as `serviceAccountKey.json` in the project root

### 5. Firebase RTDB Rules

Set your database rules to allow authenticated access:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

> **Note**: For production, use proper security rules with Firebase Auth.

## Run

```bash
pythonw main.pyw
```

Or:

```bash
python main.pyw
```

## Usage

1. Enter your display name and select your language (Vietnamese or Japanese)
2. Create a room or join an existing one
3. Hold the microphone button to speak
4. Your speech is transcribed, translated, and displayed in real-time
5. Other users hear the translation via Text-to-Speech

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Desktop Window | pywebview (WebView2) |
| Frontend | HTML5, CSS3, Vanilla JS |
| Backend | Python 3.10+ |
| Database | Firebase Realtime Database |
| Speech Recognition + Translation | Soniox WebSocket API |
| Text-to-Speech | edge-tts (Microsoft Edge) |
| Password Hashing | bcrypt |

## File Structure

```
├── main.pyw              # Python backend
├── config.json           # API keys (gitignored)
├── config.example.json   # Config template
├── requirements.txt      # Python dependencies
├── frontend/
│   ├── index.html        # Main HTML
│   ├── style.css         # Discord-like dark theme
│   └── app.js            # Firebase + UI logic
└── README.md
```

## License

MIT
