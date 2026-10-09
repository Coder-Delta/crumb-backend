# Crumb API

## Setup

The API is organized into application middleware (`src/app.js`), process and database lifecycle (`src/server.js`), environment validation (`src/config/`), REST endpoints (`src/routes/`), shared middleware, models, and external-service integrations (`src/services/`).

1. Install Node.js 20+ and MongoDB (or use a MongoDB Atlas URI).
2. `cp .env.example .env` and set `MONGODB_URI` and a private `JWT_SECRET` of at least 32 characters. Keep `.env` private and out of version control.
3. `npm install`, then `npm run seed` to add demo restaurants, dishes, and accounts. Seeding refreshes Crumb demo records and preserves unrelated database records.
4. `npm run dev` starts the API at `http://localhost:5000`.

## Run the full stack with Docker

The project root has a Compose stack for the API, React/Nginx frontend, MongoDB, and RabbitMQ. Copy the root `.env.docker.example` to `.env.docker`, replace its local secrets, and from `backend/` run `npm run docker:up`. Browse at `http://localhost:8080`; the RabbitMQ management UI is at `http://localhost:15672`. Seed sample restaurants, foods, and demo accounts with `npm run docker:seed`. Stop containers with `npm run docker:down`; the named database and broker volumes are preserved. See the root README for the volume removal command.

## RabbitMQ payment event handling

The Razorpay webhook endpoint verifies the provider HMAC against the raw request body and publishes a small, normalized payment event to a durable RabbitMQ queue. It responds `202` only after RabbitMQ publisher confirmation. A separate worker applies `payment.captured` and `order.paid` events to MongoDB using an atomic, idempotent order update. Checkout signature verification remains synchronous so buyers receive an immediate result.

The broker declares durable event, five-second retry, and dead-letter queues. The consumer uses manual acknowledgements and prefetch; transient processing or broker failures retry up to five times, then the event is retained in `crumb.payment.dead-letter` for inspection. RabbitMQ reconnects automatically. The broker is not required to serve ordinary browsing, but the payment webhook returns an error if it cannot durably enqueue an event.

Local setup:

1. Copy the RabbitMQ URL and local-only credentials from `.env.example` into `.env` if needed.
2. Run `npm run rabbitmq:up` from `backend/`. The management UI is at `http://localhost:15672` with the configured local credentials.
3. Run `npm run dev`. Queue names are declared by the API/worker on connect; no manual queue creation is needed.
4. Inspect retries and dead-lettered messages in the management UI. `npm run rabbitmq:logs` follows broker logs; `npm run rabbitmq:down` stops the local broker while preserving its volume.

For production, provide a private `amqps://` RabbitMQ endpoint and credentials through the deployment secret manager. Use a managed/high-availability broker, restrict network access, monitor queue depth and dead-letter volume, and set an operational replay procedure before launch. Do not reuse the development credentials.

## Google sign-in

1. Create a **Web application** OAuth client in the Google Cloud Console, configure its consent/branding screen, and add the frontend origin to **Authorized JavaScript origins** (for local development, `http://localhost` and `http://localhost:5173`).
2. Set the same client ID as `GOOGLE_CLIENT_ID` in this backend's `.env` and `VITE_GOOGLE_CLIENT_ID` in `../frontend/.env`.
3. Restart both development servers after changing environment files. For production, add the production site origin to the OAuth client and configure both environment variables with that client ID.

The browser sends Google's ID credential to `POST /api/auth/google`. The API verifies its signature, audience, and verified email with Google's auth library before creating or linking a customer account. Existing admin accounts cannot be linked through Google sign-in.

Demo accounts: `hello@crumb.demo` / `crumb123`, admin `admin@crumb.demo` / `admin123`, and restaurant owner `owner@crumb.demo` / `owner123` (Little Sicily).
All API routes are under `/api`; health check: `/api/health`. Use `npm run check` to run backend syntax checks.

Checkout can request GPS permission in the browser, reverse-geocode coordinates to an editable address, and save the coordinate pin with the order. The default lookup uses OpenStreetMap Nominatim with a small in-memory cache and a one-request-per-second throttle. Set `NOMINATIM_USER_AGENT` to identify your deployed application and include a real contact before production use. Nominatim results are estimates and should be confirmed by the customer. The public Nominatim service has a maximum one-request-per-second policy; larger production traffic should use a commercial provider or self-hosted service. [Usage policy](https://operations.osmfoundation.org/policies/nominatim/), [reverse API](https://nominatim.org/release-docs/latest/api/Reverse/).

## Razorpay checkout

1. In the Razorpay Dashboard, enable **Test Mode** and generate a Key ID and Key Secret under **Account & Settings → API Keys**.
2. Add the values to `backend/.env` as `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. Add a webhook signing secret as `RAZORPAY_WEBHOOK_SECRET`. Keep both secrets only on the backend; the API sends just the Key ID to Checkout. Restart the API after changing `.env`.
3. Under **Account & Settings → Webhooks**, register `https://YOUR_PUBLIC_API/api/payments/razorpay/webhook`; select `payment.captured` and `order.paid`, and use the same webhook signing secret. Razorpay cannot reach localhost, so use an HTTPS tunnel for local webhook testing.
4. Enable automatic capture in Razorpay. The server creates the payment order, verifies Checkout's HMAC signature, confirms capture and amount against its own order total, and accepts webhook events only after validating their raw-body signature. The browser success callback alone never marks an order paid.
5. Keep Test Mode keys for development. Switch to live credentials only when the production domain, HTTPS webhook, and payment flow are ready. The API refuses to start if only one API key is present or the webhook secret is missing.

## Restaurant owners

At registration, choose **Sell food** and enter the restaurant name, cuisines, address, and business phone. Crumb creates the owner account and a restaurant profile in pending review; the restaurant stays hidden from customers until an admin approves it from **Admin → Restaurants**. Owners land on `/owner`, where they can build their menu while the review is pending and manage incoming orders after approval. Order status refreshes every 15 seconds and follows valid status transitions. Admins can also promote an existing customer account to restaurant owner and assign existing restaurants in the dashboard.

## Order notifications

Customers and restaurant owners receive authenticated Socket.IO notifications while signed in. Cash-on-delivery orders notify both parties immediately; online orders notify them only after Razorpay payment is verified or captured. Seller and admin order status changes notify the customer, and buyer cancellations notify the restaurant owner. Notifications are stored in MongoDB, shown in the header bell with unread counts, and remain available when a user signs back in. The Docker Nginx config proxies the Socket.IO connection as well as `/api`. These are in-app notifications; browser push while the app is closed is not configured.

Razorpay funds settle to the platform merchant account by default. Automatic split settlements to restaurant bank accounts are not enabled by this integration; that requires Razorpay Route/marketplace approval and onboarding each restaurant as a linked account.

# crumb-backend
