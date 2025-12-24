#!/usr/bin/env python3
"""Fix resetPartialTracking placement in checkForExtendingPartialsAfterFinal"""

file_path = 'soloModeHandler.js'

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find the end of checkForExtendingPartialsAfterFinal function
# Look for the closing brace after if (!foundExtension)
new_lines = []
i = 0
while i < len(lines):
    line = lines[i]
    new_lines.append(line)
    
    # Check if this is the closing brace of checkForExtendingPartialsAfterFinal
    # It should be after the if (!foundExtension) block
    if (line.strip() == '};' and 
        i > 0 and 
        'if (!foundExtension)' in ''.join(lines[max(0, i-10):i]) and
        'checkForExtendingPartialsAfterFinal' in ''.join(lines[max(0, i-50):i]) and
        'resetPartialTracking();' not in ''.join(lines[max(0, i-5):i+1])):
        # Check if next line is not part of this function
        if i + 1 < len(lines) and ('// Helper function' in lines[i+1] or lines[i+1].strip().startswith('const ')):
            # Insert reset call before the closing brace
            new_lines.pop()  # Remove the };
            new_lines.append('                \n')
            new_lines.append('                // CRITICAL FIX: Reset partial tracking AFTER checking for extensions\n')
            new_lines.append('                // This prevents partials from building up and causing connection/timeout issues\n')
            new_lines.append('                resetPartialTracking();\n')
            new_lines.append('              };\n')
    
    i += 1

with open(file_path, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print(f"✅ Fixed resetPartialTracking placement in {file_path}")

