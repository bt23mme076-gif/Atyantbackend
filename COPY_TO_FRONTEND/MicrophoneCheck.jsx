import { useEffect, useState } from 'react';
import './MicrophoneCheck.css';

/**
 * Microphone Detection Component
 * Place this inside your LiveKitRoom component to monitor mic status
 * 
 * Usage:
 * <LiveKitRoom>
 *   <MicrophoneCheck room={room} localParticipant={localParticipant} />
 * </LiveKitRoom>
 */
export default function MicrophoneCheck({ room, localParticipant }) {
  const [micStatus, setMicStatus] = useState('checking'); // checking | working | muted | blocked
  const [showWarning, setShowWarning] = useState(false);
  const [canDismiss, setCanDismiss] = useState(false);

  useEffect(() => {
    if (!room || !localParticipant) return;

    let checkTimer;

    const checkMicStatus = () => {
      const audioTracks = Array.from(localParticipant.audioTracks.values());
      
      if (audioTracks.length === 0) {
        setMicStatus('muted');
        setShowWarning(true);
        return;
      }

      const audioTrack = audioTracks[0];
      
      if (!audioTrack.isEnabled) {
        setMicStatus('muted');
        setShowWarning(true);
        return;
      }

      // Track is enabled and published
      setMicStatus('working');
      setShowWarning(false);
    };

    // Initial check after 3 seconds
    checkTimer = setTimeout(() => {
      checkMicStatus();
      // Allow dismissing success banner after 5 seconds
      setTimeout(() => setCanDismiss(true), 5000);
    }, 3000);

    // Listen for track changes
    if (localParticipant.on) {
      localParticipant.on('trackPublished', checkMicStatus);
      localParticipant.on('trackUnpublished', checkMicStatus);
      localParticipant.on('trackMuted', checkMicStatus);
      localParticipant.on('trackUnmuted', checkMicStatus);
    }

    return () => {
      clearTimeout(checkTimer);
      if (localParticipant.off) {
        localParticipant.off('trackPublished', checkMicStatus);
        localParticipant.off('trackUnpublished', checkMicStatus);
        localParticipant.off('trackMuted', checkMicStatus);
        localParticipant.off('trackUnmuted', checkMicStatus);
      }
    };
  }, [room, localParticipant]);

  if (micStatus === 'checking') {
    return (
      <div className="mic-check-banner checking">
        🎤 Checking microphone...
      </div>
    );
  }

  if (showWarning && micStatus !== 'working') {
    return (
      <div className="mic-check-banner warning">
        <div className="warning-content">
          <span className="warning-icon">⚠️</span>
          <div className="warning-text">
            <strong>Microphone Issue Detected!</strong>
            <p>
              {micStatus === 'muted' && 'Your microphone is muted or not enabled. '}
              {micStatus === 'blocked' && 'Microphone access was blocked by your browser. '}
              The other person cannot hear you.
            </p>
          </div>
          <button 
            className="fix-button"
            onClick={() => {
              const msg = micStatus === 'muted' 
                ? 'To enable your microphone:\n\n1. Click the microphone icon in the call interface\n2. Make sure it\'s NOT crossed out (red)\n3. Speak and check if the audio indicator moves'
                : 'To fix microphone permissions:\n\n1. Click the lock icon (🔒) in your browser\'s address bar\n2. Find "Microphone" in the list\n3. Change it to "Allow"\n4. Refresh this page';
              alert(msg);
            }}
          >
            How to Fix
          </button>
        </div>
      </div>
    );
  }

  if (micStatus === 'working' && !canDismiss) {
    return (
      <div className="mic-check-banner success">
        ✅ Microphone working
      </div>
    );
  }

  return null; // Hide banner after 5 seconds if everything is working
}
