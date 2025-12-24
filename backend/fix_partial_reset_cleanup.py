#!/usr/bin/env python3
"""Clean up duplicate resetPartialTracking function and ensure proper usage"""

import re

file_path = 'soloModeHandler.js'

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find and remove duplicate function definitions
# Keep only the first complete definition
in_function = False
function_start = -1
function_count = 0
new_lines = []
skip_until = -1

for i, line in enumerate(lines):
    if i < skip_until:
        continue
        
    # Check for function definition
    if 'const resetPartialTracking = () => {' in line:
        function_count += 1
        if function_count == 1:
            # Keep first definition
            in_function = True
            function_start = i
            new_lines.append(line)
        else:
            # Skip duplicate definitions
            in_function = True
            skip_until = i
            # Find the end of this duplicate function
            brace_count = 1
            for j in range(i + 1, len(lines)):
                if '{' in lines[j]:
                    brace_count += 1
                if '}' in lines[j]:
                    brace_count -= 1
                    if brace_count == 0:
                        skip_until = j + 1
                        break
            continue
    elif in_function and function_count == 1:
        new_lines.append(line)
        if line.strip() == '};':
            in_function = False
    elif i >= skip_until:
        new_lines.append(line)

# Also ensure resetPartialTracking is called at end of checkForExtendingPartialsAfterFinal
content = ''.join(new_lines)

# Find the end of checkForExtendingPartialsAfterFinal and add reset call if not present
if 'resetPartialTracking();' not in content.split('checkForExtendingPartialsAfterFinal')[1].split('// Helper function to process final text')[0]:
    # Add reset call before the closing brace of checkForExtendingPartialsAfterFinal
    content = re.sub(
        r'(if \(!foundExtension\) \{[^}]*\})\s*(\n\s*\};)\s*(\n\s*// Helper function to process final text)',
        r'\1\n                \n                // CRITICAL FIX: Reset partial tracking AFTER checking for extensions\n                // This prevents partials from building up and causing connection/timeout issues\n                resetPartialTracking();\2\3',
        content,
        flags=re.DOTALL
    )

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"✅ Cleaned up duplicate functions in {file_path}")

