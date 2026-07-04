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
    owner: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    collaborators: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
  },
  { timestamps: true }
);

export default model('Document', documentSchema);
