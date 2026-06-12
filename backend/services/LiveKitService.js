import { AccessToken, RoomServiceClient, EgressClient, WebhookReceiver } from 'livekit-server-sdk';

class LiveKitService {
  _init() {
    if (this._ready) return;
    const host   = process.env.LIVEKIT_HOST       || 'http://localhost:7880';
    const key    = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    if (!key || !secret) {
      console.warn('⚠️ LiveKit credentials not configured — meet features disabled');
      return;
    }
    this.roomService  = new RoomServiceClient(host, key, secret);
    this.egressClient = new EgressClient(host, key, secret);
    this.receiver     = new WebhookReceiver(key, secret);
    this._key    = key;
    this._secret = secret;
    this._host   = host;
    this._ready  = true;
    console.log('✅ LiveKit initialized:', host);
  }

  isConfigured() {
    this._init();
    return !!this._ready;
  }

  async createRoom(sessionId) {
    this._init();
    const roomName = `session_${sessionId}`;
    await this.roomService.createRoom({
      name: roomName,
      emptyTimeout: 300,
      maxParticipants: 2,
    });
    return roomName;
  }

  // role: 'participant' | 'admin'
  async generateToken(roomName, userId, participantName, role = 'participant') {
    this._init();
    const at = new AccessToken(this._key, this._secret, {
      identity: String(userId),
      name: participantName,
      ttl: 4 * 60 * 60,
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
    this._init();
    const filePath = `${process.env.RECORDINGS_PATH || '/tmp/recordings'}/${sessionId}.ogg`;
    const egress = await this.egressClient.startRoomCompositeEgress(
      roomName,
      { filepath: filePath, fileType: 4 },
      { audioOnly: true }
    );
    return { egressId: egress.egressId, filePath };
  }

  async stopEgress(egressId) {
    this._init();
    try {
      await this.egressClient.stopEgress(egressId);
    } catch (err) {
      console.warn('stopEgress warning (non-fatal):', err.message);
    }
  }

  receiveWebhook(rawBody, authHeader) {
    this._init();
    return this.receiver.receive(rawBody, authHeader);
  }
}

export default new LiveKitService();
