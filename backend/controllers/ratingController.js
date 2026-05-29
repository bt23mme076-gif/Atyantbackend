import Rating from '../models/Rating.js';
import User from '../models/User.js';
import mongoose from 'mongoose';

/**
 * @desc    Get mentor's average rating and total count
 * @route   GET /api/ratings/mentor/:mentorId
 * @access  Public
 */
export const getMentorRating = async (req, res) => {
  try {
    const { mentorId } = req.params;

    // ✅ Validate mentor exists
    const mentor = await User.findById(mentorId);
    if (!mentor) {
      return res.status(404).json({
        success: false,
        message: 'Mentor not found'
      });
    }

    // ✅ Aggregate rating data using MongoDB aggregation
    const ratingStats = await Rating.aggregate([
      {
        $match: {
          mentor: new mongoose.Types.ObjectId(mentorId),
          isPublic: true
        }
      },
      {
        $group: {
          _id: '$mentor',
          averageRating: { $avg: '$rating' },
          totalRatings: { $sum: 1 },
          ratingsBreakdown: {
            $push: '$rating'
          }
        }
      },
      {
        $project: {
          _id: 0,
          averageRating: { $round: ['$averageRating', 1] },
          totalRatings: 1,
          fiveStars: {
            $size: {
              $filter: {
                input: '$ratingsBreakdown',
                cond: { $eq: ['$$this', 5] }
              }
            }
          },
          fourStars: {
            $size: {
              $filter: {
                input: '$ratingsBreakdown',
                cond: { $eq: ['$$this', 4] }
              }
            }
          },
          threeStars: {
            $size: {
              $filter: {
                input: '$ratingsBreakdown',
                cond: { $eq: ['$$this', 3] }
              }
            }
          },
          twoStars: {
            $size: {
              $filter: {
                input: '$ratingsBreakdown',
                cond: { $eq: ['$$this', 2] }
              }
            }
          },
          oneStar: {
            $size: {
              $filter: {
                input: '$ratingsBreakdown',
                cond: { $eq: ['$$this', 1] }
              }
            }
          }
        }
      }
    ]);

    // ✅ If no ratings, return default
    if (ratingStats.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          averageRating: 0,
          totalRatings: 0,
          fiveStars: 0,
          fourStars: 0,
          threeStars: 0,
          twoStars: 0,
          oneStar: 0
        }
      });
    }

    res.status(200).json({
      success: true,
      data: ratingStats[0]
    });
  } catch (error) {
    console.error('❌ Error fetching mentor rating:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching rating'
    });
  }
};

/**
 * @desc    Get mentor reviews with pagination
 * @route   GET /api/ratings/mentor/:mentorId/reviews
 * @access  Public
 */
export const getMentorReviews = async (req, res) => {
  try {
    const { mentorId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const reviews = await Rating.find({
      mentor: mentorId,
      isPublic: true,
      feedbackText: { $exists: true, $ne: '' }
    })
      .populate('user', 'username profilePicture')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Rating.countDocuments({
      mentor: mentorId,
      isPublic: true,
      feedbackText: { $exists: true, $ne: '' }
    });

    res.status(200).json({
      success: true,
      data: {
        reviews,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalReviews: total,
          hasMore: page * limit < total
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching reviews:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching reviews'
    });
  }
};

/**
 * @desc    Submit a rating after chat session
 * @route   POST /api/ratings
 * @access  Private
 */
export const submitRating = async (req, res) => {
  try {
    const { mentorId, chatSessionId, rating, feedbackText } = req.body;
    const userId = req.user.id;

    // ✅ Enhanced validation with specific errors
    console.log('📥 Received rating submission:', {
      mentorId,
      chatSessionId,
      rating,
      userId,
      feedbackText: feedbackText ? 'present' : 'none'
    });

    if (!mentorId) {
      return res.status(400).json({
        success: false,
        message: 'Mentor ID is required',
        code: 'MISSING_MENTOR_ID'
      });
    }

    if (!chatSessionId) {
      return res.status(400).json({
        success: false,
        message: 'Chat session ID is required',
        code: 'MISSING_SESSION_ID'
      });
    }

    if (!rating) {
      return res.status(400).json({
        success: false,
        message: 'Rating is required',
        code: 'MISSING_RATING'
      });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5',
        code: 'INVALID_RATING'
      });
    }

    // Check if user already rated this session
    const existingRating = await Rating.findOne({
      user: userId,
      chatSession: chatSessionId
    });

    if (existingRating) {
      return res.status(400).json({
        success: false,
        message: 'You have already rated this session',
        code: 'ALREADY_RATED'
      });
    }

    // Create new rating
    const newRating = await Rating.create({
      mentor: mentorId,
      user: userId,
      chatSession: chatSessionId,
      rating,
      feedbackText: feedbackText?.trim() || ''
    });

    await newRating.populate('user', 'username profilePicture');

    console.log('✅ Rating saved successfully:', newRating._id);

    res.status(201).json({
      success: true,
      message: 'Rating submitted successfully',
      data: newRating
    });
  } catch (error) {
    console.error('❌ Error submitting rating:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while submitting rating',
      error: error.message
    });
  }
};

/**
 * @desc    Get top-rated mentors (for homepage/explore)
 * @route   GET /api/ratings/top-mentors
 * @access  Public
 */
export const getTopRatedMentors = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const minRatings = parseInt(req.query.minRatings) || 5;

    const topMentors = await Rating.aggregate([
      {
        $match: { isPublic: true }
      },
      {
        $group: {
          _id: '$mentor',
          averageRating: { $avg: '$rating' },
          totalRatings: { $sum: 1 }
        }
      },
      {
        $match: {
          totalRatings: { $gte: minRatings }
        }
      },
      {
        $sort: {
          averageRating: -1,
          totalRatings: -1
        }
      },
      {
        $limit: limit
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'mentorDetails'
        }
      },
      {
        $unwind: '$mentorDetails'
      },
      {
        $project: {
          _id: 0,
          mentorId: '$_id',
          username: '$mentorDetails.username',
          profilePicture: '$mentorDetails.profilePicture',
          bio: '$mentorDetails.bio',
          skills: '$mentorDetails.skills',
          averageRating: { $round: ['$averageRating', 1] },
          totalRatings: 1
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: topMentors
    });
  } catch (error) {
    console.error('❌ Error fetching top mentors:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching top mentors'
    });
  }
};