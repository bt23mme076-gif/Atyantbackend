const badWords = [
    // Profanity
    'fuck', 'fucking', 'fucked', 'fucker',
    // Sexual content
    'sex', 'sexy', 'porn', 'pornography',
    // Offensive terms
    'pussy', 'asshole', 'bitch', 'bastard',
    // Racial slurs
    'nigger', 'nigga',
    // Generic insults
    'idiot', 'stupid', 'dumb'
];

class ContentModerator {
    constructor() {
        this.badWordsSet = new Set(badWords);
    }

    isClean(text) {
        if (!text || typeof text !== 'string') return true;
        
        // Convert to lowercase for case-insensitive matching
        const lowerText = text.toLowerCase();
        
        // Check for bad words
        return !badWords.some(word => lowerText.includes(word));
    }

    clean(text) {
        if (!text || typeof text !== 'string') return text;
        
        let cleanedText = text;
        badWords.forEach(word => {
            const regex = new RegExp(word, 'gi');
            cleanedText = cleanedText.replace(regex, '***');
        });
        
        return cleanedText;
    }

    validateMessage(message) {
        if (!message) {
            return { isValid: false, reason: 'Message is empty' };
        }

        // Check for excessive length
        if (message.length > 10000) {
            return { isValid: false, reason: 'Message is too long (maximum 10000 characters)' };
        }

        // Check for spam-like patterns
        if (/(.)\1{4,}/.test(message)) {
            return { isValid: false, reason: 'Message contains repetitive patterns' };
        }

        // Check for excessive uppercase (shouting)
        const upperCaseRatio = (message.match(/[A-Z]/g) || []).length / message.length;
        if (message.length > 10 && upperCaseRatio > 0.7) {
            return { isValid: false, reason: 'Please do not use excessive capital letters' };
        }

        // Check for inappropriate content
        if (!this.isClean(message)) {
            return { 
                isValid: false, 
                reason: 'Message contains inappropriate content. Please maintain a respectful environment.' 
            };
        }

        return { isValid: true };
    }
}

export const moderator = new ContentModerator();
export default ContentModerator;