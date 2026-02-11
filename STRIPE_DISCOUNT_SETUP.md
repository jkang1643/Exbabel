# Stripe 50% Discount & Cancellation Setup Guide

## 1. Create 50% Off Coupon in Stripe

### Steps:
1. Go to [Stripe Dashboard → Products → Coupons](https://dashboard.stripe.com/coupons)
2. Click **"Create coupon"**
3. Configure:
   - **Name**: `50% Off Launch Promotion`
   - **ID**: `LAUNCH50` (or any ID you prefer)
   - **Type**: `Percentage`
   - **Percent off**: `50`
   - **Duration**: Choose one:
     - `Forever` - 50% off every billing cycle (most generous)
     - `Once` - 50% off first payment only
     - `Repeating` - 50% off for X months
   - **Applies to**: `Specific products` → Select your Starter, Pro, and Unlimited products
4. Click **"Create coupon"**
5. Copy the **Coupon ID** (e.g., `LAUNCH50`)

### Add to Environment Variables:
```bash
# backend/.env
STRIPE_50_PERCENT_COUPON_ID=LAUNCH50
```

---

## 2. Enable Subscription Cancellation in Customer Portal

### Steps:
1. Go to [Stripe Dashboard → Settings → Customer Portal](https://dashboard.stripe.com/settings/billing/portal)
2. Scroll to **"Subscription cancellation"**
3. Toggle **ON** "Allow customers to cancel subscriptions"
4. Configure cancellation behavior:
   - **Cancellation mode**: Choose one:
     - `Cancel immediately` - Access revoked instantly
     - `Cancel at period end` - Access until current billing period ends (recommended)
   - **Cancellation reasons**: Enable to collect feedback
   - **Save cancellation reasons**: Toggle ON to track why users cancel
5. Click **"Save changes"**

### What This Enables:
- Users clicking "Manage Billing" will see a **"Cancel plan"** button in the Stripe portal
- When canceled, Stripe fires `customer.subscription.deleted` webhook
- Our webhook handler automatically demotes all church members to `member` role

---

## 3. Test the Features

### Test 50% Discount:
1. Start a new incognito session
2. Navigate to `/checkout?plan=starter`
3. Complete signup and church creation
4. On Stripe checkout page, you should see:
   - Original price: `$X.XX/month`
   - **Discount (LAUNCH50): -50%**
   - Total: `$Y.YY/month` (half price)
5. Optionally enter a 15% promo code to stack discounts

### Test Cancellation:
1. As an admin, go to `/billing`
2. Click **"Manage Billing"**
3. In Stripe portal, click **"Cancel plan"**
4. Confirm cancellation
5. Verify:
   - Webhook fires `customer.subscription.deleted`
   - Backend logs show role demotion
   - User is now a `member` (check `/billing` - should show "No active subscription")

---

## 4. Stacking Discounts (15% Promo Code)

If you want to offer an **additional 15% off** on top of the 50%:

### Create 15% Promo Code:
1. Go to [Stripe Dashboard → Products → Promotion codes](https://dashboard.stripe.com/promotion_codes)
2. Click **"Create promotion code"**
3. Configure:
   - **Coupon**: Create new → `15% Off` → `15` percent
   - **Code**: `EARLY15` (or custom code)
   - **Active**: Toggle ON
   - **Applies to**: Same products as 50% coupon
4. Click **"Create promotion code"**

### How It Works:
- 50% discount is **automatically applied** at checkout
- User can **manually enter** `EARLY15` in the promo code field
- Stripe calculates: `Original Price × 0.5 × 0.85 = 42.5% of original price`
- **Total discount: 57.5% off**

---

## Environment Variables Summary

Add to `backend/.env`:
```env
# Stripe 50% discount coupon ID
STRIPE_50_PERCENT_COUPON_ID=LAUNCH50
```

Restart your backend after adding the variable.
