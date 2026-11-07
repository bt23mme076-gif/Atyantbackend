// Business-initiated WhatsApp messages to a student (report ready, checkout
// nudge). Meta allows free text only within 24 h of the student's last message
// to us; outside that window an approved template is required. So: free text
// if the window is open, the named template if one is configured, else skip.
import User from '../../models/User.js';
import WaConversation from '../../models/WaConversation.js';
import * as wa from './WhatsAppClient.js';

const WINDOW_MS = 23.5 * 60 * 60 * 1000; // a little inside Meta's 24 h

// Stored phones are 10-digit Indian numbers; WhatsApp ids are 91XXXXXXXXXX.
const waIdOf = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return null;
};

/**
 * @param {string} userId
 * @param {{ text: string, template?: string, params?: string[] }} msg
 *   template: env var VALUE (template name) or null when none is approved yet
 * @returns {Promise<'text'|'template'|'skipped'>}
 */
export async function notifyStudent(userId, { text, template, params = [] }) {
  if (!wa.isConfigured()) return 'skipped';
  const user = await User.findById(userId).select('phone').lean();
  const waId = waIdOf(user?.phone);
  if (!waId) return 'skipped';

  const conv = await WaConversation.findOne({ waId }).select('lastInboundAt').lean();
  if (conv?.lastInboundAt && Date.now() - new Date(conv.lastInboundAt).getTime() < WINDOW_MS) {
    return (await wa.sendText(waId, text)) ? 'text' : 'skipped';
  }
  if (template) return (await wa.sendTemplate(waId, template, params)) ? 'template' : 'skipped';
  return 'skipped';
}
