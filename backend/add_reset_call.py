#!/usr/bin/env python3
import re

with open('soloModeHandler.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the closing brace of checkForExtendingPartialsAfterFinal and add reset before it
# Pattern: closing brace of if (!foundExtension) block, then }; then comment
pattern = r'(                }\n              };\n              // Helper function to process final text)'
replacement = r'''                }
                
                // CRITICAL FIX: Reset partial tracking AFTER checking for extensions
                // This prevents partials from building up and causing connection/timeout issues
                resetPartialTracking();
              };
              
              // Helper function to process final text'''

if 'resetPartialTracking();' not in content.split('checkForExtendingPartialsAfterFinal')[1].split('// Helper function to process final text')[0]:
    content = re.sub(pattern, replacement, content)

with open('soloModeHandler.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('✅ Added reset call to checkForExtendingPartialsAfterFinal')

