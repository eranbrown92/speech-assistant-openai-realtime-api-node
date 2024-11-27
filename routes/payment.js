import { stripe, getMinutesFromPriceId } from '../config/stripe.js';
import { authenticate } from '../middleware/auth.js';
import { getDB } from '../config/db.js';

export default async function paymentRoutes(fastify) {
    fastify.get('/pricing', async (request, reply) => {
        const user = request.session.user;
        return reply.view('pricing.ejs', { 
            title: 'Pricing',
            user: user || null,
            stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
            redirectUrl: user ? null : '/login?redirect=/pricing'
        });
    });

    fastify.post('/create-checkout-session', {
        preHandler: authenticate
    }, async (request, reply) => {
        const { priceId } = request.body;
        
        try {
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price: priceId,
                    quantity: 1,
                }],
                mode: 'payment',
                success_url: `${request.protocol}://${request.hostname}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${request.protocol}://${request.hostname}/pricing`,
                customer_email: request.session.user.email,
                metadata: {
                    userId: request.session.user.email
                }
            });

            return reply.send({ sessionId: session.id });
        } catch (error) {
            console.error('Stripe session creation error:', error);
            return reply.status(500).send({ error: 'Failed to create checkout session' });
        }
    });

    fastify.get('/payment-success', {
        preHandler: authenticate
    }, async (request, reply) => {
        const sessionId = request.query.session_id;
        const db = getDB();
        
        try {
            const session = await stripe.checkout.sessions.retrieve(sessionId);
            const minutes = getMinutesFromPriceId(session.line_items.data[0].price.id);
            
            // Update user's available minutes
            await db.collection('users').updateOne(
                { email: request.session.user.email },
                { 
                    $inc: { availableMinutes: minutes },
                    $push: {
                        purchases: {
                            date: new Date(),
                            minutes: minutes,
                            amount: session.amount_total / 100,
                            sessionId: sessionId
                        }
                    }
                }
            );

            return reply.redirect('/dashboard?payment=success');
        } catch (error) {
            console.error('Payment processing error:', error);
            return reply.redirect('/dashboard?payment=error');
        }
    });
}
