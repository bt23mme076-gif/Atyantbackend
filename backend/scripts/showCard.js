import 'dotenv/config';
import mongoose from 'mongoose';
import MentorExperience from '../models/MentorExperience.js';
await mongoose.connect(process.env.MONGO_URI);
const exps = await MentorExperience.find({ mentorId: '6a37a4def2c1c20f9c7b82da' }).lean();
console.log('MentorExperiences for Aryan:', exps.length);
console.log(JSON.stringify(exps, null, 2));
await mongoose.disconnect();
process.exit(0);
