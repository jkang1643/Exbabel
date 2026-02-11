/**
 * CheckoutPage — Premium plan selection & checkout entry point
 * 
 * Flow (account-before-payment):
 *   1. /checkout → shows plan selection (public, no auth required)
 *   2. /checkout?plan=starter → if signed in + church → auto-checkout
 *   3. Click plan button → redirect to signup if needed → back to checkout
 *   4. Signed in + church → POST /api/billing/checkout-session → Stripe
 *   5. Already admin? → redirect to /billing
 */

import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Header } from './Header';

const API_URL = import.meta.env.VITE_API_URL || '';

const PLANS = [
    {
        code: 'starter',
        name: 'Starter',
        image: '/starter%20plan.png',
        originalPrice: 45,
        discountedPrice: 22.50,
        description: 'Everything you need to start translating live services',
        features: [
            { text: '6 hrs/mo live + 10 hrs solo', icon: '🎙️' },
            { text: '60 natural voices', icon: '🔊' },
            { text: '200+ languages', icon: '🌐' },
            { text: '3 languages at once', icon: '🔀' },
            { text: 'Email & phone support', icon: '📧' },
            { text: '30-day free trial', icon: '🎁' },
        ],
        cta: 'Start Free Trial',
        gradient: 'from-emerald-500 to-teal-600',
        accentColor: '#10b981',
        highlight: false,
        badge: '🎁 30-DAY FREE TRIAL',
    },
    {
        code: 'pro',
        name: 'Pro',
        image: '/pro.jpg',
        originalPrice: 100,
        discountedPrice: 50,
        description: 'More hours, more voices, faster translation',
        features: [
            { text: '12 hrs/mo live + 20 hrs solo', icon: '🎙️' },
            { text: '90 premium AI voices', icon: '🔊' },
            { text: '250+ languages & dialects', icon: '🌐' },
            { text: '5 languages at once', icon: '🔀' },
            { text: '50% faster translation', icon: '⚡' },
            { text: '24/7 support', icon: '📧' },
        ],
        cta: 'Get Pro',
        gradient: 'from-blue-500 to-indigo-600',
        accentColor: '#3b82f6',
        highlight: true,
    },
    {
        code: 'unlimited',
        name: 'Unlimited',
        image: '/unlimited.jpg',
        originalPrice: 300,
        discountedPrice: 150,
        description: 'No limits. World-class voices. White-glove service.',
        features: [
            { text: 'Unlimited live & solo hours', icon: '🎙️' },
            { text: 'Studio-grade lifelike voices', icon: '🔊' },
            { text: '250+ languages & dialects', icon: '🌐' },
            { text: 'Unlimited simultaneous languages', icon: '🔀' },
            { text: 'Fastest translation speed', icon: '⚡' },
            { text: '24/7 priority + personal onboarding', icon: '📧' },
            { text: 'Custom branding & voice cloning', icon: '💎' },
        ],
        cta: 'Go Unlimited',
        gradient: 'from-purple-500 to-violet-600',
        accentColor: '#8b5cf6',
        highlight: false,
    },
];

export function CheckoutPage() {
    const { isAuthenticated, isAdmin, hasChurch, loading, getAccessToken, signOut } = useAuth();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    const [redirecting, setRedirecting] = useState(false);
    const [selectedPlan, setSelectedPlan] = useState(null);
    const [error, setError] = useState(null);

    const plan = searchParams.get('plan');

    // Smart router: ONLY auto-redirect if a plan parameter is present
    // Otherwise, show the normal plan selection UI
    useEffect(() => {
        if (loading) return;

        // No plan parameter → show normal UI (user is browsing plans)
        if (!plan) {
            return;
        }

        // Invalid plan → redirect to checkout without params
        if (!PLANS.find(p => p.code === plan)) {
            console.warn('[Checkout] Invalid plan specified:', plan);
            navigate('/checkout', { replace: true });
            return;
        }

        // Plan parameter present → act as smart router

        // Already admin → go to billing (treat as upgrade/downgrade)
        if (isAdmin) {
            console.log('[Checkout] User is already admin, redirecting to billing');
            navigate('/billing', { replace: true });
            return;
        }

        // Not authenticated → redirect to signup with return URL
        if (!isAuthenticated) {
            const returnUrl = `/checkout?plan=${plan}`;
            console.log('[Checkout] Not authenticated, redirecting to signup');
            navigate(`/signup?redirect=${encodeURIComponent(returnUrl)}`, { replace: true });
            return;
        }

        // Authenticated but no church → redirect to create church
        if (!hasChurch) {
            const returnUrl = `/checkout?plan=${plan}`;
            console.log('[Checkout] No church, redirecting to create church');
            navigate(`/create-church?redirect=${encodeURIComponent(returnUrl)}`, { replace: true });
            return;
        }

        // Authenticated with church → auto-initiate Stripe checkout
        console.log('[Checkout] Ready to checkout, initiating Stripe session');
        handleCheckout(plan);
    }, [loading, isAuthenticated, isAdmin, hasChurch, plan, navigate]);


    async function handleCheckout(planCode) {
        try {
            setRedirecting(true);
            setSelectedPlan(planCode);
            setError(null);

            // Not signed in → redirect to signup with plan in return URL
            if (!isAuthenticated) {
                const returnUrl = `/checkout?plan=${planCode}`;
                navigate(`/signup?redirect=${encodeURIComponent(returnUrl)}`);
                return;
            }

            // Signed in but no church → redirect to create church
            if (!hasChurch) {
                const returnUrl = `/checkout?plan=${planCode}`;
                navigate(`/create-church?redirect=${encodeURIComponent(returnUrl)}`);
                return;
            }

            const token = getAccessToken();
            if (!token) {
                console.error('[Checkout] No access token available');
                navigate('/signup', { replace: true });
                return;
            }

            const res = await fetch(`${API_URL}/api/billing/checkout-session`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ plan: planCode }),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                if (data.code === 'ALREADY_SUBSCRIBED') {
                    navigate('/billing', { replace: true });
                    return;
                }
                throw new Error(data.error || 'Failed to start checkout');
            }

            const data = await res.json();
            if (data.url) {
                console.log('[Checkout] Redirecting to Stripe:', data.url);
                window.location.href = data.url;
            }
        } catch (err) {
            console.error('[Checkout] Error:', err);
            setError(err.message);
            setRedirecting(false);
            setSelectedPlan(null);
        }
    }

    // Loading state
    if (loading) {
        return (
            <div style={styles.page}>
                <Header onSignOut={signOut} />
                <div style={styles.loadingContainer}>
                    <div style={styles.spinner} />
                    <p style={styles.loadingText}>Loading plans...</p>
                </div>
            </div>
        );
    }

    return (
        <div style={styles.page}>
            <Header onSignOut={signOut} />

            {/* Hero Section */}
            <div style={styles.heroSection}>
                <div style={styles.heroContent}>
                    <div style={styles.promoBanner}>
                        <span style={styles.promoIcon}>🔥</span>
                        <span style={styles.promoText}>Launch Promotion — <strong>50% OFF</strong> all plans for 1 year</span>
                        <span style={styles.promoIcon}>🔥</span>
                    </div>

                    <h1 style={styles.heroTitle}>
                        Break Language Barriers<br />
                        <span style={styles.heroGradientText}>In Your Ministry</span>
                    </h1>
                    <p style={styles.heroSubtitle}>
                        Real-time AI translation for churches. Your congregation hears every word, in their language.
                    </p>
                </div>
            </div>

            {/* Plans Section */}
            <div style={styles.plansContainer}>
                {error && (
                    <div style={styles.errorBanner}>
                        <span>{error}</span>
                        <button onClick={() => setError(null)} style={styles.errorClose}>✕</button>
                    </div>
                )}

                <div style={styles.plansGrid}>
                    {PLANS.map((planInfo) => {
                        const isLoading = redirecting && selectedPlan === planInfo.code;
                        const isHighlighted = planInfo.highlight;

                        return (
                            <div
                                key={planInfo.code}
                                style={{
                                    ...styles.card,
                                    ...(isHighlighted ? styles.cardHighlighted : {}),
                                    transform: isHighlighted ? 'scale(1.04)' : 'scale(1)',
                                }}
                            >
                                {/* Popular Badge */}
                                {isHighlighted && (
                                    <div style={styles.popularBadge}>
                                        ⭐ MOST POPULAR
                                    </div>
                                )}

                                {/* Special Badge (e.g. Free Trial) */}
                                {planInfo.badge && !isHighlighted && (
                                    <div style={styles.trialBadge}>
                                        {planInfo.badge}
                                    </div>
                                )}

                                {/* Plan Image */}
                                <div style={styles.imageContainer}>
                                    <img
                                        src={planInfo.image}
                                        alt={planInfo.name}
                                        style={styles.planImage}
                                    />
                                </div>

                                {/* Plan Name */}
                                <h3 style={styles.planName}>{planInfo.name}</h3>
                                <p style={styles.planDescription}>{planInfo.description}</p>

                                {/* Pricing */}
                                <div style={styles.pricingBlock}>
                                    {planInfo.name === 'Starter' ? (
                                        <>
                                            <div style={{
                                                display: 'flex',
                                                alignItems: 'baseline',
                                                justifyContent: 'center',
                                                gap: '8px',
                                                marginBottom: '4px',
                                                height: '24px' // Match originalPrice height
                                            }}>
                                                <div style={{ ...styles.originalPrice, marginBottom: 0 }}>
                                                    $45<span style={styles.priceUnit}>/mo</span>
                                                </div>
                                                <div style={{
                                                    fontSize: '1rem',
                                                    fontWeight: 500,
                                                    color: '#64748b'
                                                }}>
                                                    then ${planInfo.discountedPrice.toFixed(2)}/mo
                                                </div>
                                            </div>
                                            <div style={{
                                                fontSize: '0.875rem',
                                                color: '#6b7280',
                                                fontWeight: 500,
                                                marginBottom: '0.25rem',
                                                textTransform: 'uppercase',
                                                letterSpacing: '0.05em'
                                            }}>
                                                Free for 30 Days
                                            </div>
                                            <div style={{
                                                fontSize: '3rem',
                                                fontWeight: 800,
                                                color: '#111827',
                                                lineHeight: 1
                                            }}>
                                                $0
                                            </div>
                                            {/* 'then' price moved to top line */}
                                            <div style={styles.savingsBadge}>
                                                Save ${((planInfo.originalPrice - planInfo.discountedPrice) * 12).toFixed(0)}/year
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            <div style={styles.originalPrice}>
                                                ${planInfo.originalPrice}<span style={styles.priceUnit}>/mo</span>
                                            </div>
                                            {/* Spacer to align with 'Free for 30 Days' line in Starter plan */}
                                            <div style={{ height: '28px' }} aria-hidden="true" />

                                            <div style={styles.discountedPrice}>
                                                ${planInfo.discountedPrice % 1 === 0
                                                    ? planInfo.discountedPrice
                                                    : planInfo.discountedPrice.toFixed(2)}
                                                <span style={styles.discountedUnit}>/mo</span>
                                            </div>
                                            <div style={styles.savingsBadge}>
                                                Save ${((planInfo.originalPrice - planInfo.discountedPrice) * 12).toFixed(0)}/year
                                            </div>
                                        </>
                                    )}
                                </div>

                                {/* Divider */}
                                <div style={styles.divider} />

                                {/* Features */}
                                <ul style={styles.featureList}>
                                    {planInfo.features.map((feature, i) => (
                                        <li key={i} style={styles.featureItem}>
                                            <span style={styles.featureIcon}>{feature.icon}</span>
                                            <span style={styles.featureText}>{feature.text}</span>
                                        </li>
                                    ))}
                                </ul>

                                {/* CTA Button */}
                                <button
                                    style={{
                                        ...styles.ctaButton,
                                        backgroundImage: `linear-gradient(135deg, var(--tw-gradient-stops))`,
                                        background: `linear-gradient(135deg, ${planInfo.accentColor}, ${planInfo.accentColor}dd)`,
                                        opacity: (redirecting && !isLoading) ? 0.5 : 1,
                                    }}
                                    onClick={() => handleCheckout(planInfo.code)}
                                    disabled={redirecting}
                                >
                                    {isLoading ? (
                                        <span style={styles.buttonLoading}>
                                            <span style={styles.buttonSpinner} />
                                            Redirecting...
                                        </span>
                                    ) : planInfo.cta}
                                </button>
                            </div>
                        );
                    })}
                </div>

                {/* Trust indicators */}
                <div style={styles.trustSection}>
                    <div style={styles.trustItem}>
                        <span style={styles.trustIcon}>🔒</span>
                        <span style={styles.trustText}>Secure payment via Stripe</span>
                    </div>
                    <div style={styles.trustItem}>
                        <span style={styles.trustIcon}>↩️</span>
                        <span style={styles.trustText}>Cancel anytime</span>
                    </div>
                    <div style={styles.trustItem}>
                        <span style={styles.trustIcon}>🎁</span>
                        <span style={styles.trustText}>30-day free trial on Starter</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Inline Styles ───────────────────────────────────────────────────────────
const styles = {
    page: {
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #0f172a 0%, #1e293b 40%, #f8fafc 40.1%)',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    },

    // Loading
    loadingContainer: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '120px 20px',
    },
    spinner: {
        width: 40,
        height: 40,
        border: '3px solid rgba(139, 92, 246, 0.2)',
        borderTopColor: '#8b5cf6',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
    },
    loadingText: {
        marginTop: 16,
        color: '#94a3b8',
        fontSize: 14,
    },

    // Hero
    heroSection: {
        padding: '48px 20px 80px',
        textAlign: 'center',
    },
    heroContent: {
        maxWidth: 700,
        margin: '0 auto',
    },
    promoBanner: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: 'linear-gradient(135deg, #f59e0b, #ef4444)',
        color: 'white',
        padding: '8px 20px',
        borderRadius: 50,
        fontSize: 14,
        fontWeight: 600,
        marginBottom: 28,
        boxShadow: '0 4px 15px rgba(239, 68, 68, 0.3)',
    },
    promoIcon: { fontSize: 16 },
    promoText: { letterSpacing: 0.3 },
    heroTitle: {
        fontSize: 44,
        fontWeight: 800,
        color: 'white',
        lineHeight: 1.15,
        marginBottom: 16,
        letterSpacing: '-0.02em',
    },
    heroGradientText: {
        background: 'linear-gradient(135deg, #60a5fa, #a78bfa, #f472b6)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
    },
    heroSubtitle: {
        fontSize: 18,
        color: '#94a3b8',
        lineHeight: 1.6,
        maxWidth: 500,
        margin: '0 auto',
    },

    // Plans
    plansContainer: {
        maxWidth: 1100,
        margin: '-40px auto 0',
        padding: '0 20px 60px',
    },
    plansGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 24,
        alignItems: 'stretch',
    },

    // Card
    card: {
        background: 'white',
        borderRadius: 20,
        padding: '36px 28px 28px',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.05)',
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
    },
    cardHighlighted: {
        boxShadow: '0 8px 40px rgba(59, 130, 246, 0.2), 0 2px 8px rgba(59, 130, 246, 0.1)',
        border: '2px solid #3b82f6',
        paddingTop: 44,
    },
    popularBadge: {
        position: 'absolute',
        top: -14,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'linear-gradient(135deg, #3b82f6, #6366f1)',
        color: 'white',
        fontSize: 12,
        fontWeight: 700,
        padding: '6px 18px',
        borderRadius: 50,
        letterSpacing: 0.8,
        whiteSpace: 'nowrap',
        boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)',
        zIndex: 10,
    },
    trialBadge: {
        position: 'absolute',
        top: -14,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'linear-gradient(135deg, #10b981, #059669)',
        color: 'white',
        fontSize: 12,
        fontWeight: 700,
        padding: '6px 18px',
        borderRadius: 50,
        letterSpacing: 0.8,
        whiteSpace: 'nowrap',
        boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)',
        zIndex: 10,
    },

    // Image
    imageContainer: {
        width: 100,
        height: 100,
        borderRadius: 16,
        overflow: 'hidden',
        marginBottom: 16,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
    },
    planImage: {
        width: '100%',
        height: '100%',
        objectFit: 'cover',
    },

    // Text
    planName: {
        fontSize: 22,
        fontWeight: 700,
        color: '#1e293b',
        margin: '0 0 6px',
    },
    planDescription: {
        fontSize: 14,
        color: '#64748b',
        margin: '0 0 20px',
        lineHeight: 1.5,
        minHeight: 60, // Ensure consistent height for alignment
    },

    // Pricing
    pricingBlock: {
        marginBottom: 20,
        minHeight: 160, // Reduced from 180 since we condensed the layout
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-start',
    },
    originalPrice: {
        fontSize: 16,
        color: '#94a3b8',
        textDecoration: 'line-through',
        marginBottom: 2,
        height: 24,
    },
    priceUnit: {
        fontSize: 13,
    },
    discountedPrice: {
        fontSize: 42,
        fontWeight: 800,
        color: '#1e293b',
        lineHeight: 1.1,
        letterSpacing: '-0.02em',
    },
    discountedUnit: {
        fontSize: 16,
        fontWeight: 500,
        color: '#64748b',
    },
    savingsBadge: {
        display: 'inline-block',
        background: '#fef3c7',
        color: '#b45309',
        fontSize: 12,
        fontWeight: 600,
        padding: '4px 12px',
        borderRadius: 50,
        marginTop: 8,
    },

    // Divider
    divider: {
        width: '100%',
        height: 1,
        background: '#e2e8f0',
        margin: '0 0 20px',
    },

    // Features
    featureList: {
        listStyle: 'none',
        padding: 0,
        margin: '0 0 24px',
        width: '100%',
        textAlign: 'left',
        flexGrow: 1,
    },
    featureItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 0',
        fontSize: 13,
        color: '#475569',
    },
    featureIcon: {
        fontSize: 15,
        flexShrink: 0,
    },
    featureText: {
        lineHeight: 1.4,
    },

    // CTA
    ctaButton: {
        width: '100%',
        padding: '14px 24px',
        border: 'none',
        borderRadius: 12,
        color: 'white',
        fontSize: 16,
        fontWeight: 700,
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        letterSpacing: 0.3,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
    },
    buttonLoading: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    buttonSpinner: {
        display: 'inline-block',
        width: 16,
        height: 16,
        border: '2px solid rgba(255, 255, 255, 0.3)',
        borderTopColor: 'white',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
    },

    // Error
    errorBanner: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: '#fef2f2',
        border: '1px solid #fecaca',
        borderRadius: 12,
        padding: '12px 16px',
        marginBottom: 24,
        color: '#b91c1c',
        fontSize: 14,
    },
    errorClose: {
        background: 'none',
        border: 'none',
        color: '#b91c1c',
        cursor: 'pointer',
        fontSize: 16,
        padding: 4,
    },

    // Trust
    trustSection: {
        display: 'flex',
        justifyContent: 'center',
        gap: 32,
        marginTop: 40,
        flexWrap: 'wrap',
    },
    trustItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
    },
    trustIcon: {
        fontSize: 16,
    },
    trustText: {
        fontSize: 13,
        color: '#64748b',
    },
};

// Add CSS animation for spinner
if (typeof document !== 'undefined') {
    const styleSheet = document.createElement('style');
    styleSheet.textContent = `
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        @media (max-width: 768px) {
            /* Make grid stack on mobile */
        }
    `;
    if (!document.querySelector('[data-checkout-styles]')) {
        styleSheet.setAttribute('data-checkout-styles', '');
        document.head.appendChild(styleSheet);
    }
}

export default CheckoutPage;
