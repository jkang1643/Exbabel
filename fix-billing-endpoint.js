#!/usr/bin/env node
/**
 * Fix billing.js subscription-checkout endpoint
 * Replaces direct subscription update with Customer Portal redirect
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'routes', 'billing.js');

console.log('Reading billing.js...');
let content = fs.readFileSync(filePath, 'utf8');

// The exact old code to replace (with proper indentation)
const oldCode = `        // 1. Look up the target plan and its Stripe price
        const { data: plan, error: planErr } = await supabaseAdmin
            .from('plans')
            .select('id, code, name, stripe_price_id')
            .eq('code', planCode)
            .single();

        if (planErr || !plan) {
            return res.status(400).json({ error: \`Invalid plan: \${planCode}\` });
        }

        if (!plan.stripe_price_id) {
            return res.status(400).json({ error: \`Plan \${planCode} has no Stripe price configured\` });
        }

        // 2. Get existing subscription from database
        const { data: sub, error: subErr } = await supabaseAdmin
            .from('subscriptions')
            .select('stripe_subscription_id, plan_id')
            .eq('church_id', churchId)
            .single();

        if (subErr || !sub?.stripe_subscription_id) {
            return res.status(400).json({ 
                error: 'No active subscription found. Please contact support.',
                code: 'NO_SUBSCRIPTION',
            });
        }

        // 3. Retrieve the subscription from Stripe
        const subscription = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);

        if (!subscription || subscription.status === 'canceled') {
            return res.status(400).json({ 
                error: 'Subscription is not active. Please contact support.',
                code: 'SUBSCRIPTION_INACTIVE',
            });
        }

        // 4. Update the subscription to the new price
        const updatedSubscription = await stripe.subscriptions.update(subscription.id, {
            items: [{
                id: subscription.items.data[0].id,
                price: plan.stripe_price_id,
            }],
            proration_behavior: 'create_prorations',  // Charge/credit the difference
            metadata: {
                church_id: churchId,
                plan_code: planCode,
                upgraded_at: new Date().toISOString(),
            },
        });

        console.log(\`[Billing] ✓ Subscription updated: church=\${churchId} plan=\${planCode} sub=\${subscription.id}\`);

        // Webhook will fire (customer.subscription.updated) and update the database
        // Return success immediately
        res.json({ 
            success: true, 
            plan: planCode,
            message: \`Successfully upgraded to \${plan.name}\`,
        });`;

// The new code to insert
const newCode = `        // Get or create Stripe customer
        const customerId = await ensureStripeCustomer(churchId);

        // Redirect to Customer Portal for upgrade
        // Portal will show plan options and confirmation screen
        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: \`\${APP_BASE_URL}/billing\`,
        });

        console.log(\`[Billing] ✓ Portal session created for upgrade: church=\${churchId} target=\${planCode || 'unspecified'}\`);
        res.json({ url: session.url });`;

// Check if old code exists
if (!content.includes('// 1. Look up the target plan and its Stripe price')) {
    console.error('❌ Could not find old code to replace. File may already be updated.');
    process.exit(1);
}

// Do the replacement
console.log('Replacing subscription update logic with Portal redirect...');
content = content.replace(oldCode, newCode);

// Verify replacement worked
if (content.includes('// 1. Look up the target plan and its Stripe price')) {
    console.error('❌ Replacement failed - old code still present');
    process.exit(1);
}

if (!content.includes('billingPortal.sessions.create')) {
    console.error('❌ Replacement failed - new code not found');
    process.exit(1);
}

// Write back
console.log('Writing updated file...');
fs.writeFileSync(filePath, content, 'utf8');

console.log('✅ Successfully updated billing.js!');
console.log('');
console.log('Next steps:');
console.log('1. Configure Stripe Customer Portal (see walkthrough.md)');
console.log('2. Test with a trial user upgrade');
