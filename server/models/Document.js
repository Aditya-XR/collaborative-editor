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
    title: {
      type: String,
      default: 'Untitled Document',
    },
  },
  { timestamps: true }
);

export default model('Document', documentSchema);
