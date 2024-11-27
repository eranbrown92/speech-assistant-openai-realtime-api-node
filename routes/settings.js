import bcrypt from 'bcrypt';

export default async function settingsRoutes(fastify, options) {
    // Get settings page
    fastify.get('/', {
        preHandler: fastify.authenticate
    }, async (request, reply) => {
        try {
            const user = await fastify.mongo.db.collection('users').findOne({ _id: request.session.userId });
            return reply.view('settings', { 
                user,
                messages: { 
                    success: request.flash('success'),
                    error: request.flash('error')
                }
            });
        } catch (error) {
            console.error('Error fetching user settings:', error);
            request.flash('error', 'Failed to load settings');
            return reply.redirect('/dashboard');
        }
    });

    // Update settings
    fastify.post('/', {
        preHandler: fastify.authenticate
    }, async (request, reply) => {
        try {
            const { name, currentPassword, newPassword, confirmPassword } = request.body;
            const user = await fastify.mongo.db.collection('users').findOne({ _id: request.session.userId });

            // Update name
            const updates = { name };

            // Handle password change if requested
            if (newPassword) {
                // Verify current password
                const isValidPassword = await bcrypt.compare(currentPassword, user.password);
                if (!isValidPassword) {
                    request.flash('error', 'Current password is incorrect');
                    return reply.redirect('/settings');
                }

                // Verify password confirmation
                if (newPassword !== confirmPassword) {
                    request.flash('error', 'New passwords do not match');
                    return reply.redirect('/settings');
                }

                // Hash new password
                updates.password = await bcrypt.hash(newPassword, 10);
            }

            // Update user
            await fastify.mongo.db.collection('users').updateOne(
                { _id: request.session.userId },
                { $set: updates }
            );

            request.flash('success', 'Settings updated successfully');
            return reply.redirect('/settings');

        } catch (error) {
            console.error('Error updating settings:', error);
            request.flash('error', 'Failed to update settings');
            return reply.redirect('/settings');
        }
    });
}
