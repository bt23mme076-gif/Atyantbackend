import { AccessToken, RoomServiceClient, EgressClient, WebhookReceiver } from 'livekit-server-sdk';

const LIVEKIT_HOST = process.env.LIVEKIT_HOST || 'http://localhost:7880';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const RECORDINGS_PATH = process.env.RECORDINGS_PATH || '/tmp/recordings';

class LiveKitService {
  constructor() {
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      console.warn('⚠️ LiveKit credentials not configured — meet features disabled');
      return;
    }
    this.roomService = new RoomServiceClient(LIVEKIT_HOST, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    this.egressClient = new EgressClient(LIVEKIT_HOST, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    this.receiver = new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    console.log('✅ LiveKit initialized');
  }

  isConfigured() {
    return !!(LIVEKIT_API_KEY && LIVEKIT_API_SECRET);
  }

  async createRoom(sessionId) {
    const roomName = `session_${sessionId}`;
    await this.roomService.createRoom({
      name: roomName,
      emptyTimeout: 300,   // auto-close after 5 min empty
      maxParticipants: 2,
    });
    return roomName;
  }

  // role: 'participant' | 'admin'
  async generateToken(roomName, userId, participantName, role = 'participant') {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: String(userId),
      name: participantName,
      ttl: 4 * 60 * 60, // 4-hour validity
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      roomAdmin: role === 'admin',
    });
    return at.toJwt();
  }

  async startAudioEgress(roomName, sessionId) {
    const filePath = `${RECORDINGS_PATH}/${sessionId}.ogg`;
    const egress = await this.egressClient.startRoomCompositeEgress(
      roomName,
      { filepath: filePath, fileType: 4 }, // 4 = OGG in proto enum
      { audioOnly: true }
    );
    return { egressId: egress.egressId, filePath };
  }

  async stopEgress(egressId) {
    try {
      await this.egressClient.stopEgress(egressId);
    } catch (err) {
      // Egress may have already stopped if room ended naturally
      console.warn('stopEgress warning (non-fatal):', err.message);
    }
  }

  // Returns parsed WebhookEvent or throws on invalid signature
  receiveWebhook(rawBody, authHeader) {
    return this.receiver.receive(rawBody, authHeader);
  }
}

export default new LiveKitService();
