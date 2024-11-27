// Import dependencies
import dotenv from 'dotenv';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyWs from '@fastify/websocket';
import fastifyView from '@fastify/view';
import fastifyFormbody from '@fastify/formbody';
import fastifySession from '@fastify/session';
import fastifySecureSession from '@fastify/secure-session';
import { MongoClient } from 'mongodb';
import twilio from 'twilio';
import ejs from 'ejs';
import bcrypt from 'bcrypt';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import { OpenAI } from 'openai';
import crypto from 'crypto';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
dotenv.config();

// Retrieve environment variables
const { 
    OPENAI_API_KEY, 
    MONGODB_URI, 
    TWILIO_ACCOUNT_SID, 
    TWILIO_AUTH_TOKEN, 
    TWILIO_VERIFY_SERVICE_SID
} = process.env;

if (!OPENAI_API_KEY || !MONGODB_URI || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
    console.error('Missing required environment variables. Please check your .env file.');
    process.exit(1);
}

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY
});

// Initialize Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize MongoDB
let db;
const connectDB = async () => {
    try {
        const client = await MongoClient.connect(MONGODB_URI);
        db = client.db('voice-ai');
        console.log('Connected to MongoDB');
    } catch (err) {
        console.error('MongoDB connection error:', err);
        process.exit(1);
    }
};

// Initialize Fastify with logger
const fastify = Fastify({
    logger: true
});

// Generate a secure key for sessions
const sessionKey = crypto.randomBytes(32);

// Register plugins
await fastify.register(fastifyCookie);
await fastify.register(fastifyWs);
await fastify.register(fastifyFormbody);

// Register session support
await fastify.register(fastifySession, {
    secret: sessionKey.toString('hex'),
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        path: '/'
    },
    saveUninitialized: false,
    rolling: true,
    expires: 1800000 // 30 minutes
});

// Register EJS as the template engine
await fastify.register(fastifyView, {
    engine: {
        ejs: ejs
    },
    root: path.join(__dirname, 'views'),
    layout: '/layouts/main.ejs',
    propertyName: 'view'
});

// Authentication decorator
fastify.decorate('authenticate', async (request, reply) => {
    if (!request.session.user) {
        return reply.redirect('/login');
    }
});

// Middleware to check user state for all routes
fastify.addHook('preHandler', async (request, reply) => {
    try {
        if (request.session.user) {
            const user = await db.collection('users').findOne({ email: request.session.user.email }) ||
                        await db.collection('pending_users').findOne({ email: request.session.user.email });
            request.user = user;
        }
    } catch (error) {
        request.log.error('Error in auth hook:', error);
    }
});

// Constants
const SYSTEM_MESSAGE = 'You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. Always stay positive, but work in a joke when appropriate and be as engaging as possible.';
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;
const SHOW_TIMING_MATH = false;
const LOG_EVENT_TYPES = ['error', 'warning'];

// Authentication Routes
fastify.get('/login', async (request, reply) => {
    if (request.session.user) {
        return reply.redirect('/dashboard');
    }
    return reply.view('login.ejs', { 
        title: 'Login',
        error: null,
        user: null
    });
});

fastify.post('/login', async (request, reply) => {
    const { email, password } = request.body;

    try {
        // Validate input
        if (!email || !password) {
            return reply.view('login.ejs', { 
                title: 'Login',
                error: 'Please provide both email and password',
                user: null
            });
        }

        // Check both collections for the user
        const user = await db.collection('users').findOne({ email }) || 
                    await db.collection('pending_users').findOne({ email });

        if (!user) {
            return reply.view('login.ejs', { 
                title: 'Login',
                error: 'Invalid email or password',
                user: null
            });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            return reply.view('login.ejs', { 
                title: 'Login',
                error: 'Invalid email or password',
                user: null
            });
        }

        // Set session data
        request.session.user = {
            email: user.email,
            verified: user.verified
        };

        // Redirect to dashboard
        return reply.redirect('/dashboard');

    } catch (error) {
        console.error('Login error:', error);
        return reply.view('login.ejs', { 
            title: 'Login',
            error: 'An error occurred during login. Please try again.',
            user: null
        });
    }
});

fastify.get('/logout', async (request, reply) => {
    // Destroy the session
    if (request.session) {
        request.session.destroy();
    }
    return reply.redirect('/login');
});

fastify.get('/signup', async (request, reply) => {
    if (request.session.user) {
        return reply.redirect('/dashboard');
    }
    return reply.view('signup.ejs', { 
        title: 'Sign Up',
        error: null,
        user: null
    });
});

fastify.post('/signup', async (request, reply) => {
    const { email, password, confirmPassword } = request.body;

    try {
        // Validate password match
        if (password !== confirmPassword) {
            return reply.view('signup.ejs', {
                title: 'Sign Up',
                error: 'Passwords do not match',
                user: null
            });
        }

        // Check if user already exists
        const existingUser = await db.collection('users').findOne({ email }) || 
                           await db.collection('pending_users').findOne({ email });
        
        if (existingUser) {
            return reply.view('signup.ejs', {
                title: 'Sign Up',
                error: 'Email already registered',
                user: null
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user in pending_users collection
        const newUser = {
            email,
            password: hashedPassword,
            verified: false,
            createdAt: new Date()
        };

        await db.collection('pending_users').insertOne(newUser);

        // Set session data
        request.session.user = {
            email: newUser.email,
            verified: newUser.verified
        };

        return reply.redirect('/dashboard');
    } catch (error) {
        request.log.error('Signup error:', error);
        return reply.view('signup.ejs', {
            title: 'Sign Up',
            error: 'An error occurred during signup',
            user: null
        });
    }
});

// Dashboard Routes
fastify.get('/dashboard', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
        const user = await db.collection('users').findOne({ email: request.session.user.email }) || 
                    await db.collection('pending_users').findOne({ email: request.session.user.email });
        
        if (!user) {
            request.session.destroy();
            return reply.redirect('/login');
        }

        return reply.view('dashboard.ejs', {
            title: 'Dashboard',
            email: user.email,
            phone: user.phone,
            name: user.name,
            verified: user.verified,
            error: null,
            success: null,
            user: user
        });
    } catch (error) {
        request.log.error('Dashboard error:', error);
        request.session.destroy();
        return reply.redirect('/login');
    }
});

fastify.post('/register-phone', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { phone, name } = request.body;
    
    try {
        // Check if phone is already registered
        const existingPhone = await db.collection('users').findOne({ phone });
        if (existingPhone) {
            const user = await db.collection('pending_users').findOne({ email: request.session.user.email }) ||
                        await db.collection('users').findOne({ email: request.session.user.email });
            return reply.view('dashboard.ejs', {
                title: 'Dashboard',
                email: user.email,
                phone: user.phone,
                name: user.name,
                verified: user.verified,
                error: 'This phone number is already registered',
                success: null,
                user: user
            });
        }

        // Send verification code
        await twilioClient.verify.v2.services(TWILIO_VERIFY_SERVICE_SID)
            .verifications.create({ to: phone, channel: 'sms' });

        // Update user's phone number and name in pending_users
        await db.collection('pending_users').updateOne(
            { email: request.session.user.email },
            { $set: { phone, name, verified: false } }
        );

        const updatedUser = await db.collection('pending_users').findOne({ email: request.session.user.email });
        return reply.view('dashboard.ejs', {
            title: 'Dashboard',
            email: request.session.user.email,
            phone,
            name,
            verified: false,
            error: null,
            success: 'Verification code sent to your phone',
            user: updatedUser
        });
    } catch (error) {
        request.log.error('Phone registration error:', error);
        const user = await db.collection('pending_users').findOne({ email: request.session.user.email }) ||
                    await db.collection('users').findOne({ email: request.session.user.email });
        return reply.view('dashboard.ejs', {
            title: 'Dashboard',
            email: user.email,
            phone: user.phone,
            name: user.name,
            verified: user.verified,
            error: 'Failed to send verification code',
            success: null,
            user: user
        });
    }
});

fastify.post('/verify-phone', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { code } = request.body;
    
    try {
        // Get user from pending_users
        const pendingUser = await db.collection('pending_users').findOne({ email: request.session.user.email });
        if (!pendingUser || !pendingUser.phone) {
            return reply.view('dashboard.ejs', {
                title: 'Dashboard',
                email: request.session.user.email,
                phone: null,
                name: null,
                verified: false,
                error: 'Please register your phone number first',
                success: null,
                user: pendingUser
            });
        }

        // Verify the code with Twilio
        const verification = await twilioClient.verify.v2
            .services(TWILIO_VERIFY_SERVICE_SID)
            .verificationChecks.create({ to: pendingUser.phone, code });

        if (verification.status === 'approved') {
            // Move user from pending_users to users collection
            const userData = { ...pendingUser, verified: true };
            delete userData._id; // Remove MongoDB _id to avoid conflicts
            
            await db.collection('users').insertOne(userData);
            await db.collection('pending_users').deleteOne({ email: request.session.user.email });

            // Update session with new verified status
            request.session.user = {
                email: userData.email,
                verified: true
            };

            return reply.view('dashboard.ejs', {
                title: 'Dashboard',
                email: userData.email,
                phone: userData.phone,
                name: userData.name,
                verified: true,
                error: null,
                success: 'Phone number verified successfully!',
                user: userData
            });
        } else {
            return reply.view('dashboard.ejs', {
                title: 'Dashboard',
                email: pendingUser.email,
                phone: pendingUser.phone,
                name: pendingUser.name,
                verified: false,
                error: 'Invalid verification code',
                success: null,
                user: pendingUser
            });
        }
    } catch (error) {
        console.error('Verification error:', error);
        const user = await db.collection('pending_users').findOne({ email: request.session.user.email });
        return reply.view('dashboard.ejs', {
            title: 'Dashboard',
            email: user.email,
            phone: user.phone,
            name: user.name,
            verified: false,
            error: 'Failed to verify phone number',
            success: null,
            user: user
        });
    }
});

// Root Route
fastify.get('/', async (request, reply) => {
    try {
        return reply.view('index.ejs', { 
            title: 'Welcome',
            user: request.user
        });
    } catch (error) {
        request.log.error('Landing page error:', error);
        reply.code(500).send({ error: 'Internal Server Error' });
    }
});

// Route for Twilio to handle incoming calls
fastify.all('/incoming-call', async (request, reply) => {
    const from = request.body?.From || request.query?.From;
    
    try {
        // Check if the phone number is registered and verified
        const user = await db.collection('users').findOne({ phone: from });
        
        if (!user || !user.verified) {
            const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                            <Response>
                                <Say>Sorry, this number is not registered or verified. Please register and verify your phone number first.</Say>
                                <Hangup /></Response>`;
            return reply.type('text/xml').send(twimlResponse);
        }

        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                            <Response>
                                <Say>Welcome back, ${user.name}! Please wait while we connect you to your personal A.I. companion.</Say>
                                <Pause length="1"/>
                                <Say>O.K. you can start talking!</Say>
                                <Connect>
                                    <Stream url="wss://${request.headers.host}/media-stream" />
                                </Connect>
                            </Response>`;
        reply.type('text/xml').send(twimlResponse);
    } catch (error) {
        console.error('Error in incoming-call:', error);
        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                            <Response>
                                <Say>Sorry, an error occurred. Please try again later.</Say>
                                <Hangup /></Response>`;
        reply.type('text/xml').send(twimlResponse);
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
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // Control initial session with OpenAI
        const initializeSession = () => {
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
        };

        // Send initial conversation item if AI talks first
        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'Greet the user with "Hello there! I am an AI voice assistant powered by Twilio and the OpenAI Realtime API. You can ask me for facts, jokes, or anything you can imagine. How can I help you?"'
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
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

        // Send mark messages to Media Streams so we know if and when AI response playback is finished
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

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
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
                        if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
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
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);

                        // Reset start and media timestamp on a new stream
                        responseStartTimestampTwilio = null; 
                        latestMediaTimestamp = 0;
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
                console.error('Error parsing message:', error, 'Raw message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

// Start the server
const start = async () => {
    try {
        await fastify.listen({ port: PORT });
        fastify.log.info(`Server is running on port ${PORT}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

// Connect to MongoDB and start server
try {
    await connectDB();
    await start();
} catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
}
