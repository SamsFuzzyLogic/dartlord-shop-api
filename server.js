/**
 * Jeezy Darts — Shop API
 * Handles: Stripe checkout sessions, Printify order fulfillment
 * Deploy: On Linode alongside Pool Peers (PM2 + Nginx)
 *
 * Flow:
 *   1. Customer adds items to cart on drip.html
 *   2. drip.html POSTs cart to /api/shop/checkout
 *   3. This server creates a Stripe Checkout session
 *   4. Customer completes payment on Stripe's hosted page
 *   5. Stripe fires webhook → /api/shop/webhook
 *   6. This server creates order in Printify API
 *   7. Printify prints + ships to customer
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.SHOP_PORT || 3030;

// ── Config ──
const PRINTIFY_API = 'https://api.printify.com/v1';
const PRINTIFY_TOKEN = process.env.PRINTIFY_TOKEN;
const PRINTIFY_SHOP_ID = process.env.PRINTIFY_SHOP_ID;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://drip.dartlord.com';

// ── Middleware ──
// Webhook needs raw body, everything else gets JSON
app.post('/api/shop/webhook', express.raw({ type: 'application/json' }), handleWebhook);
app.use(express.json());
app.use(cors({
  origin: [FRONTEND_URL, 'http://localhost:8080'],
  methods: ['GET', 'POST'],
}));

// ── Product Cache ──
let productCache = null;
let cacheTime = 0;
const CACHE_TTL = 300000; // 5 minutes

// ════════════════════════════════
// GET /api/shop/products
// Returns product catalog from Printify
// ════════════════════════════════
app.get('/api/shop/products', async (req, res) => {
  try {
    const now = Date.now();
    if (productCache && (now - cacheTime) < CACHE_TTL) {
      return res.json(productCache);
    }

    const response = await fetch(`${PRINTIFY_API}/shops/${PRINTIFY_SHOP_ID}/products.json`, {
      headers: { 'Authorization': `Bearer ${PRINTIFY_TOKEN}` }
    });

    if (!response.ok) throw new Error(`Printify API error: ${response.status}`);
    const data = await response.json();

    // Transform for frontend
    const products = data.data.map(p => {
      const firstVariant = p.variants?.find(v => v.is_enabled) || p.variants?.[0];
      const price = firstVariant?.price ? (firstVariant.price / 100).toFixed(2) : '0.00';
      const image = p.images?.find(i => i.is_default)?.src || p.images?.[0]?.src || '';

      return {
        id: p.id,
        title: p.title,
        description: p.description?.replace(/<[^>]*>/g, '').slice(0, 200) || '',
        price,
        image,
      variants: p.variants?.filter(v => v.is_enabled).map(v => {
      // Find images that match this variant
      const variantImages = p.images?.filter(img => img.variant_ids?.includes(v.id)) || [];
      const variantImage = variantImages.find(i => i.is_default) || variantImages[0];
      return {
        id: v.id,
        title: v.title,
        price: (v.price / 100).toFixed(2),
        options: v.options || {},
        image: variantImage?.src || null,
      };
    }) || [],
      };
    });

    productCache = products;
    cacheTime = now;
    res.json(products);
  } catch (err) {
    console.error('[Shop] Products fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// ════════════════════════════════
// GET /api/shop/product/:id
// Returns single product with all variants
// ════════════════════════════════
app.get('/api/shop/product/:id', async (req, res) => {
  try {
    const response = await fetch(
      `${PRINTIFY_API}/shops/${PRINTIFY_SHOP_ID}/products/${req.params.id}.json`,
      { headers: { 'Authorization': `Bearer ${PRINTIFY_TOKEN}` } }
    );

    if (!response.ok) throw new Error(`Printify API error: ${response.status}`);
    const p = await response.json();

    const product = {
      id: p.id,
      title: p.title,
      sku: v.sku,
      description: p.description?.replace(/<[^>]*>/g, '') || '',
      images: p.images?.map(i => ({ src: i.src, is_default: i.is_default, variant_ids: i.variant_ids })) || [],
      variants: p.variants?.filter(v => v.is_enabled).map(v => ({
        id: v.id,
        title: v.title,
        price: (v.price / 100).toFixed(2),
        options: v.options || {},
        is_available: v.is_available,
      })) || [],
      options: p.options || [],
      tags: p.tags || [],
    };

    res.json(product);
  } catch (err) {
    console.error('[Shop] Product fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// ════════════════════════════════
// POST /api/shop/checkout
// Creates Stripe Checkout session
// Body: { items: [{ product_id, variant_id, title, price, quantity, image }] }
// ════════════════════════════════
app.post('/api/shop/checkout', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !items.length) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Validate items against Printify prices (prevent price tampering)
    const validatedItems = [];
    for (const item of items) {
      const pfResponse = await fetch(
        `${PRINTIFY_API}/shops/${PRINTIFY_SHOP_ID}/products/${item.product_id}.json`,
        { headers: { 'Authorization': `Bearer ${PRINTIFY_TOKEN}` } }
      );

      if (!pfResponse.ok) throw new Error(`Invalid product: ${item.product_id}`);
      const pfProduct = await pfResponse.json();
      const variant = pfProduct.variants.find(v => v.id === item.variant_id);
      if (!variant) throw new Error(`Invalid variant: ${item.variant_id}`);

      validatedItems.push({
        product_id: item.product_id,
        variant_id: item.variant_id,
        title: pfProduct.title,
        variant_title: variant.title,
        price: variant.price, // Price in cents from Printify
        quantity: Math.min(Math.max(1, item.quantity || 1), 10),
        image: item.image || '',
      });
    }

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'NL', 'IE'],
      },
      line_items: validatedItems.map(item => ({
        price_data: {
          currency: 'usd',
          product_data: {
            name: item.title,
            description: item.variant_title,
            images: item.image ? [item.image] : [],
          },
          unit_amount: item.price, // Already in cents from Printify
        },
        quantity: item.quantity,
      })),
      metadata: {
        // Store cart info for webhook to create Printify order
        cart: JSON.stringify(validatedItems.map(i => ({
          pid: i.product_id,
          vid: i.variant_id,
          qty: i.quantity,
        }))),
      },
      success_url: `${FRONTEND_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/?checkout=cancelled`,
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[Shop] Checkout error:', err.message);
    res.status(500).json({ error: err.message || 'Checkout failed' });
  }
});

// ════════════════════════════════
// POST /api/shop/webhook
// Stripe webhook — creates Printify order on successful payment
// ════════════════════════════════
async function handleWebhook(req, res) {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Shop] Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('[Shop] Payment successful:', session.id);

    try {
      // Get shipping details from Stripe session
      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['shipping_details'],
      });

      const shipping = fullSession.shipping_details || fullSession.customer_details;
      const cart = JSON.parse(session.metadata.cart);

      // Create order in Printify
      const orderPayload = {
        external_id: session.id,
        label: `JEEZ-${session.id.slice(-8).toUpperCase()}`,
        line_items: cart.map(item => ({
          product_id: item.pid,
          variant_id: item.vid,
          quantity: item.qty,
        })),
        shipping_method: 1, // Standard shipping
        send_shipping_notification: true,
        address_to: {
          first_name: shipping.name?.split(' ')[0] || 'Customer',
          last_name: shipping.name?.split(' ').slice(1).join(' ') || '',
          email: fullSession.customer_details?.email || '',
          phone: shipping.phone || '',
          address1: shipping.address?.line1 || '',
          address2: shipping.address?.line2 || '',
          city: shipping.address?.city || '',
          region: shipping.address?.state || '',
          zip: shipping.address?.postal_code || '',
          country: shipping.address?.country || 'US',
        },
      };

      const pfResponse = await fetch(
        `${PRINTIFY_API}/shops/${PRINTIFY_SHOP_ID}/orders.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${PRINTIFY_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(orderPayload),
        }
      );

      if (!pfResponse.ok) {
        const errData = await pfResponse.text();
        console.error('[Shop] Printify order creation failed:', errData);
      } else {
        const order = await pfResponse.json();
        console.log('[Shop] Printify order created:', order.id);
      }
    } catch (err) {
      console.error('[Shop] Order fulfillment error:', err.message);
      // Payment succeeded but order failed — log for manual handling
      // TODO: Store in Supabase for retry queue
    }
  }

  res.json({ received: true });
}

// ════════════════════════════════
// GET /api/shop/order-status/:sessionId
// Check order status after checkout
// ════════════════════════════════
app.get('/api/shop/order-status/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    res.json({
      status: session.payment_status,
      email: session.customer_details?.email,
    });
  } catch (err) {
    res.status(404).json({ error: 'Session not found' });
  }
});

// ── Health Check ──
app.get('/api/shop/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[Shop API] Running on port ${PORT}`);
  console.log(`[Shop API] Webhook: POST /api/shop/webhook`);
  console.log(`[Shop API] Products: GET /api/shop/products`);
  console.log(`[Shop API] Checkout: POST /api/shop/checkout`);
});
