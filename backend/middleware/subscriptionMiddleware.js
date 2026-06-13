import User from '../models/User.js';

/**
 * Middleware to enforce subscription plan requirements
 * 
 * @param {string} requiredPlan - 'clarity' | 'pro'
 * @returns {function} Express middleware function
 */
export const requireSubscription = (requiredPlan) => {
  return async (req, res, next) => {
    try {
      const user = await User.findById(req.user.userId);
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Plan hierarchy: free (0) < clarity (1) < pro (2)
      const planHierarchy = { free: 0, clarity: 1, pro: 2 };
      const userLevel = planHierarchy[user.subscriptionPlan] || 0;
      const requiredLevel = planHierarchy[requiredPlan] || 0;

      // Check if user has required plan level
      if (userLevel < requiredLevel) {
        return res.status(403).json({ 
          error: `This feature requires ${requiredPlan} plan or higher`,
          currentPlan: user.subscriptionPlan,
          requiredPlan,
        });
      }

      // Check if subscription is active
      if (user.subscriptionStatus !== 'active') {
        return res.status(403).json({ 
          error: `Subscription is ${user.subscriptionStatus}`,
          currentPlan: user.subscriptionPlan,
          subscriptionStatus: user.subscriptionStatus,
        });
      }

      // Check if subscription has expired
      if (user.subscriptionExpiry && new Date() > user.subscriptionExpiry) {
        // Auto-expire the subscription
        user.subscriptionStatus = 'expired';
        await user.save();
        
        return res.status(403).json({ 
          error: 'Subscription expired',
          currentPlan: user.subscriptionPlan,
          subscriptionStatus: 'expired',
          expiredAt: user.subscriptionExpiry,
        });
      }

      // Attach subscription info to request for use in controllers
      req.subscription = {
        plan: user.subscriptionPlan,
        status: user.subscriptionStatus,
        expiry: user.subscriptionExpiry,
        credits: user.subscriptionCredits,
      };

      next();
    } catch (err) {
      console.error('Subscription middleware error:', err);
      res.status(500).json({ error: 'Failed to verify subscription' });
    }
  };
};

/**
 * Optional: Check if user has any active subscription (not free)
 * Use this for features that require any paid plan
 */
export const requirePaidSubscription = (req, res, next) => {
  requireSubscription('clarity')(req, res, next);
};

/**
 * Optional: Deduct subscription credit for usage
 * Call this after successful use of a premium feature
 */
export const deductSubscriptionCredit = async (userId) => {
  try {
    const user = await User.findById(userId);
    if (user && user.subscriptionCredits > 0) {
      user.subscriptionCredits -= 1;
      await user.save();
      return { success: true, remainingCredits: user.subscriptionCredits };
    }
    return { success: false, error: 'No credits available' };
  } catch (err) {
    console.error('Failed to deduct subscription credit:', err);
    return { success: false, error: err.message };
  }
};
