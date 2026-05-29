// Content moderation utility
const badWords = [
    // Profanity and offensive words
    'fuck', 'fucking', 'fucked', 'fucker',
    'shit', 'piss', 'dick', 'cock', 'pussy',
    'asshole', 'bitch', 'bastard',
    'cunt', 'cum', 'damn', 'hell',
    // Racial slurs and hate speech
    'nigger', 'nigga', 'chink', 'spic',
    // Sexual harassment
    'slut', 'whore', 'hoe',
    // Variations and combined words
    'stfu', 'wtf', 'fuk', 'fck', 'fuk',
    'f*ck', 'f*cking', 'f**k', 'f**king',
    // Add more words as needed
];

// Add common variations and leetspeak alternatives
const leetSpeakMap = {
    'a': ['4', '@'],
    'i': ['1', '!'],
    'e': ['3'],
    'o': ['0'],
    's': ['$', '5'],
    't': ['7'],
    // Add more mappings as needed
};

function generateVariations(word) {
    const variations = new Set([word]);
    
    // Generate leetspeak variations
    for (let i = 0; i < word.length; i++) {
        const char = word[i].toLowerCase();
        if (leetSpeakMap[char]) {
            leetSpeakMap[char].forEach(replacement => {
                variations.add(
                    word.slice(0, i) + replacement + word.slice(i + 1)
                );
            });
        }
    }
    
    return Array.from(variations);
}

// Expand bad words list with variations
const badWordsSet = new Set();
badWords.forEach(word => {
    generateVariations(word).forEach(variation => {
        badWordsSet.add(variation.toLowerCase());
    });
});

function containsProfanity(text) {
    if (!text) return false;
    
    // Convert to lowercase and remove special characters
    const processedText = text.toLowerCase().replace(/[_\*\-\.\+\?\^\$\{\}\(\)\|\[\]\\]/g, '');
    
    // Check for exact matches
    const words = processedText.split(/\s+/);
    if (words.some(word => badWordsSet.has(word))) {
        return true;
    }
    
    // Check for embedded bad words (e.g., "hellobitchhi" would be caught)
    return badWords.some(badWord => {
        // Create a pattern that can match the word even with common obfuscation
        const pattern = badWord.split('').join('[^a-z]*');
        const regex = new RegExp(pattern, 'i');
        return regex.test(processedText);
    });
}

function maskProfanity(text) {
    if (!text) return text;
    
    let maskedText = text;
    badWords.forEach(badWord => {
        // Create a pattern that matches the word with potential obfuscation
        const pattern = badWord.split('').join('[^a-zA-Z]*');
        const regex = new RegExp(pattern, 'gi');
        maskedText = maskedText.replace(regex, match => '🚫'.repeat(Math.ceil(match.length / 2)));
    });
    
    return maskedText;
}

function isAppropriateContent(text) {
    // Check for profanity
    if (containsProfanity(text)) {
        return {
            isAppropriate: false,
            reason: 'Message contains inappropriate language'
        };
    }

    // Check for spam patterns
    if (text.match(/(.)\1{4,}/)) { // Repeated characters
        return {
            isAppropriate: false,
            reason: 'Message appears to be spam'
        };
    }

    // Check for excessive capitalization
    const upperCasePercentage = (text.match(/[A-Z]/g) || []).length / text.length;
    if (text.length > 10 && upperCasePercentage > 0.7) {
        return {
            isAppropriate: false,
            reason: 'Please avoid excessive capitalization'
        };
    }

    return {
        isAppropriate: true,
        reason: null
    };
}

module.exports = {
    isAppropriateContent,
    maskProfanity
};