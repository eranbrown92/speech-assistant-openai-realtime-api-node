import twilio from 'twilio';
import { authenticate } from '../middleware/auth.js';
import { getDB } from '../config/db.js';
import WebSocket from 'ws';

export default async function callRoutes(fastify) {
    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    fastify.get('/call', {
        preHandler: authenticate,
        websocket: true
    }, async (connection, request) => {
        try {
            const db = getDB();
            const user = await db.collection('users').findOne({ email: request.session.user.email });
            
            if (!user || !user.verified) {
                connection.socket.send(JSON.stringify({ error: 'User not verified' }));
                connection.socket.close();
                return;
            }

            // Initialize call tracking
            const callDoc = {
                userId: user.email,
                startTime: new Date(),
                status: 'active'
            };
            
            const result = await db.collection('calls').insertOne(callDoc);
            const callId = result.insertedId;

            // Handle WebSocket events
            connection.socket.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    // Handle different message types
                    switch(data.type) {
                        case 'end_call':
                            await handleCallEnd(callId, user.email);
                            break;
                        // Add other message type handlers as needed
                    }
                } catch (error) {
                    console.error('WebSocket message handling error:', error);
                }
            });

            connection.socket.on('close', async () => {
                await handleCallEnd(callId, user.email);
            });

        } catch (error) {
            console.error('WebSocket error:', error);
            connection.socket.close();
        }
    });

    fastify.all('/incoming-call', async (request, reply) => {
        const from = request.body?.From || request.query?.From;
        
        try {
            const db = getDB();
            const user = await db.collection('users').findOne({ phone: from });

            if (!user || !user.verified) {
                const twiml = new twilio.twiml.VoiceResponse();
                twiml.say('Sorry, this number is not registered or verified.');
                twiml.hangup();
                return reply.type('text/xml').send(twiml.toString());
            }

            const twiml = new twilio.twiml.VoiceResponse();
            twiml.say('Welcome to Voice AI. Connecting you now.');
            // Add your call connection logic here
            
            return reply.type('text/xml').send(twiml.toString());
        } catch (error) {
            console.error('Incoming call error:', error);
            const twiml = new twilio.twiml.VoiceResponse();
            twiml.say('An error occurred. Please try again later.');
            twiml.hangup();
            return reply.type('text/xml').send(twiml.toString());
        }
    });

    async function handleCallEnd(callId, userId) {
        const db = getDB();
        try {
            await db.collection('calls').updateOne(
                { _id: callId },
                { 
                    $set: {
                        endTime: new Date(),
                        status: 'completed'
                    }
                }
            );
        } catch (error) {
            console.error('Error ending call:', error);
        }
    }
}
