import bcrypt from 'bcrypt';
import { getDB } from '../config/db.js';

export default async function authRoutes(fastify) {
    fastify.get('/login', async (request, reply) => {
        if (request.session.user) {
            return reply.redirect('/dashboard');
        }
        return reply.view('login.ejs', {
            title: 'Login',
            error: null,
            redirectTo: request.query.redirect || '/dashboard',
            user: null
        });
    });

    fastify.post('/login', async (request, reply) => {
        const { email, password } = request.body;
        const redirectTo = request.body.redirectTo || '/dashboard';
        const db = getDB();

        try {
            const user = await db.collection('users').findOne({ email });
            if (!user || !(await bcrypt.compare(password, user.password))) {
                return reply.view('login.ejs', {
                    title: 'Login',
                    error: 'Invalid email or password',
                    redirectTo,
                    user: null
                });
            }

            request.session.user = { email: user.email };
            return reply.redirect(redirectTo);
        } catch (error) {
            console.error('Login error:', error);
            return reply.view('login.ejs', {
                title: 'Login',
                error: 'An error occurred during login',
                redirectTo,
                user: null
            });
        }
    });

    fastify.get('/logout', async (request, reply) => {
        request.session.destroy();
        return reply.redirect('/login');
    });
}
