import Stripe from 'stripe';

if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY environment variable is required');
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const STRIPE_PRODUCTS = {
    '1_HOUR': 'price_1_hour_id',
    '3_HOURS': 'price_3_hours_id',
    '5_HOURS': 'price_5_hours_id'
};

export const getMinutesFromPriceId = (priceId) => {
    switch(priceId) {
        case STRIPE_PRODUCTS['1_HOUR']:
            return 60;
        case STRIPE_PRODUCTS['3_HOURS']:
            return 180;
        case STRIPE_PRODUCTS['5_HOURS']:
            return 300;
        default:
            return 0;
    }
};
