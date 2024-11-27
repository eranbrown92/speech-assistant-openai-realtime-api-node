import { getDB } from '../config/db.js';
import { authenticate } from '../middleware/auth.js';
import bcrypt from 'bcrypt';

export default async function dashboardRoutes(fastify) {
    fastify.get('/dashboard', {
        preHandler: authenticate
    }, async (request, reply) => {
        const db = getDB();
        try {
            const user = await db.collection('users').findOne({ email: request.session.user.email }) || 
                        await db.collection('pending_users').findOne({ email: request.session.user.email });
            
            if (!user) {
                return reply.redirect('/login');
            }

            // Calculate total minutes used from call history
            const calls = await db.collection('calls').find({ userEmail: user.email }).toArray();
            const minutesUsed = calls.reduce((total, call) => {
                if (call.endTime) {
                    const duration = (new Date(call.endTime) - new Date(call.startTime)) / 1000 / 60;
                    // Round up to 1 minute if less than 1 minute
                    return total + Math.max(1, duration);
                }
                return total;
            }, 0);

            const formattedMinutesUsed = Number(minutesUsed.toFixed(1));
            const availableMinutes = (user.availableMinutes || 0) - formattedMinutesUsed;
            
            return reply.view('dashboard.ejs', { 
                title: 'Dashboard',
                user: user,
                email: user.email,
                phone: user.phone,
                name: user.name,
                verified: user.verified,
                error: null,
                success: null,
                availableMinutes: Math.max(0, Math.round(availableMinutes)),
                minutesUsed: formattedMinutesUsed
            });
        } catch (error) {
            console.error('Dashboard error:', error);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    });

    fastify.get('/call-history', {
        preHandler: authenticate
    }, async (request, reply) => {
        const db = getDB();
        try {
            const calls = await db.collection('calls')
                .find({ userEmail: request.session.user.email })
                .sort({ startTime: -1 })
                .toArray();

            return reply.view('call-history.ejs', {
                title: 'Call History',
                calls: calls,
                user: request.session.user
            });
        } catch (error) {
            console.error('Call history error:', error);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    });

    fastify.get('/settings', {
        preHandler: authenticate
    }, async (request, reply) => {
        const db = getDB();
        try {
            const user = await db.collection('users').findOne({ email: request.session.user.email });
            
            if (!user) {
                return reply.redirect('/login');
            }

            return reply.view('settings.ejs', {
                title: 'Settings',
                user: user,
                error: null,
                success: null
            });
        } catch (error) {
            console.error('Settings error:', error);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    });

    fastify.post('/settings', {
        preHandler: authenticate
    }, async (request, reply) => {
        const db = getDB();
        const { name, currentPassword, newPassword, confirmPassword } = request.body;
        
        try {
            const user = await db.collection('users').findOne({ email: request.session.user.email });
            
            if (!user) {
                return reply.view('settings.ejs', {
                    title: 'Settings',
                    user: user,
                    error: 'User not found',
                    success: null
                });
            }

            // If current password is provided, verify it
            if (currentPassword) {
                const isValidPassword = await bcrypt.compare(currentPassword, user.password);
                if (!isValidPassword) {
                    return reply.view('settings.ejs', {
                        title: 'Settings',
                        user: user,
                        error: 'Current password is incorrect',
                        success: null
                    });
                }

                // Validate new password
                if (newPassword !== confirmPassword) {
                    return reply.view('settings.ejs', {
                        title: 'Settings',
                        user: user,
                        error: 'New passwords do not match',
                        success: null
                    });
                }
            }

            // Update user data
            const updateData = { name };
            if (newPassword) {
                updateData.password = await bcrypt.hash(newPassword, 10);
            }

            await db.collection('users').updateOne(
                { email: request.session.user.email },
                { $set: updateData }
            );

            return reply.view('settings.ejs', {
                title: 'Settings',
                user: { ...user, ...updateData },
                error: null,
                success: 'Settings updated successfully'
            });
        } catch (error) {
            console.error('Settings update error:', error);
            return reply.view('settings.ejs', {
                title: 'Settings',
                user: user,
                error: 'An error occurred while updating settings',
                success: null
            });
        }
    });
}
