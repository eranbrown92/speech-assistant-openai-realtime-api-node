import { stripe, PLANS, getMinutesFromPriceId } from '../config/stripe.js';
import { authenticate } from '../middleware/auth.js';
import { getDB } from '../config/db.js';

export default async function paymentRoutes(fastify) {
    // Serve pricing page
    fastify.get('/pricing', async (request, reply) => {
        const user = request.session.user;
        return reply.view('pricing.ejs', { 
            title: 'Pricing',
            user: user || null,
            stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
            redirectUrl: user ? null : '/login?redirect=/pricing',
            plans: PLANS
        });
    });

    // Create Stripe checkout session
    fastify.post('/create-checkout-session', {
        preHandler: authenticate
    }, async (request, reply) => {
        const { priceId } = request.body;
        
        try {
            // Validate price ID exists in our plans
            const plan = Object.values(PLANS).find(p => p.priceId === priceId);
            if (!plan) {
                return reply.status(400).send({ error: 'Invalid price ID' });
            }

            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price: priceId,
                    quantity: 1,
                }],
                mode: 'payment',
                success_url: `${request.protocol}://${request.hostname}:5050/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${request.protocol}://${request.hostname}:5050/pricing`,
                customer_email: request.session.user.email,
                metadata: {
                    userId: request.session.user.email,
                    minutes: plan.minutes.toString()
                }
            });

            return reply.send({ sessionId: session.id });
        } catch (error) {
            console.error('Stripe session creation error:', error);
            return reply.status(500).send({ error: 'Failed to create checkout session' });
        }
    });

    // Transactions page route
    fastify.get('/transactions', {
        preHandler: authenticate
    }, async (request, reply) => {
        try {
            const db = await getDB();
            const user = request.session.user;

            // Get user's purchase history from our database
            const userDoc = await db.collection('users').findOne(
                { email: user.email },
                { projection: { purchases: 1 } }
            );

            const transactions = userDoc?.purchases || [];

            // Sort transactions by date in descending order (newest first)
            transactions.sort((a, b) => new Date(b.date) - new Date(a.date));

            return reply.view('transactions.ejs', {
                title: 'Transaction History',
                user: user,
                transactions: transactions
            });
        } catch (error) {
            console.error('Error fetching transactions:', error);
            return reply.status(500).send({ 
                error: 'Failed to fetch transactions',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    });

    // Handle successful payment
    fastify.get('/payment-success', {
        preHandler: authenticate
    }, async (request, reply) => {
        const sessionId = request.query.session_id;
        const db = await getDB();
        
        try {
            const session = await stripe.checkout.sessions.retrieve(sessionId);
            
            // Verify payment status
            if (session.payment_status !== 'paid') {
                throw new Error('Payment not completed');
            }

            const minutes = parseInt(session.metadata.minutes, 10);
            
            // Store customer ID if it exists
            const updateData = {
                $inc: { availableMinutes: minutes },
                $push: {
                    purchases: {
                        date: new Date(),
                        minutes: minutes,
                        amount: session.amount_total / 100,
                        sessionId: sessionId,
                        status: 'completed',
                        receipt_url: session.receipt_url
                    }
                }
            };

            // Add Stripe customer ID if present
            if (session.customer) {
                updateData.$set = { stripeCustomerId: session.customer };
            }

            // Update user's available minutes and add purchase record
            await db.collection('users').updateOne(
                { email: request.session.user.email },
                updateData
            );

            // Update user session
            request.session.user.availableMinutes = (request.session.user.availableMinutes || 0) + minutes;
            if (session.customer) {
                request.session.user.stripeCustomerId = session.customer;
            }

            return reply.redirect('/dashboard?payment=success');
        } catch (error) {
            console.error('Payment processing error:', error);
            return reply.redirect('/dashboard?payment=error');
        }
    });

    // Webhook handler for async events
    fastify.post('/api/stripe/webhook', {
        config: {
            rawBody: true
        }
    }, async (request, reply) => {
        const sig = request.headers['stripe-signature'];
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

        try {
            const event = stripe.webhooks.constructEvent(request.rawBody, sig, webhookSecret);
            const db = getDB();

            switch (event.type) {
                case 'checkout.session.completed':
                    const session = event.data.object;
                    // Double-check it's paid
                    if (session.payment_status === 'paid') {
                        await db.collection('users').updateOne(
                            { email: session.metadata.userId },
                            { 
                                $inc: { availableMinutes: parseInt(session.metadata.minutes, 10) }
                            }
                        );
                    }
                    break;
                    
                case 'charge.failed':
                    const charge = event.data.object;
                    console.error('Payment failed:', charge.id);
                    break;
            }

            return reply.send({ received: true });
        } catch (err) {
            console.error('Webhook error:', err.message);
            return reply.status(400).send(`Webhook Error: ${err.message}`);
        }
    });
}
