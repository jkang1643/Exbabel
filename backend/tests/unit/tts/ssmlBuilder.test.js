/**
 * SSML Builder Tests
 * 
 * Unit tests for SSML generation and delivery style presets
 */

import { describe, it, expect } from '@jest/globals';
import {
    sanitizeForSSML,
    emphasizePowerWords,
    addStrategicPauses,
    buildSSML,
    applyDeliveryStyle,
    supportsSSML,
    getFallbackText,
    generateTtsInput,
    DeliveryStyles,
    POWER_WORDS
} from '../../../tts/ssmlBuilder.js';

describe('SSML Builder', () => {
    describe('sanitizeForSSML', () => {
        it('should escape XML special characters', () => {
            const input = 'Test & <tag> "quotes" \'apostrophe\'';
            const expected = 'Test &amp; &lt;tag&gt; &quot;quotes&quot; &apos;apostrophe&apos;';
            expect(sanitizeForSSML(input)).toBe(expected);
        });

        it('should handle empty string', () => {
            expect(sanitizeForSSML('')).toBe('');
        });

        it('should handle null/undefined', () => {
            expect(sanitizeForSSML(null)).toBe('');
            expect(sanitizeForSSML(undefined)).toBe('');
        });
    });

    describe('emphasizePowerWords', () => {
        it('should emphasize spiritual power words', () => {
            const input = 'Jesus loves you with faith and grace';
            const result = emphasizePowerWords(input);

            expect(result).toContain('<emphasis level="moderate">Jesus</emphasis>');
            expect(result).toContain('<emphasis level="moderate">faith</emphasis>');
            expect(result).toContain('<emphasis level="moderate">grace</emphasis>');
        });

        it('should be case-insensitive', () => {
            const input = 'JESUS loves you';
            const result = emphasizePowerWords(input);

            expect(result).toContain('<emphasis level="moderate">JESUS</emphasis>');
        });

        it('should not emphasize partial matches', () => {
            const input = 'graceful dancer'; // 'grace' is a power word but 'graceful' shouldn't match
            const result = emphasizePowerWords(input);

            // Should not have emphasis tags since 'graceful' is not 'grace'
            expect(result).not.toContain('<emphasis');
        });

        it('should support custom emphasis level', () => {
            const input = 'Jesus loves you';
            const result = emphasizePowerWords(input, [], 'strong');

            expect(result).toContain('<emphasis level="strong">Jesus</emphasis>');
        });

        it('should support custom words', () => {
            const input = 'The church believes';
            const result = emphasizePowerWords(input, ['church']);

            expect(result).toContain('<emphasis level="moderate">church</emphasis>');
        });
    });

    describe('addStrategicPauses', () => {
        it('should add SSML break tags for punctuation', () => {
            const input = 'Hello, world... How are you — today?';
            const result = addStrategicPauses(input, 'medium', false);

            expect(result).toContain('<break time="300ms"/>'); // comma
            expect(result).toContain('<break time="450ms"/>'); // ellipsis
            expect(result).toContain('<break time="350ms"/>'); // em dash
        });

        it('should use markup tags when requested', () => {
            const input = 'Hello, world... How are you — today?';
            const result = addStrategicPauses(input, 'medium', true);

            expect(result).toContain('[pause short]');
            expect(result).toContain('[pause long]');
            expect(result).toContain('[pause]');
        });

        it('should adjust pause durations by intensity', () => {
            const input = 'Hello...';

            const light = addStrategicPauses(input, 'light', false);
            const heavy = addStrategicPauses(input, 'heavy', false);

            expect(light).toContain('<break time="300ms"/>');
            expect(heavy).toContain('<break time="500ms"/>');
        });
    });

    describe('buildSSML', () => {
        it('should wrap text in speak and prosody tags', () => {
            const input = 'Hello world';
            const result = buildSSML(input);

            expect(result).toContain('<speak>');
            expect(result).toContain('</speak>');
            expect(result).toContain('<prosody');
            expect(result).toContain('</prosody>');
        });

        it('should apply rate and pitch', () => {
            const input = 'Hello world';
            const result = buildSSML(input, { rate: '90%', pitch: '+2st' });

            expect(result).toContain('rate="90%"');
            expect(result).toContain('pitch="+2st"');
        });

        it('should sanitize input text', () => {
            const input = 'Test & <tag>';
            const result = buildSSML(input);

            expect(result).toContain('&amp;');
            expect(result).toContain('&lt;tag&gt;');
        });

        it('should emphasize power words by default', () => {
            const input = 'Jesus loves you';
            const result = buildSSML(input);

            expect(result).toContain('<emphasis');
        });

        it('should skip power words when disabled', () => {
            const input = 'Jesus loves you';
            const result = buildSSML(input, { emphasizePowerWords: false });

            expect(result).not.toContain('<emphasis');
        });
    });

    describe('applyDeliveryStyle', () => {
        it('should apply standard preaching style', () => {
            const input = 'Church, listen to me';
            const result = applyDeliveryStyle(input, 'standard_preaching');

            expect(result.ssml).toBeDefined();
            expect(result.prompt).toContain('seasoned preacher');
            expect(result.style.name).toBe('standard_preaching');
            expect(result.options.rate).toBe('92%');
            expect(result.options.pitch).toBe('+1st');
        });

        it('should apply pentecostal style', () => {
            const input = 'God is good!';
            const result = applyDeliveryStyle(input, 'pentecostal');

            expect(result.prompt).toContain('joyful urgency');
            expect(result.style.name).toBe('pentecostal');
            expect(result.options.rate).toBe('94%');
            expect(result.options.pitch).toBe('+2st');
        });

        it('should apply teaching style', () => {
            const input = 'Let us study the Word';
            const result = applyDeliveryStyle(input, 'teaching');

            expect(result.prompt).toContain('clarity');
            expect(result.style.name).toBe('teaching');
            expect(result.options.rate).toBe('90%');
        });

        it('should apply altar call style', () => {
            const input = 'Come as you are';
            const result = applyDeliveryStyle(input, 'altar_call');

            expect(result.prompt).toContain('gentle invitation');
            expect(result.style.name).toBe('altar_call');
            expect(result.options.rate).toBe('88%');
        });

        it('should allow overrides', () => {
            const input = 'Test';
            const result = applyDeliveryStyle(input, 'standard_preaching', {
                rate: '100%',
                pitch: '0st'
            });

            expect(result.options.rate).toBe('100%');
            expect(result.options.pitch).toBe('0st');
        });

        it('should default to standard_preaching for unknown style', () => {
            const input = 'Test';
            const result = applyDeliveryStyle(input, 'unknown_style');

            expect(result.style.name).toBe('standard_preaching');
        });
    });

    describe('supportsSSML', () => {
        it('should return true for chirp3_hd tier', () => {
            expect(supportsSSML('en-US-Chirp3-HD-Kore', 'chirp3_hd')).toBe(true);
        });

        it('should return true for Chirp3 voice names', () => {
            expect(supportsSSML('en-US-Chirp3-HD-Kore', null)).toBe(true);
            expect(supportsSSML('es-ES-Chirp_3-HD-Leda', null)).toBe(true);
        });

        it('should return false for gemini tier', () => {
            expect(supportsSSML('Kore', 'gemini')).toBe(false);
        });

        it('should return false for neural2 tier', () => {
            expect(supportsSSML('en-US-Neural2-A', 'neural2')).toBe(false);
        });

        it('should return false for no voice or tier', () => {
            expect(supportsSSML(null, null)).toBe(false);
        });
    });

    describe('getFallbackText', () => {
        it('should add punctuation for natural pauses', () => {
            const input = 'Hello. How are you, friend?';
            const result = getFallbackText(input, 'medium');

            expect(result).toContain('…'); // Ellipsis for period
        });

        it('should use heavier punctuation for heavy intensity', () => {
            const input = 'Hello. How are you, friend?';
            const result = getFallbackText(input, 'heavy');

            expect(result).toContain('…');
            expect(result).toContain('—');
        });

        it('should preserve original for light intensity', () => {
            const input = 'Hello. How are you?';
            const result = getFallbackText(input, 'light');

            // Light intensity keeps original punctuation
            expect(result).toBe(input);
        });
    });

    describe('generateTtsInput', () => {
        it('should generate SSML for Chirp 3 HD voices', () => {
            const result = generateTtsInput('Hello world', {
                voiceName: 'en-US-Chirp3-HD-Kore',
                tier: 'chirp3_hd',
                languageCode: 'en-US',
                deliveryStyle: 'standard_preaching'
            });

            expect(result.inputType).toBe('ssml');
            expect(result.content).toContain('<speak>');
            expect(result.prompt).toBeDefined();
        });

        it('should generate fallback text for non-SSML voices', () => {
            const result = generateTtsInput('Hello world', {
                voiceName: 'en-US-Neural2-A',
                tier: 'neural2',
                languageCode: 'en-US'
            });

            expect(result.inputType).toBe('text');
            expect(result.content).not.toContain('<speak>');
            expect(result.prompt).toBeNull();
        });

        it('should disable pauses for unsupported languages', () => {
            const result = generateTtsInput('Hello world', {
                voiceName: 'he-IL-Chirp3-HD-Kore',
                tier: 'chirp3_hd',
                languageCode: 'he-IL', // Hebrew doesn't support pause control
                deliveryStyle: 'standard_preaching'
            });

            expect(result.inputType).toBe('ssml');
            // Should still generate SSML but without pause tags
            expect(result.content).toContain('<speak>');
        });
    });

    describe('DeliveryStyles', () => {
        it('should have all required styles', () => {
            expect(DeliveryStyles.STANDARD_PREACHING).toBeDefined();
            expect(DeliveryStyles.PENTECOSTAL).toBeDefined();
            expect(DeliveryStyles.TEACHING).toBeDefined();
            expect(DeliveryStyles.ALTAR_CALL).toBeDefined();
        });

        it('should have consistent structure', () => {
            Object.values(DeliveryStyles).forEach(style => {
                expect(style.name).toBeDefined();
                expect(style.label).toBeDefined();
                expect(style.description).toBeDefined();
                expect(style.prompt).toBeDefined();
                expect(style.prosody).toBeDefined();
                expect(style.prosody.rate).toBeDefined();
                expect(style.prosody.pitch).toBeDefined();
                expect(style.pauseIntensity).toBeDefined();
            });
        });
    });

    describe('POWER_WORDS', () => {
        it('should have all categories', () => {
            expect(POWER_WORDS.spiritual).toBeDefined();
            expect(POWER_WORDS.action).toBeDefined();
            expect(POWER_WORDS.time).toBeDefined();
            expect(POWER_WORDS.affirmation).toBeDefined();
            expect(POWER_WORDS.emphasis).toBeDefined();
        });

        it('should contain expected words', () => {
            const allWords = [
                ...POWER_WORDS.spiritual,
                ...POWER_WORDS.action,
                ...POWER_WORDS.time,
                ...POWER_WORDS.affirmation,
                ...POWER_WORDS.emphasis
            ];

            expect(allWords).toContain('Jesus');
            expect(allWords).toContain('faith');
            expect(allWords).toContain('grace');
            expect(allWords).toContain('today');
            expect(allWords).toContain('amen');
        });
    });
});
