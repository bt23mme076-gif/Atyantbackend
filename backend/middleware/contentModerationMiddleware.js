const { isAppropriateContent, maskProfanity } = require('../utils/contentModeration');

const badWords = [
    // English
    'fuck', 'fucking', 'fucked', 'pussy', 'asshole', 'bitch', 'nigger', 'nigga','slut',
    // Hindi (Romanized)
    'maa ki chut', 'behen ki chut', 'bdsk', 'sale', 'randi',
    // Hindi (Devanagari)
    'माँ की चूत', 'बहन की चूत', 'रंडी', 'साले'
];

const contentModerationMiddleware = async (req, res, next) => {
    try {
        // Check all possible locations where content might be
        const contentFields = ['content', 'message', 'text', 'body'];
        
        for (const field of contentFields) {
            if (req.body[field]) {
                const check = isAppropriateContent(req.body[field]);
                
                if (!check.isAppropriate) {
                    return res.status(400).json({
                        success: false,
                        message: 'Your message contains inappropriate content. Please maintain a respectful communication environment.',
                        details: check.reason
                    });
                }
                
                // Always mask any potential inappropriate content
                req.body[field] = maskProfanity(req.body[field]);
            }
        }

        // Also check query parameters
        if (req.query.message || req.query.content) {
            const queryContent = req.query.message || req.query.content;
            const check = isAppropriateContent(queryContent);
            
            if (!check.isAppropriate) {
                return res.status(400).json({
                    success: false,
                    message: 'Query contains inappropriate content',
                    details: check.reason
                });
            }
        }
        
        next();
    } catch (error) {
        console.error('Content moderation error:', error);
        next(error);
    }
};

module.exports = contentModerationMiddleware;