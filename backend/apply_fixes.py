import re

with open('soloModeHandler.js', 'r') as f:
    content = f.read()

# 1. Add tracking variables
content = content.replace(
    'let currentPartialText = \'\'; // Track current partial text for delayed translations\n              \n              // EXTREME SPEED:',
    'let currentPartialText = \'\'; // Track current partial text for delayed translations\n              \n              // CRITICAL: Track latest partial to prevent word loss\n              let latestPartialText = \'\'; // Most recent partial text from Google Speech\n              let latestPartialTime = 0; // Timestamp of latest partial\n              \n              // EXTREME SPEED:'
)

# 2. Add partial tracking
content = content.replace(
    '                if (isPartial) {\n                  // Live partial transcript',
    '                if (isPartial) {\n                  // Track latest partial\n                  if (!latestPartialText || transcriptText.length > latestPartialText.length) {\n                    latestPartialText = transcriptText;\n                    latestPartialTime = Date.now();\n                  }\n                  // Live partial transcript'
)

# 3. Add check in final handler
content = content.replace(
    '                } else {\n                  // Final transcript from Google Speech - send immediately (restored simple approach)\n                  console.log(`[SoloMode] 📝 FINAL Transcript (raw): "${transcriptText.substring(0, 50)}..."`);',
    '                } else {\n                  // Final transcript from Google Speech\n                  // CRITICAL: Check if partial has more text than final\n                  if (latestPartialText && latestPartialText.length > transcriptText.length && (Date.now() - latestPartialTime) < 500) {\n                    console.log(`[SoloMode] ⚠️ Using partial instead of final (${transcriptText.length} → ${latestPartialText.length} chars)`);\n                    transcriptText = latestPartialText;\n                  }\n                  latestPartialText = \'\';\n                  console.log(`[SoloMode] 📝 FINAL Transcript (raw): "${transcriptText.substring(0, 50)}..."`);'
)

with open('soloModeHandler.js', 'w') as f:
    f.write(content)

print('OK')

