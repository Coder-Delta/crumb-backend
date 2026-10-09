# Crumb API

## Setup
1. Install Node.js 20+ and MongoDB (or use a MongoDB Atlas URI).
2. `cp .env.example .env` and set `MONGODB_URI` and a private `JWT_SECRET`.
3. `npm install`, then `npm run seed` to add demo restaurants, dishes, and accounts. Seeding refreshes Crumb demo records and preserves unrelated database records.
4. `npm run dev` starts the API at `http://localhost:5000`.

## Google sign-in
1. Create a **Web application** OAuth client in the Google Cloud Console, configure its consent/branding screen, and add the frontend origin to **Authorized JavaScript origins** (for local development, `http://localhost` and `http://localhost:5173`).
2. Set the same client ID as `GOOGLE_CLIENT_ID` in this backend's `.env` and `VITE_GOOGLE_CLIENT_ID` in `../frontend/.env`.
3. Restart both development servers after changing environment files. For production, add the production site origin to the OAuth client and configure both environment variables with that client ID.

The browser sends Google's ID credential to `POST /api/auth/google`. The API verifies its signature, audience, and verified email with Google's auth library before creating or linking a customer account. Existing admin accounts cannot be linked through Google sign-in.

Demo accounts: `hello@crumb.demo` / `crumb123` and admin `admin@crumb.demo` / `admin123`.
All API routes are under `/api`; health check: `/api/health`.

Checkout can request GPS permission in the browser, reverse-geocode coordinates to an editable address, and save the coordinate pin with the order. The default lookup uses OpenStreetMap Nominatim with a small in-memory cache and a one-request-per-second throttle. Set `NOMINATIM_USER_AGENT` to identify your deployed application and include a real contact before production use. Nominatim results are estimates and should be confirmed by the customer. The public Nominatim service has a maximum one-request-per-second policy; larger production traffic should use a commercial provider or self-hosted service. [Usage policy](https://operations.osmfoundation.org/policies/nominatim/), [reverse API](https://nominatim.org/release-docs/latest/api/Reverse/).

Checkout persists orders and supports cash on delivery. The `card` payment selection is only stored as a demo choice; no payment is collected. Add a payment provider such as Razorpay or Stripe before accepting online payments.
# crumb-backend
