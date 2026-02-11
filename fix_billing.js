const fs = require('fs');

// Read the file
const content = fs.readFileSync('backend/routes/billing.js', 'utf8');
const lines = content.split('\n');

// Find the lines to replace
let startIdx = -1;
let endIdx = -1;

for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('// 1. Look up the target plan and its Stripe price')) {
        startIdx = i;
    }
    if (startIdx !== -1 && lines[i].includes('message: `Successfully upgraded to ${plan.name}`,')) {
        // Find the closing });
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
            if (lines[j].includes('});')) {
                endIdx = j + 1;
                break;
            }
        }
        break;
    }
}

if (startIdx === -1 || endIdx === -1) {
    console.error(`Could not find replacement boundaries: start=${startIdx}, end=${endIdx}`);
    process.exit(1);
}

console.log(`Replacing lines ${startIdx + 1} to ${endIdx + 1}`);

// New code
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

// Build new content
const newLines = [
    ...lines.slice(0, startIdx),
    newCode,
    ...lines.slice(endIdx)
];

// Write back
fs.writeFileSync('backend/routes/billing.js', newLines.join('\n'), 'utf8');

console.log('✓ Successfully updated billing.js');
