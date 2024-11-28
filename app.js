// Load environment variables first
import './config/env.js';

import dotenv from 'dotenv';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyWs from '@fastify/websocket';
import fastifyFormbody from '@fastify/formbody';
import fastifyView from '@fastify/view';
import ejs from 'ejs';
import path from 'path';
import { fileURLToPath } from 'url';

// Import routes
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import paymentRoutes from './routes/payment.js';

// Import database connection
import { connectDB } from './config/db.js';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create Fastify instance
const fastify = Fastify({
    logger: true
});

// Register plugins
await fastify.register(fastifyCookie);
await fastify.register(fastifySession, {
    secret: process.env.SESSION_SECRET,
    cookie: {
        secure: process.env.NODE_ENV === 'production'
    }
});
await fastify.register(fastifyFormbody);
await fastify.register(fastifyWs);

// Register view engine
await fastify.register(fastifyView, {
    engine: {
        ejs: ejs
    },
    root: path.join(__dirname, 'views'),
    layout: '/layouts/main.ejs',
    propertyName: 'view'
});

// Register routes
await fastify.register(authRoutes);
await fastify.register(dashboardRoutes);
await fastify.register(paymentRoutes);
await fastify.register(import('./routes/call.js'));

// Add root route
fastify.get('/', async (request, reply) => {
    return reply.redirect('/dashboard');
});

// Start the server
const start = async () => {
    try {
        await connectDB();
        await fastify.listen({ 
            port: 5050, 
            host: '0.0.0.0',
            backlog: 511,
            maxRequestsPerSocket: 0 // Disable limit for WebSocket connections
        });
        console.log('Server is running on port 5050');
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
