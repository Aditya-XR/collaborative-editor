import { Schema, model } from 'mongoose';

const documentSchema = new Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    data: {
      type: Object,
      default: '',
    },
  },
  { timestamps: true }
);

export default model('Document', documentSchema);
