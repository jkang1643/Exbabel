#!/usr/bin/env python3
"""Fix billing.js subscription-checkout endpoint to use Portal redirect"""

import sys

# Read the file
with open('backend/routes/billing.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find the start and end of the function body to replace
start_idx = None
end_idx = None

for i, line in enumerate(lines):
    if '// 1. Look up the target plan and its Stripe price' in line:
        start_idx = i
    if start_idx is not None and 'message: `Successfully upgraded to ${plan.name}`,' in line:
        # Find the closing of res.json
        for j in range(i, min(i+5, len(lines))):
            if '});' in lines[j]:
                end_idx = j + 1
                break
        break

if start_idx is None or end_idx is None:
    print(f"Could not find replacement boundaries: start={start_idx}, end={end_idx}")
    sys.exit(1)

print(f"Replacing lines {start_idx+1} to {end_idx+1}")

# New code to insert
new_code = """        // Get or create Stripe customer
        const customerId = await ensureStripeCustomer(churchId);

        // Redirect to Customer Portal for upgrade
        // Portal will show plan options and confirmation screen
        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${APP_BASE_URL}/billing`,
        });

        console.log(`[Billing] ✓ Portal session created for upgrade: church=${churchId} target=${planCode || 'unspecified'}`);
        res.json({ url: session.url });
"""

# Build new file
new_lines = lines[:start_idx] + [new_code] + lines[end_idx:]

# Write back
with open('backend/routes/billing.js', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print("✓ Successfully updated billing.js")
