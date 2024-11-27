export const authenticate = async (request, reply) => {
    if (!request.session || !request.session.user) {
        const redirectTo = request.raw.url;
        return reply.redirect(`/login?redirect=${encodeURIComponent(redirectTo)}`);
    }
};
