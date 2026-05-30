import Filter from 'bad-words';

class ContentModerator {
    constructor() {
        this.filter = new Filter();
        
        // Add custom words to the filter
        this.filter.addWords(
            'fuck', 'fucking', 'fucked', 'fucker',
            'sex', 'sexy', 'porn', 'pornography',
            'dick', 'cock', 'pussy', 'penis', 'vagina',
            'asshole', 'bitch', 'bastard',
            'nigger', 'nigga', 'chink', 'spic',
            'slut', 'whore', 'hoe'
        );
    }

    isClean(text) {
        if (!text || typeof text !== 'string') return true;
        
        // Remove common obfuscation techniques
        const normalizedText = text
            .toLowerCase()
            .replace(/[._\-*@\s]+/g, '')
            .replace(/0/g, 'o')
            .replace(/1/g, 'i')
            .replace(/3/g, 'e')
            .replace(/4/g, 'a')
            .replace(/5/g, 's')
            .replace(/7/g, 't');

        try {
            // Check if the text contains profanity
            if (this.filter.isProfane(text) || this.filter.isProfane(normalizedText)) {
                return false;
            }

            // Check for repeated characters (possible obfuscation)
            if (/(.)\1{4,}/.test(text)) {
                return false;
            }

            // Check for excessive capitalization
            const upperCaseRatio = (text.match(/[A-Z]/g) || []).length / text.length;
            if (text.length > 10 && upperCaseRatio > 0.7) {
                return false;
            }

            return true;
        } catch (error) {
            console.error('Error in content moderation:', error);
            return false; // Fail closed - if there's an error, reject the content
        }
    }

    clean(text) {
        if (!text || typeof text !== 'string') return text;
        try {
            return this.filter.clean(text);
        } catch (error) {
            console.error('Error cleaning text:', error);
            return '*** message blocked ***';
        }
    }

    validateMessage(message) {
        if (!message) {
            return { isValid: false, reason: 'Message is empty' };
        }

        if (!this.isClean(message)) {
            return { 
                isValid: false, 
                reason: 'Message contains inappropriate content. Please maintain a respectful environment.' 
            };
        }

        return { isValid: true };
    }
}

const moderator = new ContentModerator();
export { moderator, ContentModerator };
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