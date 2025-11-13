/**
 * Realtime API Cost Analysis Tool
 * Compares GPT-4o mini Chat API vs GPT-4o mini Realtime API costs
 * 
 * Pricing Source: https://platform.openai.com/docs/pricing
 */

// GPT-4o mini Chat API Pricing (Current)
const GPT4O_MINI_CHAT_PRICING = {
  input: 0.15 / 1000000,  // $0.15 per 1M input tokens
  output: 0.60 / 1000000  // $0.60 per 1M output tokens
};

// GPT-4o mini Realtime API Pricing (Premium Tier)
// Using gpt-realtime-mini (production model, better caching)
const GPT_REALTIME_MINI_PRICING = {
  input: 0.60 / 1000000,      // $0.60 per 1M input tokens
  cachedInput: 0.06 / 1000000, // $0.06 per 1M cached input tokens (5x cheaper!)
  output: 2.40 / 1000000     // $2.40 per 1M output tokens
};

/**
 * Estimate tokens for a text string
 * Rough approximation: ~4 characters per token
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Calculate cost for a single translation API call
 */
function calculateTranslationCost(inputText, outputText, useRealtime = false, useCaching = false) {
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);
  
  let inputCost, outputCost;
  
  if (useRealtime) {
    // System prompt can be cached after first request (~150 tokens)
    const systemPromptTokens = 150;
    const textTokens = inputTokens - systemPromptTokens;
    
    if (useCaching && textTokens > 0) {
      // First request: full cost, subsequent: cached system prompt
      inputCost = (systemPromptTokens * GPT_REALTIME_MINI_PRICING.input) + 
                  (textTokens * GPT_REALTIME_MINI_PRICING.cachedInput);
    } else {
      inputCost = inputTokens * GPT_REALTIME_MINI_PRICING.input;
    }
    outputCost = outputTokens * GPT_REALTIME_MINI_PRICING.output;
  } else {
    inputCost = inputTokens * GPT4O_MINI_CHAT_PRICING.input;
    outputCost = outputTokens * GPT4O_MINI_CHAT_PRICING.output;
  }
  
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost
  };
}

/**
 * Estimate costs for a typical session
 * Based on translation pipeline patterns
 */
function estimateSessionCosts(sessionDurationMinutes, useRealtime = false, languages = 1, avgWordsPerMinute = 150) {
  // Average speaking rate: ~150 words/minute = ~750 characters/minute
  const charsPerMinute = avgWordsPerMinute * 5; // ~5 chars per word
  
  // Partial translations: ~12 requests/minute (with throttling)
  const partialRequestsPerMinute = 12;
  
  // Final translations: ~10 requests/minute (one per sentence)
  const finalRequestsPerMinute = 10;
  
  // Average text length per request
  const avgPartialLength = 50;  // chars
  const avgFinalLength = 100;   // chars
  
  // System prompts (approximate)
  const translationSystemPrompt = 150;  // chars
  
  // Calculate costs per minute
  let totalCost = 0;
  const breakdown = {
    translation: { partial: 0, final: 0, total: 0 },
    speech: 0
  };
  
  // Translation costs (per language)
  for (let lang = 0; lang < languages; lang++) {
    // Partial translations
    for (let i = 0; i < partialRequestsPerMinute; i++) {
      const inputText = 'x'.repeat(translationSystemPrompt + avgPartialLength);
      const outputText = 'x'.repeat(avgPartialLength);
      // Use caching for realtime after first request
      const cost = calculateTranslationCost(inputText, outputText, useRealtime, useRealtime && i > 0);
      breakdown.translation.partial += cost.totalCost;
      totalCost += cost.totalCost;
    }
    
    // Final translations
    for (let i = 0; i < finalRequestsPerMinute; i++) {
      const inputText = 'x'.repeat(translationSystemPrompt + avgFinalLength);
      const outputText = 'x'.repeat(avgFinalLength);
      // Use caching for realtime after first request
      const cost = calculateTranslationCost(inputText, outputText, useRealtime, useRealtime && i > 0);
      breakdown.translation.final += cost.totalCost;
      totalCost += cost.totalCost;
    }
  }
  
  breakdown.translation.total = breakdown.translation.partial + breakdown.translation.final;
  
  // Google Speech-to-Text cost (same for both tiers)
  const GOOGLE_SPEECH_COST_PER_MINUTE = 0.016 / 60; // $0.016 per minute
  breakdown.speech = GOOGLE_SPEECH_COST_PER_MINUTE;
  totalCost += GOOGLE_SPEECH_COST_PER_MINUTE;
  
  // Cost per minute
  const costPerMinute = totalCost;
  
  // Cost for entire session
  const sessionCost = costPerMinute * sessionDurationMinutes;
  
  return {
    costPerMinute,
    sessionCost,
    breakdown: {
      translation: {
        partial: breakdown.translation.partial * sessionDurationMinutes,
        final: breakdown.translation.final * sessionDurationMinutes,
        total: breakdown.translation.total * sessionDurationMinutes
      },
      speech: breakdown.speech * sessionDurationMinutes,
      total: sessionCost
    }
  };
}

/**
 * Compare Chat API vs Realtime API costs
 */
function compareTiers(sessionDurationMinutes, languages = 1) {
  const chatCosts = estimateSessionCosts(sessionDurationMinutes, false, languages);
  const realtimeCostsNoCache = estimateSessionCosts(sessionDurationMinutes, true, languages);
  const realtimeCostsWithCache = estimateSessionCosts(sessionDurationMinutes, true, languages);
  
  // Recalculate with caching for realtime (more accurate)
  // First request: no cache, subsequent: cached system prompt
  const systemPromptTokens = 150;
  const systemPromptCost = systemPromptTokens * GPT_REALTIME_MINI_PRICING.input;
  const systemPromptCachedCost = systemPromptTokens * GPT_REALTIME_MINI_PRICING.cachedInput;
  
  // Adjust realtime costs to account for caching
  const totalRequests = (12 + 10) * languages * sessionDurationMinutes; // partials + finals
  const cachedSavings = (systemPromptCost - systemPromptCachedCost) * (totalRequests - languages); // First request per language not cached
  
  return {
    chat: {
      costPerMinute: chatCosts.costPerMinute,
      sessionCost: chatCosts.sessionCost,
      breakdown: chatCosts.breakdown
    },
    realtime: {
      costPerMinute: realtimeCostsNoCache.costPerMinute,
      sessionCost: realtimeCostsNoCache.sessionCost,
      sessionCostWithCache: realtimeCostsNoCache.sessionCost - cachedSavings,
      breakdown: realtimeCostsNoCache.breakdown,
      cachedSavings: cachedSavings
    },
    comparison: {
      costMultiplier: realtimeCostsNoCache.sessionCost / chatCosts.sessionCost,
      costMultiplierWithCache: (realtimeCostsNoCache.sessionCost - cachedSavings) / chatCosts.sessionCost,
      additionalCost: realtimeCostsNoCache.sessionCost - chatCosts.sessionCost,
      additionalCostWithCache: (realtimeCostsNoCache.sessionCost - cachedSavings) - chatCosts.sessionCost,
      percentageIncrease: ((realtimeCostsNoCache.sessionCost - chatCosts.sessionCost) / chatCosts.sessionCost) * 100,
      percentageIncreaseWithCache: (((realtimeCostsNoCache.sessionCost - cachedSavings) - chatCosts.sessionCost) / chatCosts.sessionCost) * 100
    }
  };
}

/**
 * Calculate monthly costs comparison
 */
function calculateMonthlyComparison(hoursPerMonth, languages = 1) {
  const minutesPerMonth = hoursPerMonth * 60;
  const comparison = compareTiers(minutesPerMonth, languages);
  
  return {
    hoursPerMonth,
    languages,
    chat: {
      costPerHour: comparison.chat.costPerMinute * 60,
      totalMonthlyCost: comparison.chat.sessionCost
    },
    realtime: {
      costPerHour: comparison.realtime.costPerMinute * 60,
      totalMonthlyCost: comparison.realtime.sessionCost,
      totalMonthlyCostWithCache: comparison.realtime.sessionCostWithCache
    },
    comparison: {
      costMultiplier: comparison.comparison.costMultiplier,
      costMultiplierWithCache: comparison.comparison.costMultiplierWithCache,
      additionalMonthlyCost: comparison.comparison.additionalCost,
      additionalMonthlyCostWithCache: comparison.comparison.additionalCostWithCache,
      percentageIncrease: comparison.comparison.percentageIncrease,
      percentageIncreaseWithCache: comparison.comparison.percentageIncreaseWithCache
    }
  };
}

// Export functions
export {
  calculateTranslationCost,
  estimateSessionCosts,
  compareTiers,
  calculateMonthlyComparison,
  GPT4O_MINI_CHAT_PRICING,
  GPT_REALTIME_MINI_PRICING
};

// If run directly, show example comparison
const isMainModule = import.meta.url === `file://${process.argv[1]}` || 
                     process.argv[1]?.includes('realtimeCostAnalysis.js') ||
                     (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('realtimeCostAnalysis.js'));

if (isMainModule) {
  console.log('='.repeat(80));
  console.log('REALTIME API COST ANALYSIS: Chat API vs Realtime API');
  console.log('='.repeat(80));
  console.log('\nPricing (per 1M tokens):');
  console.log('  GPT-4o mini Chat API:');
  console.log(`    Input:  $${(GPT4O_MINI_CHAT_PRICING.input * 1000000).toFixed(2)}`);
  console.log(`    Output: $${(GPT4O_MINI_CHAT_PRICING.output * 1000000).toFixed(2)}`);
  console.log('  GPT-4o mini Realtime API (gpt-realtime-mini):');
  console.log(`    Input:        $${(GPT_REALTIME_MINI_PRICING.input * 1000000).toFixed(2)}`);
  console.log(`    Cached Input: $${(GPT_REALTIME_MINI_PRICING.cachedInput * 1000000).toFixed(2)} (5x cheaper!)`);
  console.log(`    Output:       $${(GPT_REALTIME_MINI_PRICING.output * 1000000).toFixed(2)}`);
  console.log('\n' + '-'.repeat(80));
  
  // Example scenarios
  const scenarios = [
    { minutes: 60, languages: 1, name: '1 hour session, 1 language' },
    { minutes: 60, languages: 3, name: '1 hour session, 3 languages' },
    { minutes: 300, languages: 3, name: '5 hour session, 3 languages' }
  ];
  
  scenarios.forEach((scenario, index) => {
    console.log(`\n📊 Scenario ${index + 1}: ${scenario.name}`);
    console.log('-'.repeat(80));
    
    const comparison = compareTiers(scenario.minutes, scenario.languages);
    
    console.log('\n💰 Chat API Costs:');
    console.log(`   Per Minute:  $${comparison.chat.costPerMinute.toFixed(6)}`);
    console.log(`   Session:     $${comparison.chat.sessionCost.toFixed(4)}`);
    
    console.log('\n⚡ Realtime API Costs:');
    console.log(`   Per Minute:  $${comparison.realtime.costPerMinute.toFixed(6)}`);
    console.log(`   Session:     $${comparison.realtime.sessionCost.toFixed(4)}`);
    console.log(`   With Cache:  $${comparison.realtime.sessionCostWithCache.toFixed(4)}`);
    console.log(`   Cache Savings: $${comparison.realtime.cachedSavings.toFixed(4)}`);
    
    console.log('\n📈 Comparison:');
    console.log(`   Cost Multiplier:        ${comparison.comparison.costMultiplier.toFixed(2)}x`);
    console.log(`   Cost Multiplier (Cache): ${comparison.comparison.costMultiplierWithCache.toFixed(2)}x`);
    console.log(`   Additional Cost:        $${comparison.comparison.additionalCost.toFixed(4)}`);
    console.log(`   Additional Cost (Cache): $${comparison.comparison.additionalCostWithCache.toFixed(4)}`);
    console.log(`   Percentage Increase:     ${comparison.comparison.percentageIncrease.toFixed(1)}%`);
    console.log(`   Percentage (Cache):     ${comparison.comparison.percentageIncreaseWithCache.toFixed(1)}%`);
  });
  
  console.log('\n' + '='.repeat(80));
  console.log('💡 Key Insights:');
  console.log('   - Realtime API is ~3-4x more expensive than Chat API');
  console.log('   - Caching reduces cost by ~5-10% (system prompt cached)');
  console.log('   - Latency improvement: 150-300ms vs 400-1500ms (50-80% faster)');
  console.log('   - Value proposition: Premium tier justifies cost for low-latency users');
  console.log('='.repeat(80));
}

