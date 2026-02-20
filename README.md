# Support-Base (KEEL API)

Pioneer Feeders customer support backend. Powers the SupportBase + Resolve mobile app.

## What This Does

- **Customer Lookup** — Search Shopify customers by phone, email, name, or order number
- **Order Actions** — Process reships (draft order + 100% discount) and refunds via Shopify API
- **Ticket Management** — Track support tickets across Amazon, Shopify, phone, and text channels
- **Analytics** — DOA rates by channel, reship costs by week/month, refund totals
- **Webhooks** — Receive Quo calls/texts, auto-lookup caller in Shopify, push notifications to app

## Tech Stack

- Node.js + Express
- PostgreSQL via Prisma ORM
- Shopify Admin API
- Expo Push Notifications
- Hosted on Railway

## Setup

### 1. Clone & Install
```bash
git clone https://github.com/pioneerfeeders/Support-Base.git
cd Support-Base
npm install
```

### 2. Environment Variables
```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Database
```bash
npx prisma migrate dev --name init
```

### 4. Run
```bash
npm run dev
```

### 5. Create Admin Account
```bash
curl -X POST http://localhost:3000/api/v1/auth/setup \
  -H "Content-Type: application/json" \
  -d '{"name":"Your Name","email":"admin@pioneerfeeders.com","password":"your-password"}'
```

## Railway Deployment

1. Create new project on Railway
2. Add PostgreSQL database
3. Connect GitHub repo (pioneerfeeders/Support-Base)
4. Set environment variables:
   - `DATABASE_URL` (auto-set by Railway PostgreSQL)
   - `JWT_SECRET`
   - `SHOPIFY_STORE` = pioneer-feeders.myshopify.com
   - `SHOPIFY_ACCESS_TOKEN`
   - `NODE_ENV` = production

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/v1/auth/setup | Create first admin |
| POST | /api/v1/auth/login | Login → JWT |
| GET | /api/v1/customers/search?q= | Search Shopify customers |
| GET | /api/v1/customers/:id/orders | Customer order history |
| GET | /api/v1/orders/:id | Order detail |
| POST | /api/v1/orders/:id/reship | Create reship |
| POST | /api/v1/orders/:id/refund | Process refund |
| GET | /api/v1/tickets | List tickets |
| GET | /api/v1/tickets/:id | Ticket detail |
| POST | /api/v1/tickets/:id/messages | Reply to ticket |
| GET | /api/v1/analytics/overview | Dashboard stats |
| GET | /api/v1/analytics/doa-by-channel | DOA rate by channel |
| GET | /api/v1/analytics/reship-costs | Weekly reship costs |
| GET | /api/v1/analytics/refund-totals | Weekly refund totals |
| POST | /api/v1/webhooks/quo | Quo call/text webhook |
