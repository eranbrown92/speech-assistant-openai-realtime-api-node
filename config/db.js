import { MongoClient } from 'mongodb';

let db;

export const connectDB = async () => {
    try {
        const client = await MongoClient.connect(process.env.MONGODB_URI);
        db = client.db('voice-ai');
        console.log('Connected to MongoDB');
        return db;
    } catch (err) {
        console.error('MongoDB connection error:', err);
        process.exit(1);
    }
};

export const getDB = () => db;
