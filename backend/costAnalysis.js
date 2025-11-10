/**
 * Cost Analysis Tool
 * Compares current OpenAI API costs against quoted pricing model
 * 
 * Quoted Pricing: $150/month for 3 languages, 5 hours/month, 10 users
 */

// OpenAI GPT-4o-mini Pricing (as of 2024)
// Source: https://openai.com/pricing
const GPT4O_MINI_PRICING = {
  input: 0.15 / 1000000,  // $0.15 per 1M input tokens
  output: 0.60 / 1000000  // $0.60 per 1M output tokens
};

// Google Cloud Speech-to-Text Pricing (Chirp 3)
// Source: https://cloud.google.com/speech-to-text/pricing
const GOOGLE_SPEECH_PRICING = {
  standard: 0.006 / 60,  // $0.006 per 15 seconds = $0.024 per minute
  enhanced: 0.009 / 60   // $0.009 per 15 seconds = $0.036 per minute (Chirp 3)
};

/**
 * Estimate tokens for a text string
 * Rough approximation: ~4 characters per token
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Calculate cost for a single API call
 */
function calculateAPICost(inputText, outputText) {
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);
  
  const inputCost = inputTokens * GPT4O_MINI_PRICING.input;
  const outputCost = outputTokens * GPT4O_MINI_PRICING.output;
  
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
 * Based on your codebase patterns:
 * - Partial translations: throttled every 2 seconds, ~25 char growth threshold
 * - Final translations: once per sentence completion
 * - Grammar corrections: throttled every 2 seconds for partials, once for finals
 */
function estimateSessionCosts(sessionDurationMinutes, languages = 1, avgWordsPerMinute = 150) {
  // Average speaking rate: ~150 words/minute = ~750 characters/minute
  const charsPerMinute = avgWordsPerMinute * 5; // ~5 chars per word
  
  // Partial translations: throttled every 2 seconds = ~30 requests/minute
  // But with growth threshold of 25 chars, actual rate is lower
  // Estimate: ~10-15 partial translation requests per minute
  const partialRequestsPerMinute = 12;
  
  // Final translations: ~1 per sentence, assuming 15 words/sentence = ~10 sentences/minute
  const finalRequestsPerMinute = 10;
  
  // Grammar corrections: similar pattern to translations
  // Partial: ~12 requests/minute, Final: ~10 requests/minute
  const grammarPartialPerMinute = 12;
  const grammarFinalPerMinute = 10;
  
  // Average text length per request
  const avgPartialLength = 50;  // chars
  const avgFinalLength = 100;   // chars
  
  // System prompts (approximate)
  const translationSystemPrompt = 150;  // chars
  const grammarSystemPrompt = 2000;    // chars (much longer)
  
  // Calculate costs per minute
  let totalCost = 0;
  const breakdown = {
    translation: { partial: 0, final: 0 },
    grammar: { partial: 0, final: 0 },
    speech: 0
  };
  
  // Translation costs (per language)
  for (let lang = 0; lang < languages; lang++) {
    // Partial translations
    for (let i = 0; i < partialRequestsPerMinute; i++) {
      const inputTextLength = translationSystemPrompt + avgPartialLength;
      const outputTextLength = avgPartialLength; // Roughly same length
      const cost = calculateAPICost('x'.repeat(inputTextLength), 'x'.repeat(outputTextLength));
      breakdown.translation.partial += cost.totalCost;
      totalCost += cost.totalCost;
    }
    
    // Final translations
    for (let i = 0; i < finalRequestsPerMinute; i++) {
      const inputTextLength = translationSystemPrompt + avgFinalLength;
      const outputTextLength = avgFinalLength;
      const cost = calculateAPICost('x'.repeat(inputTextLength), 'x'.repeat(outputTextLength));
      breakdown.translation.final += cost.totalCost;
      totalCost += cost.totalCost;
    }
  }
  
  // Grammar correction costs (only for source language, typically English)
  // Partial grammar corrections
  for (let i = 0; i < grammarPartialPerMinute; i++) {
    const inputTextLength = grammarSystemPrompt + avgPartialLength;
    const outputTextLength = avgPartialLength;
    const cost = calculateAPICost('x'.repeat(inputTextLength), 'x'.repeat(outputTextLength));
    breakdown.grammar.partial += cost.totalCost;
    totalCost += cost.totalCost;
  }
  
  // Final grammar corrections
  for (let i = 0; i < grammarFinalPerMinute; i++) {
    const inputTextLength = grammarSystemPrompt + avgFinalLength;
    const outputTextLength = avgFinalLength;
    const cost = calculateAPICost('x'.repeat(inputTextLength), 'x'.repeat(outputTextLength));
    breakdown.grammar.final += cost.totalCost;
    totalCost += cost.totalCost;
  }
  
  // Google Speech-to-Text cost (per minute of audio)
  const speechCostPerMinute = GOOGLE_SPEECH_PRICING.enhanced; // Using Chirp 3
  breakdown.speech = speechCostPerMinute;
  totalCost += speechCostPerMinute;
  
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
        total: (breakdown.translation.partial + breakdown.translation.final) * sessionDurationMinutes
      },
      grammar: {
        partial: breakdown.grammar.partial * sessionDurationMinutes,
        final: breakdown.grammar.final * sessionDurationMinutes,
        total: (breakdown.grammar.partial + breakdown.grammar.final) * sessionDurationMinutes
      },
      speech: breakdown.speech * sessionDurationMinutes,
      total: sessionCost
    }
  };
}

/**
 * Calculate monthly costs based on usage
 */
function calculateMonthlyCosts(hoursPerMonth, languages, users = 1) {
  const minutesPerMonth = hoursPerMonth * 60;
  
  // Calculate cost per minute for 1 minute session
  const oneMinuteCosts = estimateSessionCosts(1, languages);
  const costPerMinute = oneMinuteCosts.costPerMinute;
  const costPerHour = costPerMinute * 60;
  
  // Total cost = cost per minute * total minutes
  // Note: In multi-user sessions, translations are shared, so we don't multiply by users
  // But if each user has separate sessions, we multiply
  // Assuming shared sessions (host speaks, multiple listeners)
  const totalCost = costPerMinute * minutesPerMonth;
  
  // Calculate breakdown for the full month
  const monthlyBreakdown = {
    translation: {
      partial: oneMinuteCosts.breakdown.translation.partial * minutesPerMonth,
      final: oneMinuteCosts.breakdown.translation.final * minutesPerMonth,
      total: oneMinuteCosts.breakdown.translation.total * minutesPerMonth
    },
    grammar: {
      partial: oneMinuteCosts.breakdown.grammar.partial * minutesPerMonth,
      final: oneMinuteCosts.breakdown.grammar.final * minutesPerMonth,
      total: oneMinuteCosts.breakdown.grammar.total * minutesPerMonth
    },
    speech: oneMinuteCosts.breakdown.speech * minutesPerMonth,
    total: totalCost
  };
  
  return {
    costPerMinute,
    costPerHour,
    costPerHourPerLanguage: costPerHour / languages,
    totalMonthlyCost: totalCost,
    breakdown: monthlyBreakdown
  };
}

/**
 * Compare against quoted pricing
 */
function compareWithQuotedPricing(actualHours, actualLanguages, actualUsers) {
  const quotedPrice = 150; // $150/month
  const quotedHours = 5;
  const quotedLanguages = 3;
  const quotedUsers = 10;
  
  // Calculate actual costs
  const actualCosts = calculateMonthlyCosts(actualHours, actualLanguages, actualUsers);
  
  // Calculate quoted equivalent cost
  const costPerLanguageHour = quotedPrice / (quotedLanguages * quotedHours);
  const quotedEquivalentCost = costPerLanguageHour * actualLanguages * actualHours;
  
  // Calculate per-user cost if applicable
  const costPerUserPerMonth = actualCosts.totalMonthlyCost / actualUsers;
  
  return {
    quoted: {
      price: quotedPrice,
      hours: quotedHours,
      languages: quotedLanguages,
      users: quotedUsers,
      costPerLanguageHour: costPerLanguageHour,
      costPerHour: quotedPrice / quotedHours
    },
    actual: {
      hours: actualHours,
      languages: actualLanguages,
      users: actualUsers,
      costPerHour: actualCosts.costPerHour,
      costPerLanguageHour: actualCosts.costPerHourPerLanguage,
      totalMonthlyCost: actualCosts.totalMonthlyCost,
      costPerUserPerMonth: costPerUserPerMonth,
      breakdown: actualCosts.breakdown
    },
    comparison: {
      actualVsQuoted: actualCosts.totalMonthlyCost - quotedPrice,
      actualVsQuotedEquivalent: actualCosts.totalMonthlyCost - quotedEquivalentCost,
      savingsIfUsingQuoted: Math.max(0, actualCosts.totalMonthlyCost - quotedPrice),
      extraCostIfUsingQuoted: Math.max(0, quotedPrice - actualCosts.totalMonthlyCost),
      percentageDifference: ((actualCosts.totalMonthlyCost - quotedPrice) / quotedPrice) * 100
    }
  };
}

// Export functions
export {
  calculateAPICost,
  estimateSessionCosts,
  calculateMonthlyCosts,
  compareWithQuotedPricing,
  GPT4O_MINI_PRICING,
  GOOGLE_SPEECH_PRICING
};

// If run directly, show example comparison
const isMainModule = import.meta.url === `file://${process.argv[1]}` || 
                     process.argv[1]?.includes('costAnalysis.js') ||
                     (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('costAnalysis.js'));

if (isMainModule) {
  console.log('='.repeat(80));
  console.log('COST ANALYSIS: Your API Usage vs Quoted Pricing');
  console.log('='.repeat(80));
  console.log('\nQuoted Pricing Model:');
  console.log('  - $150/month');
  console.log('  - 3 languages');
  console.log('  - 5 hours/month');
  console.log('  - 10 users');
  console.log('\n' + '-'.repeat(80));
  
  // Example scenarios
  const scenarios = [
    { hours: 5, languages: 3, users: 10, name: 'Exact match to quoted' },
    { hours: 10, languages: 3, users: 10, name: 'Double hours' },
    { hours: 5, languages: 5, users: 10, name: 'More languages' },
    { hours: 10, languages: 5, users: 20, name: 'More hours, languages, and users' }
  ];
  
  scenarios.forEach((scenario, index) => {
    console.log(`\n📊 Scenario ${index + 1}: ${scenario.name}`);
    console.log(`   Hours: ${scenario.hours}/month, Languages: ${scenario.languages}, Users: ${scenario.users}`);
    console.log('-'.repeat(80));
    
    const comparison = compareWithQuotedPricing(scenario.hours, scenario.languages, scenario.users);
    
    console.log('\n💰 Cost Breakdown:');
    console.log(`   Translation (Partial): $${comparison.actual.breakdown.translation.partial.toFixed(4)}`);
    console.log(`   Translation (Final):  $${comparison.actual.breakdown.translation.final.toFixed(4)}`);
    console.log(`   Grammar (Partial):     $${comparison.actual.breakdown.grammar.partial.toFixed(4)}`);
    console.log(`   Grammar (Final):       $${comparison.actual.breakdown.grammar.final.toFixed(4)}`);
    console.log(`   Speech-to-Text:        $${comparison.actual.breakdown.speech.toFixed(4)}`);
    console.log(`   ─────────────────────────────────────────`);
    console.log(`   TOTAL MONTHLY COST:    $${comparison.actual.totalMonthlyCost.toFixed(2)}`);
    
    console.log('\n📈 Comparison:');
    console.log(`   Quoted Price:          $${comparison.quoted.price.toFixed(2)}`);
    console.log(`   Your Actual Cost:      $${comparison.actual.totalMonthlyCost.toFixed(2)}`);
    console.log(`   Difference:           $${Math.abs(comparison.comparison.actualVsQuoted).toFixed(2)} ${comparison.comparison.actualVsQuoted >= 0 ? 'more' : 'less'}`);
    console.log(`   Percentage:           ${comparison.comparison.percentageDifference >= 0 ? '+' : ''}${comparison.comparison.percentageDifference.toFixed(1)}%`);
    
    if (comparison.comparison.actualVsQuoted < 0) {
      console.log(`   ✅ You're SAVING $${comparison.comparison.savingsIfUsingQuoted.toFixed(2)}/month vs quoted price!`);
    } else {
      console.log(`   ⚠️  You're PAYING $${comparison.comparison.extraCostIfUsingQuoted.toFixed(2)}/month MORE than quoted price`);
    }
  });
  
  console.log('\n' + '='.repeat(80));
  console.log('💡 Note: This analysis assumes:');
  console.log('   - GPT-4o-mini for translations and grammar correction');
  console.log('   - Google Cloud Speech-to-Text (Chirp 3) for transcription');
  console.log('   - Average speaking rate: 150 words/minute');
  console.log('   - Shared sessions (host speaks, multiple listeners)');
  console.log('   - Caching reduces costs by ~20-30% (not included in estimates)');
  console.log('='.repeat(80));
}

