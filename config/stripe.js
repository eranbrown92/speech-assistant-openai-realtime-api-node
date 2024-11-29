import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY environment variable is required');
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Price configuration (amounts in cents)
export const PLANS = {
    ONE_HOUR: {
        name: '1 Hour',
        minutes: 60,
        price: 9000, // $90
        priceId: process.env.STRIPE_PRICE_1_HOUR
    },
    THREE_HOURS: {
        name: '3 Hours',
        minutes: 180,
        price: 24000, // $240
        priceId: process.env.STRIPE_PRICE_3_HOURS
    },
    FIVE_HOURS: {
        name: '5 Hours',
        minutes: 300,
        price: 36000, // $360
        priceId: process.env.STRIPE_PRICE_5_HOURS
    }
};

export const getMinutesFromPriceId = (priceId) => {
    const plan = Object.values(PLANS).find(p => p.priceId === priceId);
    return plan ? plan.minutes : 0;
};

export const getPriceDetails = async () => {
    try {
        const prices = await Promise.all(
            Object.values(PLANS).map(plan => 
                stripe.prices.retrieve(plan.priceId)
            )
        );
        return prices;
    } catch (error) {
        console.error('Error fetching Stripe prices:', error);
        throw error;
    }
};
