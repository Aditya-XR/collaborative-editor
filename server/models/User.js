import { Schema, model } from 'mongoose';

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      // Optional, since Google OAuth users won't have a password set directly
    },
    avatar: {
      type: String,
      default: '',
    },
    color: {
      type: String,
      default: '#7c3aed',
    },
    googleId: {
      type: String,
    },
    refreshTokens: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true }
);

export default model('User', userSchema);
