import twilio from 'twilio';
import WebSocket from 'ws';
import { getDB } from '../config/db.js';
import { ObjectId } from 'mongodb';
import { authenticate } from '../middleware/auth.js';

// Constants
const SYSTEM_MESSAGE = 'You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.';
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;

// Call Status Constants - matching frontend badge styles
const CALL_STATUS = {
    ACTIVE: 'active',         // bg-primary (blue) - Call is currently in progress
    COMPLETED: 'completed',   // bg-success (green) - Call ended successfully
    FAILED: 'failed'         // bg-danger (red) - Call failed or errored
};

// List of Event Types to log
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

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
                userEmail: user.email,
                userId: user._id,
                startTime: new Date(),
                status: CALL_STATUS.ACTIVE
            };
            
            const result = await db.collection('calls').insertOne(callDoc);
            const callId = result.insertedId.toString();
            console.log('New call created:', { callId, userEmail: user.email, status: CALL_STATUS.ACTIVE });

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

    // Route for Twilio to handle incoming calls
    fastify.post('/incoming-call', async (request, reply) => {
        try {
            const from = request.body?.From || request.query?.From;
            if (!from) {
                const twiml = new twilio.twiml.VoiceResponse();
                twiml.say('Invalid phone number.');
                twiml.hangup();
                return reply.type('text/xml').send(twiml.toString());
            }

            // Verify user exists and is verified
            const db = getDB();
            const user = await db.collection('users').findOne({ 
                phone: from,
                verified: true 
            });

            if (!user) {
                const twiml = new twilio.twiml.VoiceResponse();
                twiml.say('This phone number is not registered or verified. Please register and verify your account first.');
                twiml.hangup();
                return reply.type('text/xml').send(twiml.toString());
            }

            // Create a new call record
            const callDoc = {
                userEmail: user.email,
                userId: user._id,
                phone: from,
                startTime: new Date(),
                status: CALL_STATUS.ACTIVE
            };
            
            const result = await db.collection('calls').insertOne(callDoc);
            const callId = result.insertedId.toString();
            
            console.log('Call started:', { callId, userEmail: user.email, userId: user._id, phone: from, startTime: callDoc.startTime });

            // Generate TwiML response
            const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>${user.name ? `Welcome back, ${user.name}.` : 'Welcome to Voice AI.'} Connecting you to your AI assistant now.</Say>
                              <Pause length="1"/>
                              <Say>O.K. you can start talking!</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

            return reply.type('text/xml').send(twimlResponse);
        } catch (error) {
            console.error('Incoming call error:', error);
            const twiml = new twilio.twiml.VoiceResponse();
            twiml.say('An error occurred. Please try again later.');
            twiml.hangup();
            return reply.type('text/xml').send(twiml.toString());
        }
    });

    // WebSocket route for media-stream
    fastify.register(async (fastify) => {
        fastify.get('/media-stream', { websocket: true }, (connection, req) => {
            console.log('Client connected');

            // Connection-specific state
            let streamSid = null;
            let latestMediaTimestamp = 0;
            let lastAssistantItem = null;
            let markQueue = [];
            let responseStartTimestampTwilio = null;

            const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    "OpenAI-Beta": "realtime=v1"
                }
            });

            // Handle incoming messages from Twilio
            connection.on('message', async (message) => {
                try {
                    const data = JSON.parse(message.toString());

                    switch (data.event) {
                        case 'start':
                            streamSid = data.start.streamSid;
                            console.log('Incoming stream started:', streamSid);
                            
                            // Update call status to in_progress using streamSid
                            const db = getDB();
                            try {
                                const result = await db.collection('calls').findOneAndUpdate(
                                    { 
                                        status: CALL_STATUS.ACTIVE,
                                        streamSid: { $exists: false }
                                    },
                                    { 
                                        $set: { 
                                            streamSid: streamSid,
                                            status: CALL_STATUS.ACTIVE,
                                            lastActive: new Date()
                                        } 
                                    },
                                    { sort: { startTime: -1 } }
                                );

                                if (result.value) {
                                    console.log('Call marked as in progress:', streamSid, 'for call ID:', result.value._id);
                                } else {
                                    console.error('No matching call found to mark as in progress');
                                }
                            } catch (err) {
                                console.error('Error updating call status:', err);
                            }
                            break;

                        case 'media':
                            latestMediaTimestamp = data.media.timestamp;
                            if (openAiWs.readyState === WebSocket.OPEN) {
                                const audioAppend = {
                                    type: 'input_audio_buffer.append',
                                    audio: data.media.payload
                                };
                                openAiWs.send(JSON.stringify(audioAppend));
                            }
                            break;

                        case 'mark':
                            if (markQueue.length > 0) {
                                markQueue.shift();
                            }
                            break;

                        default:
                            console.log('Received non-media event:', data.event);
                            break;
                    }
                } catch (error) {
                    console.error('Error processing message:', error);
                }
            });

            // Handle connection close
            connection.on('close', async () => {
                console.log('Client disconnected, ending call:', streamSid);
                if (streamSid) {
                    const db = getDB();
                    try {
                        const result = await db.collection('calls').findOneAndUpdate(
                            { 
                                streamSid: streamSid,
                                status: CALL_STATUS.ACTIVE
                            },
                            { 
                                $set: { 
                                    endTime: new Date(),
                                    status: CALL_STATUS.COMPLETED
                                } 
                            }
                        );

                        if (result.value) {
                            console.log('Call marked as completed:', streamSid, 'for call ID:', result.value._id);
                        } else {
                            console.error('No matching active call found with streamSid:', streamSid);
                        }
                    } catch (err) {
                        console.error('Error ending call:', err);
                        // If there's an error, try to mark the call as failed
                        try {
                            await db.collection('calls').updateOne(
                                { streamSid: streamSid },
                                { 
                                    $set: { 
                                        endTime: new Date(),
                                        status: CALL_STATUS.FAILED,
                                        error: err.message
                                    } 
                                }
                            );
                        } catch (updateErr) {
                            console.error('Error marking call as failed:', updateErr);
                        }
                    }
                }
                openAiWs.close();
            });

            // Control initial session with OpenAI
            openAiWs.on('open', () => {
                console.log('Connected to OpenAI WebSocket');
                const sessionUpdate = {
                    type: 'session.update',
                    session: {
                        turn_detection: { type: 'server_vad' },
                        input_audio_format: 'g711_ulaw',
                        output_audio_format: 'g711_ulaw',
                        voice: VOICE,
                        instructions: SYSTEM_MESSAGE,
                        modalities: ["text", "audio"],
                        temperature: 0.8,
                    }
                };
                console.log('Sending session update:', JSON.stringify(sessionUpdate));
                openAiWs.send(JSON.stringify(sessionUpdate));
            });

            // Handle OpenAI WebSocket messages
            openAiWs.on('message', (data) => {
                try {
                    const response = JSON.parse(data);

                    if (LOG_EVENT_TYPES.includes(response.type)) {
                        console.log(`Received event: ${response.type}`, response);
                    }

                    if (response.type === 'response.audio.delta' && response.delta) {
                        const audioDelta = {
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                        };
                        connection.send(JSON.stringify(audioDelta));

                        // First delta from a new response starts the elapsed time counter
                        if (!responseStartTimestampTwilio) {
                            responseStartTimestampTwilio = latestMediaTimestamp;
                        }

                        if (response.item_id) {
                            lastAssistantItem = response.item_id;
                        }
                        
                        sendMark(connection, streamSid);
                    }

                    if (response.type === 'input_audio_buffer.speech_started') {
                        handleSpeechStartedEvent();
                    }
                } catch (error) {
                    console.error('Error processing OpenAI message:', error);
                }
            });

            // Handle interruption when the caller's speech starts
            const handleSpeechStartedEvent = () => {
                if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                    const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;

                    if (lastAssistantItem) {
                        const truncateEvent = {
                            type: 'conversation.item.truncate',
                            item_id: lastAssistantItem,
                            content_index: 0,
                            audio_end_ms: elapsedTime
                        };
                        openAiWs.send(JSON.stringify(truncateEvent));
                    }

                    connection.send(JSON.stringify({
                        event: 'clear',
                        streamSid: streamSid
                    }));

                    // Reset
                    markQueue = [];
                    lastAssistantItem = null;
                    responseStartTimestampTwilio = null;
                }
            };

            // Send mark messages to track AI response playback
            const sendMark = (connection, streamSid) => {
                if (streamSid) {
                    const markEvent = {
                        event: 'mark',
                        streamSid: streamSid,
                        mark: { name: 'responsePart' }
                    };
                    connection.send(JSON.stringify(markEvent));
                    markQueue.push('responsePart');
                }
            };
        });
    });
}
