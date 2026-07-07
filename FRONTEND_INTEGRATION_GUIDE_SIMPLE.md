# 🎤 Frontend Integration Guide - 2 Minute Setup

## ✅ Step 1: Files Already Copied! 

Files copy ho chuki hain:
```
C:\Atyantfrontend\src\components\LiveKit\
├── AdvancedMicrophoneCheck.jsx  ✅
└── MicrophoneCheck.css           ✅
```

---

## 📝 Step 2: Edit MeetPage.jsx (Manual - 2 changes)

Open file: `C:\Atyantfrontend\src\pages\MeetPage.jsx`

### Change 1: Add Import (Line ~13, after NetworkAlerts import)

**Find this:**
```javascript
import NetworkAlerts from '../components/meet/NetworkAlerts';
```

**Add this line below it:**
```javascript
import AdvancedMicrophoneCheck from '../components/LiveKit/AdvancedMicrophoneCheck';
import '../components/LiveKit/MicrophoneCheck.css';
```

### Change 2: Add Component (Line ~26, inside MeetTools function)

**Find this:**
```javascript
function MeetTools({ hasVideo }) {
    const state = useConnectionState();
    if (state !== ConnectionState.Connected) return null;
    return (
        <>
            <SessionTimer />
            <NetworkAlerts />
```

**Add this line after `<>` opening:**
```javascript
function MeetTools({ hasVideo }) {
    const state = useConnectionState();
    if (state !== ConnectionState.Connected) return null;
    return (
        <>
            <AdvancedMicrophoneCheck />  {/* 👈 ADD THIS LINE */}
            <SessionTimer />
            <NetworkAlerts />
```

---

## 🚀 Step 3: Test It!

```bash
# Start frontend
cd C:\Atyantfrontend
npm run dev

# Open browser and join a session
# Try these tests:
```

### Test 1: Mute mic
- Join session
- Click mute button
- **Expected:** Yellow banner "⚠️ Microphone not enabled"

### Test 2: Block permission
- Refresh page
- When browser asks for mic, click "Block"
- **Expected:** Red banner "⚠️ Browser blocked microphone"

### Test 3: Working mic
- Grant permission
- Speak
- **Expected:** Green banner "✅ Microphone working [audio bars]"

---

## 🆘 Agar Error Aaye

### Error: "Cannot find module"
**Fix:**
```bash
cd C:\Atyantfrontend
npm install @livekit/components-react livekit-client
```

### Error: CSS not loading
**Fix:** Make sure you added both lines in import:
```javascript
import AdvancedMicrophoneCheck from '../components/LiveKit/AdvancedMicrophoneCheck';
import '../components/LiveKit/MicrophoneCheck.css';  // ← Don't forget this!
```

### Error: "localParticipant is undefined"
**Fix:** Component ko LiveKitRoom ke andar hi use karo, bahar nahi.

---

## 📋 Complete MeetTools After Changes

After integration, your MeetTools should look like:

```javascript
function MeetTools({ hasVideo }) {
    const state = useConnectionState();
    if (state !== ConnectionState.Connected) return null;
    return (
        <>
            <AdvancedMicrophoneCheck />  {/* 👈 NEW */}
            <SessionTimer />
            <NetworkAlerts />
            <ResumePanel top={14} left={14} />
            {hasVideo && <BackgroundControl top={14} right={14} />}
            <Whiteboard top={hasVideo ? 66 : 14} right={14} />
            <SessionNotes top={hasVideo ? 118 : 66} right={14} />
        </>
    );
}
```

---

## ✅ Done!

That's it! Just 2 changes:
1. ✅ Import component (1 line)
2. ✅ Add component to MeetTools (1 line)

Total time: **2 minutes** ⏱️

Mic detection will now warn users immediately if their mic isn't working! 🎤✅
